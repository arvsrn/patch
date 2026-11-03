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
// evaluation never sees another's (see module-graph.ts).

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compile, compileModule, type Compiled } from './compile';
import { ModuleGraph } from './module-graph';
import { appRootOf } from './routes';
import { realize } from './runtime/realize';
import type { Concrete } from './schema/concrete';
import { isPatModule, outsideKeys, parseModuleStateId, parseStateId, sitePattern, stateId } from './schema/path';
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

// Module state overrides are still set process-wide while a graph imports, so evaluations take turns.
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
	if (!compiled.imports.length) return realize(new Function(`return (${compiled.module.replace(/^export default /m, '')})`)(), overrides, location);
	const graph = new ModuleGraph(compiled, root, Object.fromEntries(Object.entries(overrides).filter(([id]) => parseModuleStateId(id))));
	try {
		return realize(await graph.import(), overrides, location);
	} finally {
		graph.dispose();
	}
}
