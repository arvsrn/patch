// Helpers for evaluating the parts of a program description, shared by the
// DOM renderer and design-time realize.

import { checkStyle, resolveStyle, type ElementKind, type Style } from '../schema/style';

/** Runs `fn`, tagging any error with the id of the construct that raised it. */
export function withId<T>(id: string, fn: () => T): T {
	try {
		return fn();
	} catch (error: any) {
		if (!error.at) {
			error.message = `${error.message} (at ${id})`;
			error.at = id;
		}
		throw error;
	}
}

/** Resolves and validates an element's style for its kind. */
export function elementStyle(d: { id: string; style: (() => unknown) | null }, kind: ElementKind): Style {
	return withId(d.id, () => {
		const st = d.style ? resolveStyle(d.style()) : {};
		checkStyle(kind, st);
		return st;
	});
}

/** How a value appears as text: nullish and `false` are empty. */
export const toText = (v: unknown) => (v === null || v === undefined || v === false ? '' : String(v));

/** The array an `{#each}` iterates. */
export function eachList(v: unknown): unknown[] {
	if (v === null || v === undefined) return [];
	if (!Array.isArray(v)) throw new Error(`{#each} expects an array, got ${typeof v}`);
	return v;
}
