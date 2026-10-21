// Static style analysis: every style object the compiler can see, paired with
// the element kind it styles, and the shape of every element's style=.
// `check/styles.ts` validates them, `emit` wraps the ones written in place in
// style=, and completion lists from them.

import { unwrap, type Estree } from './ast';
import type { Bindings } from './bind';
import type { Span } from './diagnostics';
import { elements, type Component } from './ir';
import type { ElementKind } from './schema/style';

export type StyleUse = {
	/** An ObjectExpression. */
	object: Estree;
	/** The kind it is checked for. A `$style(...)` on its own is checked as `frame`, which allows every property. */
	kind: ElementKind;
	/** Written in place in a style= attribute (`style={{ gap: 4 }}`): compiled as `$style(...)`. */
	direct: boolean;
};

/**
 * What a style expression evaluates to, as far as the compiler can see:
 * one object, entries merged in order, one of several alternatives (each
 * with the expression to blame, or null for the whole style), nothing
 * (a falsy value), or something it cannot see into.
 */
export type StyleShape =
	| { type: 'object'; object: Estree }
	| { type: 'list'; items: StyleShape[] }
	| { type: 'choice'; options: { shape: StyleShape; node: Estree | null }[] }
	| { type: 'none' }
	| { type: 'unknown' };

/** An element (or inline span), the kind it is styled as, and its style. */
export type StyledElement = { kind: ElementKind; style: Estree | null; nameSpan: Span; shape: StyleShape };

export type Styles = {
	uses: StyleUse[];
	/** CSS strings where a style is expected. */
	strings: Estree[];
	elements: StyledElement[];
};

const NONE: StyleShape = { type: 'none' };
const UNKNOWN: StyleShape = { type: 'unknown' };

export function collectStyles(component: Component, bindings: Bindings): Styles {
	const styles: Styles = { uses: [], strings: [], elements: [] };

	// Through arrays, `&&` / `||` / `??` and ternaries: object literals, the
	// object of a `$style({...})` call or of a `$style` const, CSS strings.
	const shape = (expr: Estree, kind: ElementKind, inAttribute: boolean): StyleShape => {
		const e = unwrap(expr);
		const object = (object: Estree, direct: boolean): StyleShape => {
			styles.uses.push({ object, kind, direct });
			return { type: 'object', object };
		};
		const of = (node: Estree) => shape(node, kind, inAttribute);
		switch (e?.type) {
			case 'ObjectExpression':
				return object(e, inAttribute);
			case 'ArrayExpression':
				return { type: 'list', items: e.elements.map((el: Estree) => (!el ? NONE : of(el.type === 'SpreadElement' ? el.argument : el))) };
			case 'LogicalExpression':
				if (e.operator === '&&') return { type: 'choice', options: [{ shape: NONE, node: null }, { shape: of(e.right), node: e.right }] };
				return { type: 'choice', options: [{ shape: of(e.left), node: e.left }, { shape: of(e.right), node: e.right }] };
			case 'ConditionalExpression':
				return { type: 'choice', options: [{ shape: of(e.consequent), node: e.consequent }, { shape: of(e.alternate), node: e.alternate }] };
			case 'Literal':
				if (typeof e.value === 'string') styles.strings.push(e);
				return e.value ? UNKNOWN : NONE;
			case 'TemplateLiteral':
				styles.strings.push(e);
				return NONE;
			case 'Identifier': {
				const symbol = bindings.reference(e)?.symbol;
				if (symbol?.style) return object(symbol.style, false);
				return !symbol && e.name === 'undefined' ? NONE : UNKNOWN;
			}
			case 'CallExpression': {
				const arg = unwrap(e.arguments[0]);
				if (arg?.type === 'ObjectExpression' && bindings.runeCall(e)?.name === '$style') return object(arg, false);
			}
		}
		return UNKNOWN;
	};

	// A `$style({...})` anywhere: checked on its own, for any element.
	for (const call of bindings.runeCalls) if (call.name === '$style') shape(call.node.arguments[0], 'frame', false);
	// A style= attribute: checked for the element it styles.
	for (const element of elements(component.template)) {
		const kind = element.type === 'span' ? 'inline' : element.kind;
		styles.elements.push({ kind, style: element.style, nameSpan: element.nameSpan, shape: element.style ? shape(element.style, kind, true) : NONE });
	}
	return styles;
}
