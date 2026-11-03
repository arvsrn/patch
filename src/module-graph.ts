// Design-time module graphs: each evaluation imports the app as a module
// graph of its own, so module state starts fresh in every evaluation and one
// never sees another's.
//
// A graph's files are loaded under its prefix, `/__patch_eval_<n>__<path>`,
// so a relative import from one of them resolves to another file of the same
// graph. Packages and Patch's runtime stay shared (one reactive core). The
// prefix is the graph's identity: the one Bun plugin finds the graph of every
// path it resolves or loads from the path alone, in the registry, which holds
// exactly the graphs that are open.
//
// A graph's module state starts from its overrides: in the graph, compiled
// modules' import of runtime/module-state.ts resolves to the graph's own
// module-state module, `<prefix>/__patch_module_state__.js`, whose source holds
// the overrides.
//
// What a graph loads is compiled from source through a process-wide memo:
// a graph consumes compiled modules, it does not own them.

import { readFileSync } from 'node:fs';
import { dirname, extname, sep } from 'node:path';
import { compile, compileModule, moduleStateSource, type Compiled } from './compile';
import { PATCH_SRC, RUNTIME } from './paths';
import * as patchModule from './runtime/context';
import { isPatModule } from './schema/path';
import type { Program } from './schema/program';

const PREFIX = /^\/__patch_eval_\d+__/;
/** A graph's module-state module, within the graph (with an extension, which Bun needs to load it). */
const MODULE_STATE = '/__patch_module_state__.js';
const open = new Map<string, ModuleGraph>();
let created = 0;

/** One evaluation's copy of the app's modules. Open from construction until `dispose`. */
export class ModuleGraph {
	/** `/__patch_eval_<n>__`: what every path of the graph starts with. */
	readonly prefix = `/__patch_eval_${++created}__`;
	private disposed = false;

	/** Initial values of module state by id: JSON values, as the graph's module-state module holds them. */
	readonly overrides: Readonly<Record<string, unknown>>;

	/**
	 * `entry` is loaded as already compiled; `root` is the app's root
	 * directory, which module state ids are relative to. The graph keeps
	 * `overrides` as they are now: changing the object later does not change it.
	 */
	constructor(
		readonly entry: Compiled,
		readonly root: string,
		overrides: Record<string, unknown> = {}
	) {
		this.overrides = Object.freeze(JSON.parse(JSON.stringify(overrides)));
		open.set(this.prefix, this);
	}

	/** Imports the entry and everything it imports, in this graph. */
	async import(): Promise<Program> {
		if (this.disposed) throw new Error(`module graph ${this.prefix} is disposed`);
		registerPlugin();
		return (await import(this.prefix + this.entry.path)).default;
	}

	/** Closes the graph and lets the loader drop its modules. What was imported from it stays usable. */
	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		open.delete(this.prefix);
		for (const key of Object.keys(require.cache)) if (key.startsWith(this.prefix + sep)) delete require.cache[key];
	}
}

/** The prefixes of the graphs that are open. */
export const openGraphs = () => [...open.keys()];

/** The open graph `path` belongs to, and the path within it. Throws for a graph that is not open. */
function graphOf(path: string): { graph: ModuleGraph; path: string } | null {
	const prefix = PREFIX.exec(path)?.[0];
	if (!prefix) return null;
	const graph = open.get(prefix);
	if (!graph) throw new Error(`${path} belongs to module graph ${prefix}, which is not open`);
	return { graph, path: path.slice(prefix.length) };
}

/** Whether `path` is the app's own (loaded in each graph) rather than a package's or Patch's. */
const ownFile = (path: string) => path.startsWith(sep) && !path.includes(`${sep}node_modules${sep}`) && !path.startsWith(PATCH_SRC + sep);

const IMAGES = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.ico'];
type Loader = 'ts' | 'tsx' | 'js' | 'jsx' | 'json';
const LOADERS: Record<string, Loader> = { '.ts': 'ts', '.mts': 'ts', '.tsx': 'tsx', '.js': 'js', '.mjs': 'js', '.jsx': 'jsx', '.json': 'json' };

/** Compiled .pat files and .pat.ts modules, by path, while their source (and the app root) stays the same. */
const compiled = new Map<string, { source: string; root: string; module: string }>();

/** A file of `graph`, as Bun loads it. */
function load(graph: ModuleGraph, path: string): { contents: string; loader: Loader } {
	if (path === graph.entry.path) return { contents: graph.entry.module, loader: 'js' };
	if (path === MODULE_STATE) return { contents: moduleStateSource(graph.overrides), loader: 'js' };
	// An image is its path (it is not drawn at design time).
	if (IMAGES.includes(extname(path).toLowerCase())) return { contents: `export default ${JSON.stringify(path)};`, loader: 'js' };
	const source = readFileSync(path, 'utf8');
	if (!path.endsWith('.pat') && !isPatModule(path)) {
		const loader = LOADERS[extname(path)];
		if (!loader) throw new Error(`Cannot import ${path} at design time`);
		return { contents: source, loader };
	}
	let hit = compiled.get(path);
	if (hit?.source !== source || hit.root !== graph.root) {
		const module = path.endsWith('.pat') ? compile(source, path).module : compileModule(source, path, graph.root).module;
		compiled.set(path, (hit = { source, root: graph.root, module }));
	}
	return { contents: hit.module, loader: 'js' };
}

let registered = false;

/** The one Bun plugin for every graph. Bun plugins are process-wide and cannot be removed. */
function registerPlugin() {
	if (registered) return;
	registered = true;
	Bun.plugin({
		name: 'pat',
		setup(build) {
			// Bun resolves bare specifiers before runtime plugins see them, so `patch` is a virtual module.
			build.module('patch', () => ({ exports: patchModule, loader: 'object' }));
			build.onResolve({ filter: /.*/ }, (args) => {
				if (PREFIX.test(args.path)) return { path: args.path };
				const from = args.path === 'patch' ? null : graphOf(args.importer);
				if (!from) return undefined;
				// The graph's module-state module itself imports the shared runtime.
				if (args.path === RUNTIME.moduleState && from.path !== MODULE_STATE) return { path: from.graph.prefix + MODULE_STATE };
				const path = Bun.resolveSync(args.path, dirname(from.path));
				if (!path.startsWith(sep)) return undefined;
				return { path: ownFile(path) ? from.graph.prefix + path : path };
			});
			build.onLoad({ filter: PREFIX }, (args) => {
				const { graph, path } = graphOf(args.path)!;
				return load(graph, path);
			});
		}
	});
}
