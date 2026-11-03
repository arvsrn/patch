// `$state` in a .pat.ts module: state owned by the module rather than a
// component instance. It lives as long as the module graph that loaded it, so
// it outlives pages, and every importer shares it.
//
// It is one cell holding the object, as a component's `$state({...})` is, so
// reading any property depends on the whole value. What the module exports is
// a stable facade over that cell: reading a property reads the cell, and
// assigning one replaces the value with a copy that has it. Nothing deeper is
// tracked, so values are replaced, never changed in place (its types are
// read-only below the first level).
//
// Compiled modules import `moduleState` from this file. Where module state
// starts from overrides (a snapshot's `--state`), that import resolves to a
// module of the graph that builds its own with `createModuleState` (see
// `moduleStateSource` in compile.ts).

import { reactive } from './reactive';

/** Module state whose initial values are `overrides` where they have one, by module state id (`src/workspace.pat.ts#workspace`). */
export function createModuleState(overrides: Record<string, unknown>) {
	/** The facade of the module state `id`, with the properties its declaration lists. */
	return function moduleState(id: string, keys: string[], initial: () => object): object {
		const cell = reactive.cell<Record<string, unknown>>(Object.hasOwn(overrides, id) ? (overrides[id] as Record<string, unknown>) : (initial() as Record<string, unknown>));
		const facade = {};
		for (const key of keys)
			Object.defineProperty(facade, key, {
				enumerable: true,
				get: () => cell.v?.[key],
				set: (value: unknown) => {
					cell.v = { ...reactive.untrack(() => cell.v), [key]: value };
				}
			});
		return Object.preventExtensions(facade);
	};
}

/** Module state as the app starts. */
export const moduleState = createModuleState({});
