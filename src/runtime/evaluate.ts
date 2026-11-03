// Helpers for evaluating the parts of a program description, shared by the
// DOM renderer and design-time realize.

import type { EachNode, ElementNode, InlinePart } from '../schema/program';
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

/** Text content as plain text: what an <option>'s label or SVG text shows. A nested element adds nothing. */
export const plainText = (parts: InlinePart[], id: string) =>
	parts.map((p) => (typeof p === 'string' ? p : typeof p === 'function' ? toText(withId(id, p)) : '')).join('');

/** An attribute's value as text, or null when the element does not have it. */
export const attributeText = (d: ElementNode, name: string): string | null => (d.attrs[name] ? toText(withId(d.id, d.attrs[name])) : null);

/** The key of each item of an `{#each}` list. Throws on a key given twice. */
export function eachKeys(d: EachNode, list: unknown[]): unknown[] {
	const seen = new Set();
	return list.map((raw, i) => {
		const key = withId(d.id, () => d.key({ v: raw }, { v: i }));
		if (seen.has(key)) throw new Error(`Duplicate each key ${JSON.stringify(key)} (at ${d.id})`);
		seen.add(key);
		return key;
	});
}

/** The portal a `portal=` value names; null renders the element in place. */
export function portalName(v: unknown): string | null {
	if (v === null || v === undefined || v === false) return null;
	if (typeof v !== 'string' || !v) throw new Error(`portal must be a portal id or null, got ${JSON.stringify(v)}`);
	return v;
}
/** The array an `{#each}` iterates. */
export function eachList(v: unknown): unknown[] {
	if (v === null || v === undefined) return [];
	if (!Array.isArray(v)) throw new Error(`{#each} expects an array, got ${typeof v}`);
	return v;
}

const SNIPPET = Symbol('snippet');

/** Marks `fn` as a snippet. */
export const snippet = <F extends Function>(fn: F): F => Object.assign(fn, { [SNIPPET]: true });

/** What `{@render}` renders: the snippet's nodes, or null for a nullish snippet in `{@render x?.()}`. */
export function renderable(fn: unknown, optional: boolean, id: string): ((...args: unknown[]) => any) | null {
	if (fn == null && optional) return null;
	if (typeof fn !== 'function' || !(SNIPPET in fn)) throw new Error(`{@render} needs a snippet, got ${fn === null ? 'null' : typeof fn} (at ${id})`);
	return fn as unknown as (...args: unknown[]) => any;
}

/** What a component tag renders. */
export function componentOf(value: unknown, tag: string, id: string): Function {
	if (typeof value !== 'function') throw new Error(`<${tag}> is not a component, got ${value === null ? 'null' : typeof value} (at ${id})`);
	return value;
}

