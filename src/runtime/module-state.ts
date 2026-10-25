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

import { reactive } from './reactive';

let overrides: Record<string, unknown> = {};

/**
 * Initial values by module state id (`src/workspace.pat.ts#workspace`) for
 * the modules evaluated next. Set before a module graph loads (a snapshot's
 * `--state`), and cleared after.
 */
export function setModuleOverrides(values: Record<string, unknown>) {
	overrides = values;
}

/** The facade of the module state `id`, with the properties its declaration lists. */
export function moduleState(id: string, keys: string[], initial: () => object): object {
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
}
