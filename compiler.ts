// source → svelte/compiler parse → validate + type-check + rewrite → ES module
//
// The compiled module keeps the script's imports at the top and default-exports
// one function `program($$rt)` that runs the rest of the script (with `$state`
// / `$derived` / `$effect` rewritten onto `$$rt`) and returns a static
// description of the template whose dynamic parts are closures. The runtime
// either mounts that description into the DOM with fine-grained effects, or
// evaluates it once into a concrete tree.

import { basename, resolve } from 'node:path';
import { parse } from 'svelte/compiler';
import { createRuntime, type Concrete } from './runtime';
import { typecheck } from './typecheck';

export type { Concrete, Font, Run, Style } from './runtime';

export type StateInfo = {
	/** Stable id used for design-time overrides: the top-level variable name. */
	id: string;
	name: string;
	line: number;
	column: number;
	defaultSource: string;
	/** Present when the initializer is a literal. */
	defaultValue?: unknown;
};

export type Compiled = {
	filename: string;
	/** Absolute path of the .pat file; the script's relative imports resolve from it. */
	path: string;
	/** ES module source: the script's imports, then `export default function program($$rt) { ... }`. */
	module: string;
	/** Specifiers the module still imports after type-only imports are removed. */
	imports: string[];
	state: StateInfo[];
};

export type Diagnostic = {
	message: string;
	severity: 'error' | 'warning';
	source: 'pat' | 'typescript';
	/** TypeScript's diagnostic code. */
	code?: number;
	/** UTF-16 offsets into the source, end exclusive. */
	start: number;
	end: number;
	/** 1-based, for display. */
	line: number;
	column: number;
};

export type Analysis = { diagnostics: Diagnostic[]; state: StateInfo[] };

export class CompileError extends Error {
	constructor(readonly diagnostics: Diagnostic[], readonly source: string, readonly filename: string) {
		super(diagnostics.map((d) => formatDiagnostic(d, source, filename)).join('\n\n'));
	}
}

/** `file:line:col: message` plus the offending line with the range underlined. */
export function formatDiagnostic(d: Diagnostic, source: string, filename: string): string {
	const text = source.split('\n')[d.line - 1] ?? '';
	const width = Math.max(1, Math.min(d.end - d.start, text.length - d.column + 1));
	const code = d.code === undefined ? '' : ` TS${d.code}`;
	return `${filename}:${d.line}:${d.column}: ${d.severity}${code}: ${d.message}\n  ${text}\n  ${' '.repeat(d.column - 1)}${'^'.repeat(width)}`;
}

// Thrown by `error()` to abandon the current construct; caught by `recover()`.
class Abort {}

type Binding = 'state' | 'derived' | 'item' | 'local';
const SIGNALS = new Set<Binding | undefined>(['state', 'derived', 'item']);

class Scope {
	vars = new Map<string, Binding>();
	constructor(readonly parent?: Scope) {}
	get(name: string): Binding | undefined {
		for (let s: Scope | undefined = this; s; s = s.parent) {
			const binding = s.vars.get(name);
			if (binding) return binding;
		}
	}
}

// Source edits keyed by original offsets, rendered for any sub-range.
class Edits {
	private inserts = new Map<number, { end: string[]; start: string[] }>();
	private replaces = new Map<number, { end: number; text: string }>();
	constructor(private source: string) {}
	private slot(pos: number) {
		let slot = this.inserts.get(pos);
		if (!slot) this.inserts.set(pos, (slot = { end: [], start: [] }));
		return slot;
	}
	/** Text after a node ending at `pos`. Later calls land further out. */
	after(pos: number, text: string) {
		this.slot(pos).end.push(text);
	}
	/** Text before a node starting at `pos`. Later calls land further out. */
	before(pos: number, text: string) {
		this.slot(pos).start.unshift(text);
	}
	replace(start: number, end: number, text: string) {
		this.replaces.set(start, { end, text });
	}
	render(start: number, end: number) {
		let out = '';
		for (let i = start; ; ) {
			const slot = this.inserts.get(i);
			if (slot) out += slot.end.join('') + slot.start.join('');
			if (i >= end) return out;
			const replace = this.replaces.get(i);
			if (replace) {
				out += replace.text;
				i = replace.end;
			} else out += this.source[i++];
		}
	}
}

const TAGS: Record<string, 'frame' | 'text' | 'input' | 'textarea'> = {
	main: 'frame',
	div: 'frame',
	button: 'frame',
	p: 'text',
	span: 'text',
	input: 'input',
	textarea: 'textarea'
};
const ATTRIBUTES: Record<string, string[]> = {
	button: ['disabled'],
	input: ['value', 'placeholder', 'disabled', 'type'],
	textarea: ['value', 'placeholder', 'disabled']
};
const INPUT_TYPES = ['text', 'password', 'email', 'search', 'url', 'tel'];

// Straightforward attempts to bypass the template/style model.
const VISUAL_ESCAPES = new Set([
	'querySelector', 'querySelectorAll', 'getElementById', 'getElementsByClassName', 'getElementsByTagName',
	'getElementsByName', 'createElement', 'createElementNS', 'createTextNode', 'createDocumentFragment',
	'appendChild', 'insertBefore', 'removeChild', 'replaceChild', 'replaceChildren', 'replaceWith',
	'insertAdjacentHTML', 'insertAdjacentElement', 'insertAdjacentText', 'innerHTML', 'outerHTML', 'innerText',
	'textContent', 'setProperty', 'cssText', 'classList', 'className', 'attachShadow', 'getComputedStyle',
	'getBoundingClientRect', 'adoptedStyleSheets', 'styleSheets'
]);
const DOCUMENT_ESCAPES = new Set(['body', 'documentElement', 'head', 'write', 'writeln']);
const ARRAY_MUTATORS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin']);
const SKIP_KEYS = new Set(['type', 'start', 'end', 'loc', 'range', 'typeAnnotation', 'returnType', 'typeParameters', 'typeArguments', 'leadingComments', 'trailingComments', 'metadata']);
const NOT_STATIC = Symbol('not static');

const unwrap = (node: any): any =>
	node && /^TS(As|Satisfies|NonNull|TypeAssertion|Instantiation)Expression$|^TSNonNullExpression$/.test(node.type)
		? unwrap(node.expression)
		: node;

const rootOf = (node: any): any => {
	node = unwrap(node);
	while (node && (node.type === 'MemberExpression' || node.type === 'CallExpression' || node.type === 'ChainExpression'))
		node = unwrap(node.type === 'CallExpression' ? node.callee : node.type === 'ChainExpression' ? node.expression : node.object);
	return node;
};

const patternNames = (p: any, out: string[] = []): string[] => {
	if (!p) return out;
	if (p.type === 'Identifier') out.push(p.name);
	else if (p.type === 'ObjectPattern') p.properties.forEach((q: any) => patternNames(q.type === 'RestElement' ? q.argument : q.value, out));
	else if (p.type === 'ArrayPattern') p.elements.forEach((q: any) => patternNames(q, out));
	else if (p.type === 'AssignmentPattern') patternNames(p.left, out);
	else if (p.type === 'RestElement') patternNames(p.argument, out);
	return out;
};

const literal = (node: any): unknown => {
	node = unwrap(node);
	if (!node) return NOT_STATIC;
	if (node.type === 'Literal' && !node.regex) return node.value;
	if (node.type === 'UnaryExpression' && node.operator === '-' && node.argument.type === 'Literal' && typeof node.argument.value === 'number')
		return -node.argument.value;
	if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
	if (node.type === 'ArrayExpression') {
		const values = node.elements.map(literal);
		return values.includes(NOT_STATIC) ? NOT_STATIC : values;
	}
	if (node.type === 'ObjectExpression') {
		const out: Record<string, unknown> = {};
		for (const p of node.properties) {
			if (p.type !== 'Property' || p.computed || p.kind !== 'init') return NOT_STATIC;
			const value = literal(p.value);
			if (value === NOT_STATIC) return NOT_STATIC;
			out[p.key.name ?? p.key.value] = value;
		}
		return out;
	}
	return NOT_STATIC;
};

class Compiler {
	private edits: Edits;
	private lineStarts: number[] = [0];
	private runeCalls = new Map<any, 'state' | 'derived' | 'derived.by' | 'effect'>();
	private styleDecls = new Map<string, any>();
	private stateIds = new Map<any, string>();
	private imports: string[] = [];
	private styles = createRuntime({}, true);
	state: StateInfo[] = [];
	/** Every style object literal checked, with the element kind it was checked for. */
	styleObjects: { node: any; kind: string }[] = [];

	constructor(private source: string, private filename: string) {
		this.edits = new Edits(source);
		for (let i = 0; i < source.length; i++) if (source[i] === '\n') this.lineStarts.push(i + 1);
	}

	private position(offset: number) {
		let line = 0;
		while (line + 1 < this.lineStarts.length && this.lineStarts[line + 1] <= offset) line++;
		return { line: line + 1, column: offset - this.lineStarts[line] + 1 };
	}

	private id(node: any) {
		const { line, column } = this.position(node.start);
		return `${line}:${column}`;
	}

	diagnostics: Diagnostic[] = [];

	// The smallest useful range: an element/attribute name, else the node
	// clipped to its first line.
	private range(at: any): [number, number] {
		if (typeof at === 'number') return [at, at + 1];
		if (at?.name_loc) return [at.name_loc.start.character, at.name_loc.end.character];
		const start = at?.start ?? 0;
		const end = Math.max(start + 1, at?.end ?? start + 1);
		const lineEnd = this.source.indexOf('\n', start);
		return [start, lineEnd > start && lineEnd < end ? lineEnd : end];
	}

	/** Records a diagnostic and keeps going. */
	report(at: any, message: string, severity: Diagnostic['severity'] = 'error') {
		const [start, end] = this.range(at);
		// A $style const is checked where it is declared and again where it is used.
		if (this.diagnostics.some((d) => d.start === start && d.end === end && d.message === message)) return;
		this.diagnostics.push({ message, severity, source: 'pat', start, end, ...this.position(start) });
	}

	/** Records an error and abandons the current construct. */
	error(at: any, message: string): never {
		this.report(at, message);
		throw new Abort();
	}

	/** Runs one independent construct; an error in it does not stop its siblings. */
	private recover<T>(fn: () => T, fallback: T): T {
		try {
			return fn();
		} catch (error) {
			if (error instanceof Abort) return fallback;
			throw error;
		}
	}

	// ------------------------------------------------------------------ script

	/** Validates and generates code. `module` is only set when there are no errors. */
	run(emit: boolean, types = true): Analysis & { module?: string; imports?: string[] } {
		let ast: any;
		try {
			ast = parse(this.source, { modern: true });
		} catch (error: any) {
			const [start, end] = error.position ?? [error.start?.character ?? 0, (error.start?.character ?? 0) + 1];
			this.report({ start, end: Math.max(end, start + 1) }, error.message.split('\n')[0]);
			return { diagnostics: this.diagnostics, state: [] };
		}
		if (ast.css) this.report(ast.css, '<style> is not supported; use style={...} with $style({...}) values');
		if (ast.module) this.report(ast.module, '<script module> is not supported in v0');
		if (ast.options) this.report(ast.options, '<svelte:options> is not supported');

		const top = new Scope();
		const script = ast.instance ? this.script(ast.instance.content, top) : '';
		const nodes = this.children(ast.fragment.nodes, new Scope(top));
		const lang = ast.instance?.attributes.find((a: any) => a.name === 'lang')?.value?.[0]?.data;
		if (types && lang === 'ts') this.typecheck(ast.instance.content);
		const result = { diagnostics: this.diagnostics, state: this.state };
		if (!emit || this.diagnostics.some((d) => d.severity === 'error')) return result;
		const ts = `${this.imports.join('\n')}\nexport default function program($$rt) {\n${script}\nreturn [${nodes.join(',\n')}];\n}\n`;
		const module = new Bun.Transpiler({ loader: 'ts', target: 'browser' }).transformSync(ts);
		const imports = new Bun.Transpiler({ loader: 'js' }).scanImports(module).map((i) => i.path);
		return { ...result, module, imports };
	}

	// TypeScript diagnostics for the script. A PAT error already covering the
	// same spot wins (e.g. an `import "./App.pat"` is not also "Cannot find module").
	private typecheck(script: any) {
		const pat = this.diagnostics.filter((d) => d.severity === 'error');
		for (const d of typecheck(this.source, resolve(this.filename), script.start, script.end)) {
			if (pat.some((p) => p.start <= d.start && d.start < p.end)) continue;
			this.diagnostics.push({ ...d, source: 'typescript', ...this.position(d.start) });
		}
	}

	private script(program: any, top: Scope): string {
		const declared = program.body.filter((s: any) => this.recover(() => (this.declare(s, top), true), false));
		this.hoist(program.body, top);
		for (const statement of declared) {
			// Imports move to the top of the compiled module, outside `program`.
			if (statement.type === 'ImportDeclaration') {
				this.imports.push(this.source.slice(statement.start, statement.end));
				this.edits.replace(statement.start, statement.end, '');
			} else this.recover(() => this.walk(statement, top), undefined);
		}
		return this.edits.render(program.start, program.end);
	}

	// Top-level declarations: which names are state/derived, where runes may appear.
	private declare(statement: any, top: Scope) {
		if (statement.type === 'ImportDeclaration') {
			if (/\.pat($|\?)/.test(statement.source.value))
				this.error(statement.source, 'importing .pat files is not supported yet; a PAT app is a single .pat file (import .ts/.js modules instead)');
			// Vite only converts CommonJS for npm dependencies, not local files.
			if (/^\.{0,2}\/.*\.c[jt]s$/.test(statement.source.value))
				this.error(statement.source, 'local CommonJS modules are not supported; use an ES module (.ts, .js, .mjs). CommonJS npm packages are fine');
			return;
		}
		if (statement.type === 'TSImportEqualsDeclaration') this.error(statement, '`import x = require(...)` is not supported; use an ES import');
		if (/^(Export|TSExport)/.test(statement.type))
			this.error(statement, 'exports are not supported (a .pat file is a single app with no props)');
		if (statement.type === 'VariableDeclaration') {
			for (const d of statement.declarations) {
				const init = unwrap(d.init);
				const rune = init?.type === 'CallExpression' ? this.runeName(init.callee, top) : null;
				if (rune === '$state' || rune === '$derived' || rune === '$derived.by') {
					if (d.id.type !== 'Identifier') this.error(d.id, `${rune} must be assigned to a plain identifier`);
					if (rune === '$state' && statement.kind !== 'let') this.error(statement, '$state must be declared with let');
					top.vars.set(d.id.name, rune === '$state' ? 'state' : 'derived');
					this.runeCalls.set(init, rune.slice(1) as any);
					if (rune === '$state') {
						this.stateIds.set(init, d.id.name);
						const arg = init.arguments[0];
						const value = arg ? literal(arg) : undefined;
						this.state.push({
							id: d.id.name,
							name: d.id.name,
							...this.position(d.start),
							defaultSource: arg ? this.source.slice(arg.start, arg.end) : 'undefined',
							...(value === NOT_STATIC ? {} : { defaultValue: value })
						});
					}
				} else if (rune === '$style' && statement.kind === 'const' && d.id.type === 'Identifier' && unwrap(init.arguments[0])?.type === 'ObjectExpression') {
					this.styleDecls.set(d.id.name, unwrap(init.arguments[0]));
				}
			}
		}
		if (statement.type === 'ExpressionStatement') {
			const call = unwrap(statement.expression);
			if (call.type === 'CallExpression' && this.runeName(call.callee, top) === '$effect') this.runeCalls.set(call, 'effect');
		}
	}

	private runeName(callee: any, scope: Scope): string | null {
		if (callee.type === 'Identifier' && callee.name.startsWith('$') && !scope.get(callee.name)) return callee.name;
		if (callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && callee.object.name.startsWith('$') && !scope.get(callee.object.name))
			return `${callee.object.name}.${callee.property.name}`;
		return null;
	}

	private hoist(statements: any[], scope: Scope) {
		for (const s of statements) {
			const names =
				s.type === 'VariableDeclaration'
					? s.declarations.flatMap((d: any) => patternNames(d.id))
					: (s.type === 'FunctionDeclaration' || s.type === 'ClassDeclaration') && s.id
						? [s.id.name]
						: s.type === 'ImportDeclaration'
							? s.specifiers.map((sp: any) => sp.local.name)
							: [];
			for (const name of names) if (!scope.vars.has(name)) scope.vars.set(name, 'local');
		}
	}

	private walk(node: any, scope: Scope): void {
		if (!node || typeof node.type !== 'string') return;
		switch (node.type) {
			case 'Identifier':
				return this.reference(node, scope);
			case 'MemberExpression':
				this.checkMember(node);
				this.walk(node.object, scope);
				if (node.computed) this.walk(node.property, scope);
				return;
			case 'Property':
				if (node.computed) this.walk(node.key, scope);
				if (node.shorthand && node.value.type === 'Identifier' && SIGNALS.has(scope.get(node.value.name)))
					return this.edits.replace(node.value.start, node.value.end, `${node.value.name}: ${node.value.name}.v`);
				return this.walk(node.value, scope);
			case 'MethodDefinition':
			case 'PropertyDefinition':
				if (node.computed) this.walk(node.key, scope);
				return this.walk(node.value, scope);
			case 'FunctionDeclaration':
			case 'FunctionExpression':
			case 'ArrowFunctionExpression': {
				const inner = new Scope(scope);
				if (node.type === 'FunctionExpression' && node.id) inner.vars.set(node.id.name, 'local');
				for (const param of node.params) {
					for (const name of patternNames(param)) inner.vars.set(name, 'local');
					this.pattern(param, inner, false);
				}
				if (node.body.type === 'BlockStatement') {
					this.hoist(node.body.body, inner);
					for (const s of node.body.body) this.recover(() => this.walk(s, inner), undefined);
				} else this.walk(node.body, inner);
				return;
			}
			case 'BlockStatement':
			case 'StaticBlock': {
				const inner = new Scope(scope);
				this.hoist(node.body, inner);
				for (const s of node.body) this.recover(() => this.walk(s, inner), undefined);
				return;
			}
			case 'ForStatement':
			case 'ForInStatement':
			case 'ForOfStatement': {
				const inner = new Scope(scope);
				const head = node.init ?? node.left;
				if (head?.type === 'VariableDeclaration') this.hoist([head], inner);
				else if (head && node.type !== 'ForStatement') this.pattern(head, scope, true);
				for (const key of ['init', 'test', 'update', 'right', 'body']) this.walk(node[key], inner);
				if (head?.type === 'VariableDeclaration' && node.type !== 'ForStatement') this.walk(head, inner);
				return;
			}
			case 'CatchClause': {
				const inner = new Scope(scope);
				for (const name of patternNames(node.param)) inner.vars.set(name, 'local');
				this.pattern(node.param, inner, false);
				return this.walk(node.body, inner);
			}
			case 'VariableDeclaration':
				for (const d of node.declarations) {
					this.pattern(d.id, scope, false);
					this.walk(d.init, scope);
				}
				return;
			case 'LabeledStatement':
				return this.walk(node.body, scope);
			case 'BreakStatement':
			case 'ContinueStatement':
			case 'MetaProperty':
				return;
			case 'AssignmentExpression':
			case 'UpdateExpression':
				return this.assignment(node, scope);
			case 'CallExpression':
				return this.call(node, scope);
			case 'ImportExpression':
				this.error(node, 'dynamic import() is not supported in v0');
		}
		if (/^TS.*Expression$/.test(node.type)) return this.walk(node.expression, scope);
		if (node.type.startsWith('TS')) {
			if (node.type === 'TSEnumDeclaration' || node.type === 'TSModuleDeclaration') this.error(node, 'TypeScript enums/namespaces are not supported');
			return;
		}
		for (const key of Object.keys(node)) {
			if (SKIP_KEYS.has(key)) continue;
			const value = node[key];
			if (Array.isArray(value)) value.forEach((child) => this.walk(child, scope));
			else if (value && typeof value.type === 'string') this.walk(value, scope);
		}
	}

	private reference(node: any, scope: Scope) {
		const name = node.name;
		if (name.startsWith('$$')) this.error(node, 'identifiers starting with $$ are reserved');
		const binding = scope.get(name);
		if (SIGNALS.has(binding)) return this.edits.after(node.end, '.v');
		if (binding) return;
		if (name.startsWith('$')) this.error(node, `${name} is not supported here (runes: $state, $derived, $effect as top-level declarations/statements; $style anywhere)`);
		if (name === 'getComputedStyle') this.error(node, 'getComputedStyle is a visual escape hatch and is not allowed');
	}

	private checkMember(node: any) {
		if (node.computed || node.property.type !== 'Identifier') return;
		const name = node.property.name;
		if (VISUAL_ESCAPES.has(name))
			this.error(node.property, `.${name} bypasses the visual model; render through the template and style={...} instead`);
		if (node.object.type === 'Identifier' && node.object.name === 'document' && DOCUMENT_ESCAPES.has(name))
			this.error(node.property, `document.${name} bypasses the visual model`);
	}

	// Patterns in declarations, parameters, and destructuring assignments.
	private pattern(node: any, scope: Scope, assign: boolean): void {
		if (!node) return;
		switch (node.type) {
			case 'Identifier':
				if (assign) this.assignIdentifier(node, scope);
				return;
			case 'ObjectPattern':
				for (const p of node.properties) {
					if (p.type === 'RestElement') this.pattern(p.argument, scope, assign);
					else {
						if (p.computed) this.walk(p.key, scope);
						if (assign && p.shorthand && SIGNALS.has(scope.get(patternNames(p.value)[0])))
							this.error(p, 'destructuring assignment into a reactive variable is not supported; assign it directly');
						this.pattern(p.value, scope, assign);
					}
				}
				return;
			case 'ArrayPattern':
				node.elements.forEach((e: any) => this.pattern(e, scope, assign));
				return;
			case 'AssignmentPattern':
				this.pattern(node.left, scope, assign);
				return this.walk(node.right, scope);
			case 'RestElement':
				return this.pattern(node.argument, scope, assign);
			case 'MemberExpression': {
				const root = rootOf(node);
				if (root?.type === 'Identifier' && SIGNALS.has(scope.get(root.name)))
					this.error(node, 'destructuring into a member of a reactive variable is not supported');
				return this.walk(node, scope);
			}
			default:
				if (node.type.startsWith('TS')) return this.pattern(unwrap(node), scope, assign);
		}
	}

	private assignIdentifier(node: any, scope: Scope) {
		const binding = scope.get(node.name);
		if (binding === 'derived') this.error(node, `"${node.name}" is $derived and read-only`);
		if (binding === 'item') this.error(node, `"${node.name}" is an {#each} binding and read-only; reassign the source array instead`);
		this.reference(node, scope);
	}

	private assignment(node: any, scope: Scope) {
		const target = unwrap(node.type === 'AssignmentExpression' ? node.left : node.argument);
		if (target.type === 'MemberExpression') {
			const root = rootOf(target);
			const binding = root?.type === 'Identifier' ? scope.get(root.name) : undefined;
			if (binding === 'derived') this.error(node, `"${root.name}" is $derived and read-only`);
			if (binding === 'item') this.error(node, `"${root.name}" is an {#each} binding and cannot be mutated; reassign the source array instead`);
			const object = unwrap(target.object);
			if (object.type === 'MemberExpression' && !object.computed && object.property.name === 'style')
				this.error(node, 'assigning to .style bypasses the visual model');
			this.walk(target, scope);
			this.walk(node.right, scope);
			if (binding === 'state') {
				this.edits.before(node.start, `$$rt.mutate(${root.name}, `);
				this.edits.after(node.end, ')');
			}
			return;
		}
		this.pattern(target, scope, true);
		this.walk(node.right, scope);
	}

	private call(node: any, scope: Scope) {
		const callee = node.callee;
		const rune = this.runeName(callee, scope);
		if (rune) {
			const allowed = this.runeCalls.get(node);
			const args = node.arguments;
			if (rune === '$style') {
				if (args.length !== 1) this.error(node, '$style takes exactly one object');
				this.checkStyleExpression(args[0], null, scope);
				this.edits.replace(callee.start, callee.end, '$$rt.style');
			} else if (!allowed) {
				const where = rune === '$effect' ? 'a top-level statement' : 'a top-level `let x = ...` declaration';
				this.error(node, ['$state', '$derived', '$derived.by', '$effect'].includes(rune) ? `${rune}(...) is only allowed as ${where}` : `${rune} is not supported`);
			} else if (allowed === 'state') {
				const id = JSON.stringify(this.stateIds.get(node));
				this.edits.replace(callee.start, callee.end, '$$rt.state');
				if (args.length) this.edits.before(args[0].start, `${id}, `);
				else this.edits.before(node.end - 1, id);
			} else if (allowed === 'derived') {
				if (args.length !== 1) this.error(node, '$derived takes exactly one expression');
				this.edits.replace(callee.start, callee.end, '$$rt.derived');
			} else {
				if (args.length !== 1) this.error(node, `${rune} takes exactly one function`);
				this.edits.replace(callee.start, callee.end, allowed === 'effect' ? '$$rt.effect' : '$$rt.derived');
			}
			args.forEach((a: any) => this.walk(a, scope));
			if (allowed === 'derived') {
				this.edits.before(args[0].start, '() => (');
				this.edits.after(args[0].end, ')');
			}
			return;
		}
		if (callee.type === 'MemberExpression' && !callee.computed && ARRAY_MUTATORS.has(callee.property.name)) {
			const root = rootOf(callee.object);
			if (root?.type === 'Identifier' && SIGNALS.has(scope.get(root.name)))
				this.error(callee.property, `.${callee.property.name}() mutates reactive "${root.name}" in place, which is not tracked; assign a new array instead`);
		}
		this.walk(callee, scope);
		node.arguments.forEach((a: any) => this.walk(a, scope));
	}

	// Compile-time checks for style expressions whose shape is visible.
	private checkStyleExpression(expr: any, kind: string | null, scope: Scope): void {
		expr = unwrap(expr);
		if (!expr) return;
		switch (expr.type) {
			case 'ObjectExpression':
				this.styleObjects.push({ node: expr, kind: kind ?? 'frame' });
				for (const p of expr.properties) {
					if (p.type !== 'Property' || p.computed) continue;
					const key = p.key.name ?? String(p.key.value);
					try {
						this.styles.checkKey(kind ?? 'frame', key);
					} catch (error: any) {
						this.report(p.key, error.message);
						continue;
					}
					const value = literal(p.value);
					try {
						if (value !== NOT_STATIC) this.styles.normalizeStyle({ [key]: value });
					} catch (error: any) {
						this.report(p.value, error.message);
					}
				}
				return;
			case 'ArrayExpression':
				return expr.elements.forEach((e: any) => this.checkStyleExpression(e, kind, scope));
			case 'LogicalExpression':
				if (expr.operator !== '&&') this.checkStyleExpression(expr.left, kind, scope);
				return this.checkStyleExpression(expr.right, kind, scope);
			case 'ConditionalExpression':
				this.checkStyleExpression(expr.consequent, kind, scope);
				return this.checkStyleExpression(expr.alternate, kind, scope);
			case 'Literal':
			case 'TemplateLiteral':
				if (typeof expr.value === 'string' || expr.type === 'TemplateLiteral')
					this.error(expr, 'CSS strings are not supported; use an object or $style({...})');
				return;
			case 'Identifier':
				if (kind && scope.get(expr.name) === 'local' && this.styleDecls.has(expr.name))
					this.checkStyleExpression(this.styleDecls.get(expr.name), kind, scope);
				return;
			case 'CallExpression': {
				// An inline `$style({...})` is validated by `call()` without an element
				// kind; record which element it styles so completion can respect it.
				const arg = unwrap(expr.arguments[0]);
				if (kind && arg?.type === 'ObjectExpression' && this.runeName(expr.callee, scope) === '$style')
					this.styleObjects.push({ node: arg, kind });
			}
		}
	}

	private expression(node: any, scope: Scope) {
		this.walk(node, scope);
		return this.edits.render(node.start, node.end);
	}

	// ---------------------------------------------------------------- template

	private children(nodes: any[], scope: Scope): string[] {
		const out: string[] = [];
		let group: any[] = [];
		const flush = () => {
			const parts = this.recover(() => this.inline(group, scope), []);
			if (parts.length) out.push(`{t:"text",id:${JSON.stringify(this.id(group[0]))},parts:[${parts.join(',')}]}`);
			group = [];
		};
		for (const node of nodes) {
			if (node.type === 'Text' || node.type === 'ExpressionTag') {
				group.push(node);
				continue;
			}
			if (node.type === 'Comment') continue;
			flush();
			const code = this.recover(() => {
				if (node.type === 'RegularElement') return this.element(node, scope);
				if (node.type === 'IfBlock') return this.ifBlock(node, scope);
				if (node.type === 'EachBlock') return this.eachBlock(node, scope);
				return this.unsupportedNode(node);
			}, 'null');
			out.push(code);
		}
		flush();
		return out;
	}

	private unsupportedNode(node: any): never {
		const messages: Record<string, string> = {
			Component: 'user-defined components are not supported in v0',
			HtmlTag: '{@html} is not supported',
			AwaitBlock: '{#await} is not supported in v0; use $state + $effect for async data',
			KeyBlock: '{#key} is not supported',
			SnippetBlock: '{#snippet} is not supported',
			RenderTag: '{@render} is not supported',
			ConstTag: '{@const} is not supported',
			DebugTag: '{@debug} is not supported',
			AttachTag: '{@attach} is not supported'
		};
		this.error(node, messages[node.type] ?? `<${node.name ?? node.type}> is not supported`);
	}

	private ifBlock(node: any, scope: Scope): string {
		const branches: string[] = [];
		let current = node;
		let otherwise = 'null';
		while (current) {
			branches.push(`[() => (${this.expression(current.test, scope)}), [${this.children(current.consequent.nodes, scope).join(',')}]]`);
			const alternate = current.alternate?.nodes ?? [];
			const elseIf = alternate.find((n: any) => n.type === 'IfBlock' && n.elseif);
			if (elseIf) current = elseIf;
			else {
				if (current.alternate) otherwise = `[${this.children(alternate, scope).join(',')}]`;
				current = null;
			}
		}
		return `{t:"if",id:${JSON.stringify(this.id(node))},b:[${branches.join(',')}],e:${otherwise}}`;
	}

	private eachBlock(node: any, scope: Scope): string {
		if (!node.context || node.context.type !== 'Identifier') this.error(node, '{#each} needs `as item` with a plain identifier');
		if (!node.key) this.report(node, '{#each} must be keyed: {#each list as item (item.id)}');
		if (node.fallback) this.report(node.fallback.nodes[0] ?? node, '{:else} inside {#each} is not supported; use {#if list.length === 0}');
		const list = this.expression(node.expression, scope);
		const inner = new Scope(scope);
		inner.vars.set(node.context.name, 'item');
		const index = node.index ?? '$$i';
		if (node.index) inner.vars.set(node.index, 'item');
		const params = `(${node.context.name}, ${index})`;
		const key = node.key ? this.expression(node.key, inner) : 'null';
		const kids = this.children(node.body.nodes, inner);
		return `{t:"each",id:${JSON.stringify(this.id(node))},list:() => (${list}),key:${params} => (${key}),kids:${params} => [${kids.join(',')}]}`;
	}

	/** `inlineKids` is set for a <span> nested in text (already rendered). */
	private element(node: any, scope: Scope, inlineKids?: string): string {
		const inline = inlineKids !== undefined;
		const kind = inline ? 'inline' : TAGS[node.name];
		if (!kind) this.error(node, `<${node.name}> is not supported (use main, div, button, p, span, input, textarea)`);
		if (inline && node.name !== 'span') this.error(node, `<${node.name}> cannot appear inside text; only <span> can`);
		let style = 'null';
		const attrs: Record<string, string> = {};
		const on: Record<string, string> = {};
		const exprOf = (a: any) => {
			if (a.value === true || Array.isArray(a.value)) this.error(a, `${a.name} needs an expression: ${a.name}={...}`);
			return a.value.expression;
		};
		for (const a of node.attributes) this.recover(() => {
			if (a.type === 'BindDirective') {
				if (a.name !== 'value' || (kind !== 'input' && kind !== 'textarea')) this.error(a, 'only bind:value on <input>/<textarea> is supported');
				if (a.expression.type !== 'Identifier' || scope.get(a.expression.name) !== 'state') this.error(a, 'bind:value needs a top-level $state variable');
				if (attrs.value || on.input) this.error(a, 'bind:value cannot be combined with value= or oninput=');
				attrs.value = `() => (${a.expression.name}.v)`;
				on.input = `() => (event) => { ${a.expression.name}.v = event.currentTarget.value }`;
				return;
			}
			if (a.type !== 'Attribute') {
				const messages: Record<string, string> = {
					SpreadAttribute: 'spread attributes are not supported',
					ClassDirective: 'class: is not supported; use style={[base, active && selected]}',
					StyleDirective: 'style: directives are not supported; use style={{ ... }}',
					OnDirective: 'on:event is not supported; use onevent={...}',
					UseDirective: 'use: actions are not supported',
					TransitionDirective: 'transitions are not supported in v0',
					AnimateDirective: 'animations are not supported in v0',
					AttachTag: '{@attach} is not supported'
				};
				this.error(a, messages[a.type] ?? `${a.type} is not supported`);
			}
			const name = a.name;
			if (name === 'style') {
				if (Array.isArray(a.value) && a.value.some((part: any) => part.type === 'Text'))
					this.error(a, 'CSS strings are not supported; use style={$style({...})} or style={{ ... }}');
				const expr = exprOf(a);
				this.checkStyleExpression(expr, kind, scope);
				style = `() => (${this.expression(expr, scope)})`;
			} else if (name === 'class') this.error(a, 'class= is not supported; use style={...}');
			else if (/^on[a-z]+$/.test(name) && !inline) {
				if (on[name.slice(2)]) this.error(a, `${name} is already set`);
				on[name.slice(2)] = `() => (${this.expression(exprOf(a), scope)})`;
			} else if (!inline && ATTRIBUTES[node.name]?.includes(name)) {
				if (attrs[name]) this.error(a, `${name} is already set`);
				if (name === 'type') {
					const value = Array.isArray(a.value) && a.value.length === 1 && a.value[0].type === 'Text' ? a.value[0].data : null;
					if (!value || !INPUT_TYPES.includes(value)) this.error(a, `type must be one of ${INPUT_TYPES.join(', ')}`);
				}
				attrs[name] = `() => (${this.attributeValue(a, scope)})`;
			} else this.error(a, `attribute "${name}" is not supported on <${node.name}>${inline ? ' inside text' : ''}`);
		}, undefined);
		const id = JSON.stringify(this.id(node));
		const nodes = node.fragment.nodes;
		if (inline) return `{t:"span",id:${id},style:${style},kids:[${inlineKids}]}`;
		let kids = '';
		if (kind === 'frame') kids = this.children(nodes, scope).join(',');
		else if (kind === 'text') kids = this.inline(nodes, scope).join(',');
		else if (nodes.some((n: any) => n.type !== 'Text' || n.data.trim())) this.error(node, `<${node.name}> cannot have children; use value={...}`);
		const object = (record: Record<string, string>) => `{${Object.entries(record).map(([k, v]) => `${JSON.stringify(k)}: ${v}`).join(',')}}`;
		return `{t:"el",tag:${JSON.stringify(node.name)},kind:"${kind}",id:${id},style:${style},attrs:${object(attrs)},on:${object(on)},kids:[${kids}]}`;
	}

	private attributeValue(a: any, scope: Scope): string {
		if (a.value === true) return 'true';
		if (!Array.isArray(a.value)) return this.expression(a.value.expression, scope);
		return a.value
			.map((part: any) => (part.type === 'Text' ? JSON.stringify(part.data) : `String((${this.expression(part.expression, scope)}) ?? "")`))
			.join(' + ') || '""';
	}

	// Text content: static whitespace collapses to one space and is trimmed at
	// the edges; expression values are inserted verbatim.
	private inline(nodes: any[], scope: Scope): string[] {
		const tokens = this.inlineTokens(nodes, scope, { space: true });
		const trimEnd = (list: any[]) => {
			const last = list[list.length - 1];
			if (typeof last === 'string') {
				const trimmed = last.trimEnd();
				if (trimmed) list[list.length - 1] = trimmed;
				else list.pop();
			} else if (last?.kids) trimEnd(last.kids);
		};
		trimEnd(tokens);
		const render = (token: any): string =>
			typeof token === 'string'
				? JSON.stringify(token)
				: token.span
					? this.element(token.span, scope, token.kids.map(render).join(','))
					: `() => (${token.code})`;
		return tokens.map(render);
	}

	private inlineTokens(nodes: any[], scope: Scope, state: { space: boolean }): any[] {
		const out: any[] = [];
		for (const node of nodes) {
			if (node.type === 'Comment') continue;
			if (node.type === 'Text') {
				let text = node.data.replace(/\s+/g, ' ');
				if (state.space && text.startsWith(' ')) text = text.slice(1);
				if (!text) continue;
				out.push(text);
				state.space = text.endsWith(' ');
			} else if (node.type === 'ExpressionTag') {
				out.push({ code: this.expression(node.expression, scope) });
				state.space = false;
			} else if (node.type === 'RegularElement') {
				out.push({ span: node, kids: this.inlineTokens(node.fragment.nodes, scope, state) });
			} else if (node.type === 'IfBlock' || node.type === 'EachBlock') {
				this.report(node, 'blocks cannot appear inside text; use a ternary {cond ? "a" : "b"} or move the block into a <div>');
			} else this.recover(() => this.unsupportedNode(node), undefined);
		}
		return out;
	}
}

/** Validation only: every diagnostic, no code generation. */
export function analyze(source: string, options: { filename?: string } = {}): Analysis {
	return new Compiler(source, options.filename ?? 'app.pat').run(false);
}

export type Completion = {
	label: string;
	kind: 'property' | 'value';
	detail?: string;
	/** Text to insert when it differs from `label`. */
	insertText?: string;
};

const HOLE = '$$complete';
const STYLE_SCHEMA = createRuntime({}, true);

/**
 * Style completion at `offset`: property names inside a style object, or the
 * string literals a property accepts after `key:`. The incomplete construct
 * under the cursor is patched into valid syntax and the compiler re-runs, so
 * which objects are styles, and for which element kind, comes from the same
 * checks that produce diagnostics. Anywhere else this returns nothing.
 */
export function complete(source: string, offset: number, options: { filename?: string } = {}): Completion[] {
	const before = source.slice(0, offset);
	const after = source.slice(offset);
	const value = /[A-Za-z_$][\w$]*\s*:\s*(['"]?)[\w-]*$/.exec(before);
	const keyPrefix = /[\w$]*$/.exec(before)![0];
	if (!value && !/[{,]$/.test(before.slice(0, offset - keyPrefix.length).trimEnd())) return [];

	const quote = value?.[1] ?? '';
	const start = value ? offset - value[0].length + value[0].search(/['"\w-]*$/) : offset - keyPrefix.length;
	const end = offset + (value ? new RegExp(quote ? `^[\\w-]*${quote}?` : '^[\\w$-]*') : /^[\w$]*/).exec(after)![0].length;
	const rest = source.slice(end);
	const comma = /^\s*[,}]/.test(rest) ? '' : ',';
	const hole = value ? `0${comma}` : /^\s*:/.test(rest) ? HOLE : `${HOLE}: 0${comma}`;

	const compiler = new Compiler(source.slice(0, start) + hole + rest, options.filename ?? 'app.pat');
	compiler.run(false, false);
	const kinds = new Set<string>();
	let object: any;
	let property: any;
	for (const record of compiler.styleObjects) {
		const p = record.node.properties.find((p: any) => p.type === 'Property' && !p.computed && (value ? p.value : p.key).start === start);
		if (!p) continue;
		[object, property] = [record.node, p];
		kinds.add(record.kind);
	}
	if (!property) return [];

	// A `$style` const is checked where it is declared and again for every
	// element using it; only what is legal everywhere is offered.
	const [first, ...others] = [...kinds].map((kind) => STYLE_SCHEMA.styleProperties(kind));
	const legal = first.filter((p) => others.every((list) => list.some((q) => q.name === p.name)));
	const keyName = (p: any) => p.key.name ?? String(p.key.value);

	if (value) {
		const name = keyName(property);
		return (legal.find((p) => p.name === name)?.values ?? []).map((v) => ({
			label: v,
			kind: 'value',
			detail: name,
			...(quote ? {} : { insertText: `'${v}'` })
		}));
	}
	const present = new Set(object.properties.filter((p: any) => p !== property && p.type === 'Property' && !p.computed).map(keyName));
	return legal.filter((p) => !present.has(p.name)).map((p) => ({ label: p.name, kind: 'property', detail: p.hint }));
}

/**
 * Validation, type checking and code generation. `filename` is the .pat path
 * (relative to the working directory or absolute). Throws a CompileError
 * listing every diagnostic.
 */
export function compile(source: string, filename = 'app.pat'): Compiled {
	const result = new Compiler(source, filename).run(true);
	if (!result.module) throw new CompileError(result.diagnostics, source, filename);
	return { filename: basename(filename), path: resolve(filename), module: result.module, imports: result.imports!, state: result.state };
}

/** The host document: fonts, the #app element, and the given script tag. */
export function htmlPage(title: string, script: string): string {
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title.replace(/</g, '&lt;')}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,100..900;1,14..32,100..900&display=swap">
</head>
<body>
<div id="app"></div>
${script}
</body>
</html>
`;
}

/**
 * Design-time evaluation: initialize state, apply overrides, evaluate derived
 * values and the template once. `$effect`s never run here. A program with
 * imports is loaded as a module so its imports resolve from the .pat file.
 */
export async function evaluate(compiled: Compiled, options: { state?: Record<string, unknown> } = {}): Promise<Concrete[]> {
	const overrides = options.state ?? {};
	const known = compiled.state.map((s) => s.id);
	for (const id of Object.keys(overrides))
		if (!known.includes(id)) throw new Error(`Unknown state "${id}". Available: ${known.join(', ') || '(none)'}`);
	const program = compiled.imports.length
		? await importProgram(compiled)
		: new Function(`return (${compiled.module.replace(/^export default /m, '')})`)();
	return createRuntime(overrides, true).realize(program);
}

// Compiled modules served to Bun's loader by path.
const loaded = new Map<string, string>();
async function importProgram(compiled: Compiled) {
	if (!loaded.size)
		Bun.plugin({
			name: 'pat',
			setup(build) {
				build.onLoad({ filter: /\.pat$/ }, ({ path }) => ({ contents: loaded.get(path) ?? '', loader: 'js' }));
			}
		});
	loaded.set(compiled.path, compiled.module);
	return (await import(compiled.path)).default;
}
