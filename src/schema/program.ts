// The compiled program: what `emit/` generates and what `runtime/` executes.
//
// A compiled module default-exports a `Program`. Called with the runtime API
// (`$$rt`), it runs the script and returns a static description of the
// template whose dynamic parts are closures. Ids are `line:column` of the
// construct in the .pat source.

import type { Style } from './style';

/** A value read reactively. */
export type Getter<T = unknown> = () => T;

/** A reactive value; `{#each}` items and indexes are passed to templates as cells. */
export type Cell<T = unknown> = { readonly v: T };

/** `$$rt`: what compiled scripts call. */
export type RuntimeApi = {
	/** `initial` computes the initial value; it is not called when the state is overridden. */
	state: (id: string, initial?: () => unknown) => { v: unknown };
	derived: <T>(fn: () => T) => Cell<T>;
	effect: (fn: () => unknown) => void;
	style: (input: unknown) => Style;
	mutate: <T>(target: { v: unknown }, result: T) => T;
};

export type Program = (rt: RuntimeApi) => ProgramNode[];

export type ProgramNode = TextNode | ElementNode | IfNode | EachNode;

/** A piece of text content: static text, an expression, or a nested <span>. */
export type InlinePart = string | Getter | SpanNode;

/** Bare text between elements in a container. */
export type TextNode = { t: 'text'; id: string; parts: InlinePart[] };

export type SpanNode = { t: 'span'; id: string; style: Getter | null; kids: InlinePart[] };

type ElementBase = {
	t: 'el';
	tag: string;
	id: string;
	style: Getter | null;
	/** Attribute name → value getter. */
	attrs: Record<string, Getter>;
	/** Event name (without `on`) → getter returning the handler. */
	on: Record<string, Getter>;
	/** `bind:this`: reads and writes the bound variable. It holds the element while mounted, else `undefined`. */
	ref: { get: Getter; set: (node: unknown) => void } | null;
};
export type FrameElement = ElementBase & { kind: 'frame'; kids: ProgramNode[] };
export type TextElement = ElementBase & { kind: 'text'; kids: InlinePart[] };
export type InputElement = ElementBase & { kind: 'input' | 'textarea'; kids: [] };
export type ElementNode = FrameElement | TextElement | InputElement;

/** `{#if}`: the first branch whose test is truthy, else `e`. */
export type IfNode = { t: 'if'; id: string; b: [test: Getter, kids: ProgramNode[]][]; e: ProgramNode[] | null };

/** Keyed `{#each}`. */
export type EachNode = {
	t: 'each';
	id: string;
	list: Getter;
	key: (item: Cell, index: Cell<number>) => unknown;
	kids: (item: Cell, index: Cell<number>) => ProgramNode[];
};
