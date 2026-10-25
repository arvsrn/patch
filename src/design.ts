// Design-time evaluation: a compiled app at one static state.
//
// `--state name=value` overrides replace the initial value of a `$state`. A
// value is read as JSON, falling back to the plain string. In a
// `<script lang="ts">` both readings are checked against the variable's
// declared type and the first that fits wins, so `filter=done` is the string
// "done" and `count=3` stays a number. `$effect`s never run. A module with
// imports is loaded through Bun so they resolve from the .pat file.
//
// State of the app itself is named by its variable. State of a component
// instance is named by the instance's path and the variable (see
// schema/path.ts): `Row@12:3["a"]/expanded` is `expanded` in the `<Row>`
// written at 12:3, in the item of the `{#each}` around it keyed "a". The
// declaring component is found from the last `Tag@line:column` of the path,
// so its type can be checked without running the app.
//
// In an app with pages, the root is the page the URL selects (see
// `pageAt` in routes.ts), evaluated at that location: its `page` reads it,
// and its state is named like the state of a single-file app.
//
// State of a .pat.ts module is named by the module's file relative to the
// app root and the variable: `src/workspace.pat.ts#workspace`, checked against
// that module. Every evaluation loads its own copy of the app's modules, so
// module state starts fresh, from its initializer or its override, and one
// evaluation never sees another's (see `importProgram`). Evaluations run one
// at a time.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { compile, compileModule, type Compiled } from './compile';
import { appRootOf } from './routes';
import * as patchModule from './runtime/context';
import { setModuleOverrides } from './runtime/module-state';
import { realize } from './runtime/realize';
import type { Concrete } from './schema/concrete';
import { isPatModule, outsideKeys, parseModuleStateId, parseStateId, sitePattern, stateId } from './schema/path';
import type { Program } from './schema/program';
import type { Location } from './schema/route';
import { checkValues } from './typecheck';

export type StateOverrides = Record<string, unknown>;

/** The app's .pat files by path: the entry and every component it renders, directly or not. */
function appFiles(root: Compiled): Map<string, Compiled> {
	const files = new Map([[root.path, root]]);
	for (const file of files.values())
		for (const site of file.components)
			if (!files.has(site.path)) files.set(site.path, compile(readFileSync(site.path, 'utf8'), site.path));
	return files;
}

/** A file whose declarations an override is checked against. */
type Declaring = Pick<Compiled, 'path' | 'script'>;

const modules = new Map<string, Declaring & { states: string[] }>();

/** The module state `id` names, in the app at `appRoot`; null if it names none. Throws when the module does not compile. */
function resolveModuleState(appRoot: string, id: string): { file: Declaring; name: string } | null {
	const parsed = parseModuleStateId(id);
	if (!parsed) return null;
	const path = resolve(appRoot, parsed.file);
	if (!existsSync(path)) return null;
	const source = readFileSync(path, 'utf8');
	let file = modules.get(path);
	if (file?.script?.source !== source) {
		const compiled = compileModule(source, path, appRoot);
		file = { path, script: { lang: compiled.lang, source, start: 0, end: source.length }, states: compiled.states.map((s) => s.name) };
		modules.set(path, file);
	}
	return file.states.includes(parsed.name) ? { file, name: parsed.name } : null;
}

/** The file declaring the state `id` names, and its variable; null if no component in the app declares it there. */
function resolveState(files: Map<string, Compiled>, root: Compiled, id: string, appRoot: string): { file: Declaring; name: string } | null {
	if (parseModuleStateId(id)) return resolveModuleState(appRoot, id);
	const parsed = parseStateId(id);
	if (!parsed) return null;
	const { steps, name } = parsed;
	if (!steps.length) return root.state.some((s) => s.id === name) ? { file: root, name } : null;
	const { tag, at } = steps[steps.length - 1];
	if (!tag) return null;
	for (const file of files.values())
		for (const site of file.components) {
			const target = files.get(site.path)!;
			if (site.tag === tag && site.id === at && target.state.some((s) => s.id === name)) return { file: target, name };
		}
	return null;
}

/** Every state that can be overridden: the app's names, and per component site the pattern of its instances' ids. */
function available(files: Map<string, Compiled>, root: Compiled): string[] {
	const out = root.state.map((s) => s.id);
	for (const file of files.values())
		for (const site of file.components)
			for (const s of files.get(site.path)!.state) out.push(`${file === root ? '' : '…/'}${stateId(sitePattern(site.tag, site.id, site.repeated), s.id)}`);
	return out;
}

function unknown(id: string, files: Map<string, Compiled>, root: Compiled) {
	const module = parseModuleStateId(id);
	if (module) return new Error(`Unknown state "${id}": no module state "${module.name}" is declared in ${module.file} (as const ${module.name} = $state({ … }))`);
	return new Error(`Unknown state "${id}". Available: ${available(files, root).join(', ') || '(none)'}, and module state as <file>#<name>`);
}

/** Where a `--state` pair splits: after a module state id's file (opaque), else at the first `=` outside each keys. */
function splitAt(pair: string) {
	const hash = pair.indexOf('#');
	const first = pair.indexOf('=');
	if (hash >= 0 && first > hash) return first;
	if (hash >= 0 && first >= 0 && isPatModule(pair.slice(0, hash))) return pair.indexOf('=', hash);
	return outsideKeys(pair, '=').at[0] ?? -1;
}

/**
 * Parses `name=value` pairs against the app's `$state` declarations, and the
 * module state of the app at `appRoot`. Throws on unknown names and ill-typed values.
 */
export function parseStateOverrides(compiled: Compiled, pairs: string[], appRoot = appRootOf(compiled.path)): StateOverrides {
	const files = appFiles(compiled);
	const parsed = pairs.map((pair) => {
		const eq = splitAt(pair);
		if (eq <= 0) throw new Error(`--state expects name=value, got "${pair}"`);
		const id = pair.slice(0, eq);
		const raw = pair.slice(eq + 1);
		const declared = resolveState(files, compiled, id, appRoot);
		if (!declared) throw unknown(id, files, compiled);
		const candidates: unknown[] = [];
		try {
			candidates.push(JSON.parse(raw));
		} catch {}
		if (typeof candidates[0] !== 'string') candidates.push(raw);
		return { id, raw, candidates, ...declared };
	});

	const out: StateOverrides = {};
	for (const file of new Set(parsed.map((p) => p.file))) {
		const own = parsed.filter((p) => p.file === file);
		const script = file.script;
		if (script?.lang !== 'ts') {
			for (const p of own) out[p.id] = p.candidates[0];
			continue;
		}
		const checks = own.flatMap((p) => p.candidates.map((value) => ({ name: p.name, expression: JSON.stringify(value) })));
		const errors = checkValues(script.source, file.path, script.start, script.end, checks);
		let i = 0;
		for (const p of own) {
			const results = p.candidates.map(() => errors[i++]);
			const fits = results.findIndex((error) => error === null);
			if (fits < 0) throw new Error(`Invalid --state ${p.id}=${p.raw}: ${results[0]}`);
			out[p.id] = p.candidates[fits];
		}
	}
	// In the order given.
	return Object.fromEntries(parsed.map((p) => [p.id, out[p.id]]));
}

export type EvaluateOptions = {
	/** A page is evaluated at this location (see `pageAt`). */
	location?: Location;
	/** The app's root directory, which module state ids are relative to; by default found from the entry (`appRootOf`). */
	root?: string;
};

let queue: Promise<unknown> = Promise.resolve();

/** Evaluates the app (or a page at `location`) once at its initial state with `overrides` applied. */
export function evaluate(compiled: Compiled, overrides: StateOverrides = {}, options: EvaluateOptions = {}): Promise<Concrete[]> {
	const run = queue.then(() => evaluateNow(compiled, overrides, options));
	queue = run.catch(() => {});
	return run;
}

async function evaluateNow(compiled: Compiled, overrides: StateOverrides, { location, root = appRootOf(compiled.path) }: EvaluateOptions) {
	const ids = Object.keys(overrides);
	if (ids.length) {
		const files = appFiles(compiled);
		for (const id of ids) if (!resolveState(files, compiled, id, root)) throw unknown(id, files, compiled);
	}
	const moduleValues = Object.fromEntries(Object.entries(overrides).filter(([id]) => parseModuleStateId(id)));
	const program: Program = compiled.imports.length
		? await importProgram(compiled, root, moduleValues)
		: new Function(`return (${compiled.module.replace(/^export default /m, '')})`)();
	return realize(program, overrides, location);
}

// Each evaluation imports the app as a module graph of its own: its files
// are loaded under `/__patch_eval_<n>__/<path>`, so a relative import from
// one of them resolves to another file of the same graph. Packages and
// Patch's runtime stay shared (one reactive core). .pat files and .pat.ts
// modules are compiled as they load, the entry as already compiled.

const GRAPH = /^\/__patch_eval_\d+__/;
const RUNTIME = resolve(import.meta.dir);
let graphs = 0;
let current: { root: string; entry: Compiled } | null = null;
const cache = new Map<string, { source: string; root: string; module: string }>();

/** Whether `path` is the app's own (loaded in each graph) rather than a package's or Patch's. */
const ownFile = (path: string) => path.startsWith(sep) && !path.includes(`${sep}node_modules${sep}`) && !path.startsWith(RUNTIME + sep);

const IMAGES = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.ico'];
const LOADERS: Record<string, 'ts' | 'tsx' | 'js' | 'jsx' | 'json'> = { '.ts': 'ts', '.mts': 'ts', '.tsx': 'tsx', '.js': 'js', '.mjs': 'js', '.jsx': 'jsx', '.json': 'json' };

function load(path: string): { contents: string; loader: 'ts' | 'tsx' | 'js' | 'jsx' | 'json' } {
	const { root, entry } = current!;
	if (path === entry.path) return { contents: entry.module, loader: 'js' };
	// An image is its path (it is not drawn at design time).
	if (IMAGES.includes(extname(path).toLowerCase())) return { contents: `export default ${JSON.stringify(path)};`, loader: 'js' };
	const source = readFileSync(path, 'utf8');
	const patch = path.endsWith('.pat') || isPatModule(path);
	if (!patch) {
		const loader = LOADERS[extname(path)];
		if (!loader) throw new Error(`Cannot import ${path} at design time`);
		return { contents: source, loader };
	}
	let hit = cache.get(path);
	if (hit?.source !== source || hit.root !== root) {
		const module = path.endsWith('.pat') ? compile(source, path).module : compileModule(source, path, root).module;
		cache.set(path, (hit = { source, root, module }));
	}
	return { contents: hit.module, loader: 'js' };
}

let registered = false;
async function importProgram(compiled: Compiled, root: string, moduleValues: StateOverrides): Promise<Program> {
	if (!registered) {
		registered = true;
		Bun.plugin({
			name: 'pat',
			setup(build) {
				// Bun resolves bare specifiers before runtime plugins see them, so `patch` is a virtual module.
				build.module('patch', () => ({ exports: patchModule, loader: 'object' }));
				build.onResolve({ filter: /.*/ }, (args) => {
					if (GRAPH.test(args.path)) return { path: args.path };
					const graph = GRAPH.exec(args.importer)?.[0];
					if (!graph || args.path === 'patch') return undefined;
					const path = Bun.resolveSync(args.path, dirname(args.importer.slice(graph.length)));
					if (!path.startsWith(sep)) return undefined;
					return { path: ownFile(path) ? graph + path : path };
				});
				build.onLoad({ filter: GRAPH }, ({ path }) => load(path.replace(GRAPH, '')));
			}
		});
	}
	current = { root, entry: compiled };
	setModuleOverrides(moduleValues);
	try {
		return (await import(`/__patch_eval_${++graphs}__${compiled.path}`)).default;
	} finally {
		setModuleOverrides({});
		current = null;
	}
}
