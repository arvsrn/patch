// The PAT IR: what a .pat file means, independent of the parser.
//
// `lower.ts` builds it from svelte's AST; every later phase reads only this.
// The template is fully modelled. JS/TS stays ESTree (a stable standard): the
// script keeps its statements and only the top-level declarations PAT gives
// meaning to (runes, imports) are classified.

import type { Estree } from './ast';
import type { Span } from './diagnostics';

export type Component = {
	script: Script | null;
	template: TemplateNode[];
};

// ------------------------------------------------------------------ script

export type Script = {
	lang: 'ts' | 'js';
	/** The script's content (between the tags). */
	span: Span;
	/** Every top-level statement, imports included. */
	body: Estree[];
	imports: Estree[];
	/** `let x = $state(...)`. */
	state: StateDecl[];
	/** `let x = $derived(...)` / `$derived.by(...)`. */
	derived: DerivedDecl[];
	/** Top-level `$effect(...)` statements. */
	effects: Estree[];
	/** `const x = $style({...})`: identifiers a style= may refer to. */
	styles: StyleDecl[];
	/** The `$state`/`$derived`/`$effect` calls in a position where PAT accepts them. */
	runes: Set<Estree>;
};

export type StateDecl = { id: Estree; call: Estree; info: StateInfo };
export type DerivedDecl = { id: Estree; call: Estree; by: boolean };
export type StyleDecl = { id: Estree; object: Estree };

export type StateInfo = {
	/** Stable id used for design-time overrides: the top-level variable name. */
	id: string;
	name: string;
	line: number;
	column: number;
	defaultSource: string;
	/** Present when the initializer is a literal. */
	defaultValue?: unknown;
};

// ---------------------------------------------------------------- template

export type TemplateNode = Element | Text | If | Each;

/** The tags PAT supports. */
export type Tag = 'main' | 'div' | 'button' | 'p' | 'span' | 'input' | 'textarea';

type ElementBase = {
	type: 'element';
	tag: Tag;
	span: Span;
	nameSpan: Span;
	/** The `style={...}` expression. */
	style: Estree | null;
	/** Attributes, event handlers and bindings, in source order. */
	attributes: Attribute[];
};
/** <main>, <div>, <button>: containers. */
export type Frame = ElementBase & { kind: 'frame'; children: TemplateNode[] };
/** <p>, <span>: a block of text. */
export type TextElement = ElementBase & { kind: 'text'; content: Inline[] };
export type Input = ElementBase & { kind: 'input' | 'textarea' };
export type Element = Frame | TextElement | Input;

export type Attribute =
	| { type: 'attribute'; name: string; span: Span; nameSpan: Span; value: AttributeValue }
	| { type: 'event'; name: string; span: Span; nameSpan: Span; handler: Estree }
	| { type: 'bind'; span: Span; nameSpan: Span; expression: Estree };

/** `disabled` (true), `value={x}` (an expression), or `title="a {b} c"` (parts). */
export type AttributeValue = true | { expression: Estree } | { parts: (string | Estree)[] };

/** Bare text between elements in a container. */
export type Text = { type: 'text'; span: Span; content: Inline[] };

/**
 * Text content with whitespace already collapsed: static text, `{expr}`, or a
 * nested <span> that may only carry typography.
 */
export type Inline =
	| { type: 'static'; value: string }
	| { type: 'expression'; expression: Estree }
	| { type: 'span'; span: Span; nameSpan: Span; style: Estree | null; content: Inline[] };

export type If = {
	type: 'if';
	span: Span;
	branches: { test: Estree; body: TemplateNode[] }[];
	otherwise: TemplateNode[] | null;
};

export type Each = {
	type: 'each';
	span: Span;
	list: Estree;
	item: Estree;
	index: string | null;
	key: Estree | null;
	body: TemplateNode[];
};

/** Every element and inline <span> in a template, depth first. */
export function* elements(nodes: TemplateNode[]): Generator<Element | Extract<Inline, { type: 'span' }>> {
	for (const node of nodes) {
		if (node.type === 'element') {
			yield node;
			if (node.kind === 'frame') yield* elements(node.children);
			if (node.kind === 'text') yield* spans(node.content);
		} else if (node.type === 'text') yield* spans(node.content);
		else if (node.type === 'if') {
			for (const branch of node.branches) yield* elements(branch.body);
			if (node.otherwise) yield* elements(node.otherwise);
		} else yield* elements(node.body);
	}
}

function* spans(content: Inline[]): Generator<Extract<Inline, { type: 'span' }>> {
	for (const part of content)
		if (part.type === 'span') {
			yield part;
			yield* spans(part.content);
		}
}

/** Every JS expression in a template (tests, lists, keys, styles, attributes, text). */
export function* expressions(nodes: TemplateNode[]): Generator<Estree> {
	function* inline(content: Inline[]): Generator<Estree> {
		for (const part of content) {
			if (part.type === 'expression') yield part.expression;
			else if (part.type === 'span') {
				if (part.style) yield part.style;
				yield* inline(part.content);
			}
		}
	}
	for (const node of nodes) {
		if (node.type === 'text') yield* inline(node.content);
		else if (node.type === 'element') {
			if (node.style) yield node.style;
			for (const a of node.attributes) {
				if (a.type === 'event') yield a.handler;
				else if (a.type === 'bind') yield a.expression;
				else if (a.value !== true) yield* 'expression' in a.value ? [a.value.expression] : a.value.parts.filter((p) => typeof p !== 'string');
			}
			if (node.kind === 'frame') yield* expressions(node.children);
			if (node.kind === 'text') yield* inline(node.content);
		} else if (node.type === 'if') {
			for (const branch of node.branches) {
				yield branch.test;
				yield* expressions(branch.body);
			}
			if (node.otherwise) yield* expressions(node.otherwise);
		} else {
			yield node.list;
			if (node.key) yield node.key;
			yield* expressions(node.body);
		}
	}
}
