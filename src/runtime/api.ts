// `$$rt`: the functions compiled scripts call, built on a reactive core.

import type { RuntimeApi } from '../schema/program';
import { normalizeStyle } from '../schema/style';
import type { Reactive } from './reactive';

export type ApiOptions = {
	/** Initial values by state id, replacing the script's (design-time states). */
	overrides?: Record<string, unknown>;
	/** Design time: `$effect`s never run. */
	design?: boolean;
};

export function createApi(r: Reactive, { overrides = {}, design = false }: ApiOptions = {}): RuntimeApi {
	return {
		state: (id, initial) => r.cell(Object.prototype.hasOwnProperty.call(overrides, id) ? overrides[id] : initial?.()),
		derived: r.derived,
		effect: (fn) => {
			if (!design) r.deferredEffect(fn);
		},
		style: normalizeStyle,
		// Member assignment rooted at a state variable (`todos[0].done = true`).
		mutate: (target, result) => {
			(target as ReturnType<Reactive['cell']>).notify();
			return result;
		}
	};
}
