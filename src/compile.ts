// The compiler pipeline:
//
//   source ─ parse ─ lower ─► IR ─ bind ─► bindings ─┬─ check (script, template, styles) + typecheck ─► diagnostics
//                                                    └─ emit (only without errors) ─► ES module
//
// The compiled module keeps the script's imports at the top and
// default-exports `program($$rt)` (see schema/program.ts).
//
// A .pat.ts / .pat.js module goes through the same front end as the script
// of a component without a template (`compileModule`). It stays an ordinary
// ES module; its `const x = $state({...})` declarations become module state
// (runtime/module-state.ts), named by the module's file relative to the app
// root (schema/path.ts).

import { existsSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { forEachNode, rootOf, unwrap, type Estree } from './ast';
import { bind, isSignal, type Bindings } from './bind';
import { checkNames } from './check/names';
import { checkScript, MUTATORS } from './check/script';
import { checkAnchorReferences, checkStyles } from './check/styles';
import { checkAttributes, checkEvents, checkTemplate, checkTemplateNames } from './check/template';
import { CompileError, Reporter, type Diagnostic } from './diagnostics';
import { Edits } from './emit/edits';
import { emitScript } from './emit/script';
import { TemplateEmitter } from './emit/template';
import { elements, fragments, type Component, type Element, type StateInfo, type TemplateNode } from './ir';
import { lower, lowerModule } from './lower';
import { parse } from './parse';
import { location, moduleStateId } from './schema/path';
import { collectStyles, type Styles } from './styles';
import { domNames, globalNames, typecheck, type TemplateWrite } from './typecheck';

export type Compiled = {
	/** Absolute path of the .pat file; the script's relative imports resolve from it. */
	path: string;
	/** ES module source: the script's imports, then `export default function program($$rt) { ... }`. */
	module: string;
	/** Specifiers the module still imports after type-only imports are removed. */
	imports: string[];
	state: StateInfo[];
	/** Where the template renders imported components (see `componentSites`). */
	components: ComponentSite[];
	/** The .pat source and the script's offsets in it, for checking design-time state values. */
	script: { lang: 'ts' | 'js'; source: string; start: number; end: number } | null;
};

/**
 * `<Tag>` at `id` (`line:column`) renders the component imported from
 * `path`. `repeated`: inside an `{#each}` of this file, so its instances'
 * paths carry each keys.
 */
export type ComponentSite = { tag: string; id: string; path: string; repeated: boolean };

export type Analysis = { diagnostics: Diagnostic[] };

type Front = { component: Component; bindings: Bindings; styles: Styles };

/** parse → lower → bind → style analysis. Null when the source does not parse. */
export function front(source: string, reporter: Reporter): Front | null {
	const ast = parse(source, reporter);
	if (!ast) return null;
	const component = lower(ast, source, reporter);
	const bindings = bind(component);
	return { component, bindings, styles: collectStyles(component, bindings) };
}

/** The DOM type of an element: TypeScript's own maps of tag names. */
const elementType = (element: Element) =>
	element.kind === 'svg' || element.kind === 'graphic' ? `SVGElementTagNameMap[${JSON.stringify(element.tag)}]` : `HTMLElementTagNameMap[${JSON.stringify(element.tag)}]`;

/** What each `bind:this` assigns to its variable: the element while mounted, else `undefined`. */
function boundElements(component: Component, bindings: Bindings): TemplateWrite[] {
	const writes: TemplateWrite[] = [];
	for (const element of elements(component.template)) {
		if (element.type !== 'element') continue;
		for (const a of element.attributes)
			if (a.type === 'bind' && a.name === 'this' && bindings.reference(a.expression)?.symbol)
				writes.push({ name: a.expression.name, type: `${elementType(element)} | undefined`, ...a.span });
	}
	return writes;
}

/** The .pat files the script imports: local name → absolute path. */
function componentImports(component: Component, filename: string): Map<string, { path: string; statement: any }> {
	const out = new Map<string, { path: string; statement: any }>();
	for (const statement of component.script?.imports ?? []) {
		const from: string = statement.source.value;
		const local = statement.specifiers[0]?.local?.name;
		if (/\.pat($|\?)/.test(from) && local) out.set(local, { path: resolve(dirname(resolve(filename)), from.split('?')[0]), statement });
	}
	return out;
}

function componentSites(component: Component, bindings: Bindings, filename: string, position: (offset: number) => string): ComponentSite[] {
	const imports = componentImports(component, filename);
	const sites: ComponentSite[] = [];
	const walk = (nodes: TemplateNode[], repeated: boolean) => {
		for (const node of nodes) {
			const symbol = node.type === 'component' ? bindings.reference(node.name)?.symbol : null;
			const imported = node.type === 'component' && symbol && symbol === bindings.topLevel(node.name.name) ? imports.get(node.name.name) : undefined;
			if (node.type === 'component' && imported) sites.push({ tag: node.name.name, id: position(node.span.start), path: imported.path, repeated });
			for (const fragment of fragments(node)) walk(fragment, repeated || node.type === 'each');
		}
	};
	walk(component.template, false);
	return sites;
}

function check(source: string, filename: string, reporter: Reporter): Front | null {
	const result = front(source, reporter);
	if (!result) return null;
	const { component, bindings, styles } = result;
	for (const { path, statement } of componentImports(component, filename).values())
		if (!existsSync(path)) reporter.report(statement.source, `cannot find component ${statement.source.value}`);
	checkScript(component, bindings, reporter);
	checkTemplate(component, bindings, reporter);
	checkTemplateNames(component, bindings, globalNames(resolve(filename)), reporter);
	const dom = domNames(resolve(filename));
	checkEvents(component, dom, reporter);
	checkAttributes(component, dom, reporter);
	checkNames(component.template, reporter);
	checkAnchorReferences(styles, bindings, reporter);
	checkStyles(styles, reporter);
	reporter.diagnostics.sort((a, b) => a.start - b.start);

	// TypeScript diagnostics for the script. A PAT error already covering the
	// same spot wins (e.g. an `import "./App.pat"` is not also "Cannot find module").
	const script = component.script;
	if (script?.lang === 'ts') {
		const pat = reporter.diagnostics.filter((d) => d.severity === 'error');
		const writes = boundElements(component, bindings);
		for (const { write, ...d } of typecheck(source, resolve(filename), script.span.start, script.span.end, writes)) {
			if (pat.some((p) => p.start <= d.start && d.start < p.end)) continue;
			const message = write === undefined ? d.message : `bind:this sets "${writes[write].name}" to ${writes[write].type}: ${d.message}`;
			reporter.diagnostics.push({ ...d, message, source: 'typescript', ...reporter.position(d.start) });
		}
	}
	return result;
}

/** Validation only: every diagnostic, no code generation. */
export function analyze(source: string, options: { filename?: string } = {}): Analysis {
	const reporter = new Reporter(source);
	check(source, options.filename ?? 'app.pat', reporter);
	return { diagnostics: reporter.diagnostics };
}

/**
 * Validation, type checking and code generation. `filename` is the .pat path
 * (relative to the working directory or absolute). Throws a CompileError
 * listing every diagnostic.
 */
export function compile(source: string, filename = 'app.pat'): Compiled {
	const reporter = new Reporter(source);
	const result = check(source, filename, reporter);
	if (!result || reporter.hasErrors()) throw new CompileError(reporter.diagnostics, source, filename);
	const { component, bindings } = result;

	const edits = new Edits(source);
	const script = emitScript(component, bindings, source, edits);
	const position = (offset: number) => {
		const { line, column } = reporter.position(offset);
		return location(line, column);
	};
	const template = new TemplateEmitter(
		edits,
		position,
		(node) => (isSignal(bindings.reference(node)?.symbol) ? `${node.name}.v` : node.name)
	).fragment(component.template);
	const ts = `${script.imports.join('\n')}\nexport default function program($$rt) {\n${script.code}\nreturn ${template};\n}\n`;
	const module = new Bun.Transpiler({ loader: 'ts', target: 'browser' }).transformSync(ts);
	const imports = new Bun.Transpiler({ loader: 'js' }).scanImports(module).map((i) => i.path);
	const info = component.script;
	return {
		path: resolve(filename),
		module,
		imports,
		state: info?.state.map((d) => d.info) ?? [],
		components: componentSites(component, bindings, filename, position),
		script: info ? { lang: info.lang, source, start: info.span.start, end: info.span.end } : null
	};
}

export type CompiledModule = {
	/** Absolute path of the .pat.ts / .pat.js file. */
	path: string;
	/** The module as JavaScript. */
	module: string;
	imports: string[];
	/** Its module state: the variable, its id, and its properties. */
	states: { name: string; id: string; keys: string[] }[];
	/** The source, for checking design-time values against its types. */
	source: string;
	lang: 'ts' | 'js';
};

const MODULE_STATE = resolve(import.meta.dir, 'runtime/module-state.ts');

/** A module through the front end and every check: its diagnostics, and what code generation needs. */
function checkModule(source: string, filename: string, typescript: boolean) {
	const path = resolve(filename);
	const lang: 'ts' | 'js' = path.endsWith('.ts') ? 'ts' : 'js';
	// The source is parsed as the script of a component.
	const open = `<script lang="${lang}">`;
	const wrapped = `${open}${source}</script>`;
	const reporter = new Reporter(wrapped);
	const at = (offset: number) => ({ start: open.length + offset, end: open.length + offset + 1 });
	const closing = source.search(/<\/script/i);
	const component = path.slice(0, -3);
	if (closing >= 0) reporter.report(at(closing), 'a module cannot contain "</script"; write it as "<\\/script"');
	else if (existsSync(component)) reporter.report(at(0), `${component.split(sep).pop()} is a component next to this module; rename one (TypeScript would resolve the component's import to this file)`);
	const ast = closing >= 0 ? null : parse(wrapped, reporter);
	const lowered = ast && lowerModule(ast, reporter);
	const bindings = lowered && bind(lowered.component);
	if (lowered && bindings) {
		checkScript(lowered.component, bindings, reporter, { module: true });
		checkModuleState(lowered.states, lowered.component.script!.body, bindings, reporter);
	}

	// PAT diagnostics in the module's own offsets, then TypeScript's.
	const own = new Reporter(source);
	const diagnostics: Diagnostic[] = reporter.diagnostics.map((d) => {
		const start = d.start - open.length;
		return { ...d, start, end: d.end - open.length, ...own.position(start) };
	});
	if (typescript && lang === 'ts' && lowered) {
		const pat = diagnostics.filter((d) => d.severity === 'error');
		for (const d of typecheck(source, path, 0, source.length))
			if (!pat.some((p) => p.start <= d.start && d.start < p.end)) diagnostics.push({ ...d, source: 'typescript', ...own.position(d.start) });
	}
	diagnostics.sort((a, b) => a.start - b.start);
	return { path, lang, open, wrapped, lowered, diagnostics };
}

/**
 * Validation only, for a .pat.ts / .pat.js module. Without `typescript`,
 * only Patch's own diagnostics: an editor whose TypeScript already checks the
 * module (with the Patch plugin) needs no second copy of its type errors.
 */
export function analyzeModule(source: string, { filename = 'module.pat.ts', typescript = true }: { filename?: string; typescript?: boolean } = {}): Analysis {
	return { diagnostics: checkModule(source, filename, typescript).diagnostics };
}

/**
 * Validation, type checking and code generation for a .pat.ts / .pat.js
 * module. `root` is the app's root directory, which module state ids are
 * relative to. Throws a CompileError listing every diagnostic.
 */
export function compileModule(source: string, filename: string, root = dirname(resolve(filename))): CompiledModule {
	const { path, lang, open, wrapped, lowered, diagnostics } = checkModule(source, filename, true);
	if (!lowered || diagnostics.some((d) => d.severity === 'error')) throw new CompileError(diagnostics, source, filename);

	const edits = new Edits(wrapped);
	// Real paths: a module may be loaded through a symlink (`/var` → `/private/var`).
	const real = (p: string) => (existsSync(p) ? realpathSync(p) : p);
	const file = relative(real(resolve(root)), real(path)).split(sep).join('/');
	const states = lowered.states.map(({ id, call, initial, keys }) => {
		const stateId = moduleStateId(file, id.name);
		edits.replace(call.callee.start, call.callee.end, '$$moduleState');
		edits.before(initial.start, `${JSON.stringify(stateId)}, ${JSON.stringify(keys)}, () => (`);
		edits.after(initial.end, ')');
		return { name: id.name, id: stateId, keys };
	});
	const header = states.length ? `import { moduleState as $$moduleState } from ${JSON.stringify(MODULE_STATE)};\n` : '';
	const module = new Bun.Transpiler({ loader: lang, target: 'browser' }).transformSync(header + edits.render(open.length, open.length + source.length));
	const imports = new Bun.Transpiler({ loader: 'js' }).scanImports(module).map((i) => i.path);
	return { path, module, imports, states, source, lang };
}

/**
 * Module state is replaced, never changed in place: the binding is not
 * reassigned, and only its own properties are assigned. (In a .pat.ts the
 * types say so too, through aliases; this catches the direct forms, also in JS.)
 */
function checkModuleState(states: { id: Estree }[], body: Estree[], bindings: Bindings, reporter: Reporter) {
	const symbols = new Set(states.map((s) => bindings.topLevel(s.id.name)));
	for (const ref of bindings.references)
		if (ref.access === 'write' && symbols.has(ref.symbol))
			reporter.report(ref.node, `"${ref.node.name}" is module state and is never reassigned; assign its properties: ${ref.node.name}.key = value`);
	const inPlace = (target: Estree) => {
		const object = unwrap(target.object);
		const root = rootOf(object);
		return object.type !== 'Identifier' && root?.type === 'Identifier' && symbols.has(bindings.reference(root)?.symbol ?? null) ? root.name : null;
	};
	for (const write of bindings.memberWrites) {
		const name = inPlace(write.target);
		if (name) reporter.report(write.node, `this changes module state "${name}" in place, which is not tracked; assign a new value to its property instead`);
	}
	for (const statement of body)
		forEachNode(statement, (node) => {
			const callee = node.type === 'CallExpression' ? unwrap(node.callee) : null;
			if (callee?.type !== 'MemberExpression' || callee.computed || !MUTATORS.has(callee.property.name)) return;
			const name = inPlace({ object: callee.object });
			if (name) reporter.report(callee.property, `.${callee.property.name}() changes module state "${name}" in place, which is not tracked; assign a new value to its property instead`);
		});
}
