// `$$rt`: the functions compiled scripts call, built on a reactive core. Each
// component instance gets its own: it carries the instance's path (which
// prefixes its state ids), its props, its context and the overrides of the
// tree it belongs to. Everything else (held effects, the reactive graph, the
// router's `page` and `goto`) is shared by the whole app.

import { stateId } from '../schema/path';
import type { Getter, RuntimeApi } from '../schema/program';
import { normalizeStyle } from '../schema/style';
import { createContext } from './context';
import { snippet } from './evaluate';
import type { Owner, Reactive } from './reactive';
import type { Routing } from './router';

export type ApiOptions = {
	/**
	 * Initial values by state id, replacing the script's (design-time states).
	 * A component's state id is its instance path and the name:
	 * `Row@12:3["a"]/expanded`.
	 */
	overrides?: Record<string, unknown>;
	/** Design time: `$effect`s are held until `startEffects()`, so the initial state is exactly the one given. */
	design?: boolean;
};

/** A component instance: its `$$rt`, the instance that rendered it, the contexts it set, and the overrides of its tree. */
export type Instance = { api: RuntimeApi; parent: Instance | null; contexts: Map<object, unknown>; overrides: Record<string, unknown> };

const has = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);

const unrouted = (name: string) => () => {
	throw new Error(`${name} is only available in an app with pages (src/pages/+page.pat)`);
};
const UNROUTED: Routing = {
	page: Object.freeze({ get url() { return unrouted('page')(); }, get params() { return unrouted('page')(); }, get route() { return unrouted('page')(); } }),
	goto: unrouted('goto')
};

export function createApi(r: Reactive, { overrides = {}, design = false }: ApiOptions = {}, routing: Routing = UNROUTED) {
	// Effects created before the first interaction, with their instance's owner.
	let held: { fn: () => unknown; owner: Owner | null }[] | null = design ? [] : null;
	const effect = (fn: () => unknown) => {
		if (held) held.push({ fn, owner: r.currentOwner() });
		else r.deferredEffect(fn);
	};
	/** Starts the held effects of the instances still mounted, as their scripts would have. */
	const startEffects = () => {
		const list = held ?? [];
		held = null;
		for (const { fn, owner } of list) if (!owner?.disposed) r.within(owner, null, () => r.deferredEffect(fn));
	};

	/** An instance at `path` (`''` for a root) given the parent's prop getters. It takes the parent's overrides. */
	const instance = (parent: Instance | null, path: string, props: Record<string, Getter>, own = parent?.overrides ?? {}): Instance => {
		const contexts = new Map<object, unknown>();
		const self: Instance = { parent, contexts, overrides: own, api: null! };
		self.api = {
			state: (name, initial) => {
				const id = stateId(path, name);
				return r.cell(has(own, id) ? own[id] : initial?.());
			},
			derived: r.derived,
			effect,
			style: normalizeStyle,
			// Member assignment rooted at a state variable (`todos[0].done = true`).
			mutate: (target, result) => {
				(target as ReturnType<Reactive['cell']>).notify();
				return result;
			},
			prop: (name, fallback) =>
				r.derived(() => {
					const value = has(props, name) ? props[name]() : undefined;
					return value === undefined && fallback ? fallback() : value;
				}),
			snippet,
			createContext,
			setContext: (key, value) => void contexts.set(key, value),
			getContext: (key) => {
				for (let i: Instance | null = self; i; i = i.parent) if (i.contexts.has(key)) return i.contexts.get(key);
				throw new Error(`getContext: no component above ${path ? `<${path.slice(0, -1)}>` : 'the app'} called setContext for this context`);
			},
			page: routing.page,
			goto: routing.goto
		};
		return self;
	};

	/** The instance of a root program: the app, or a page. It starts from `initial`, by default the given overrides. */
	const root = (initial: Record<string, unknown> = overrides) => instance(null, '', {}, initial);

	return { root, instance, startEffects };
}
