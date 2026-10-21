// Static style analysis: every style object the compiler can see, paired with
// the element kind it styles. `check/styles.ts` validates them, `emit` wraps
// the ones written in place in style=, and completion lists from them.

import { unwrap, type Estree } from './ast';
import type { Bindings } from './bind';
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

export type Styles = {
	uses: StyleUse[];
	/** CSS strings where a style is expected. */
	strings: Estree[];
};

export function collectStyles(component: Component, bindings: Bindings): Styles {
	const styles: Styles = { uses: [], strings: [] };

	// The statically known parts of a style expression, through arrays,
	// `&&` / `||` / `??` and ternaries: object literals, the object of a
	// `$style({...})` call or of a `$style` const, and CSS strings.
	const sources = (expr: Estree, kind: ElementKind, inAttribute: boolean): void => {
		expr = unwrap(expr);
		switch (expr?.type) {
			case 'ObjectExpression':
				styles.uses.push({ object: expr, kind, direct: inAttribute });
				break;
			case 'ArrayExpression':
				for (const element of expr.elements) sources(element, kind, inAttribute);
				break;
			case 'LogicalExpression':
				if (expr.operator !== '&&') sources(expr.left, kind, inAttribute);
				sources(expr.right, kind, inAttribute);
				break;
			case 'ConditionalExpression':
				sources(expr.consequent, kind, inAttribute);
				sources(expr.alternate, kind, inAttribute);
				break;
			case 'Literal':
				if (typeof expr.value === 'string') styles.strings.push(expr);
				break;
			case 'TemplateLiteral':
				styles.strings.push(expr);
				break;
			case 'Identifier': {
				const object = bindings.reference(expr)?.symbol?.style;
				if (object) styles.uses.push({ object, kind, direct: false });
				break;
			}
			case 'CallExpression': {
				const arg = unwrap(expr.arguments[0]);
				if (arg?.type === 'ObjectExpression' && bindings.runeCall(expr)?.name === '$style') styles.uses.push({ object: arg, kind, direct: false });
			}
		}
	};

	// A `$style({...})` anywhere: checked on its own, for any element.
	for (const call of bindings.runeCalls) if (call.name === '$style') sources(call.node.arguments[0], 'frame', false);
	// A style= attribute: checked for the element it styles.
	for (const element of elements(component.template))
		if (element.style) sources(element.style, element.type === 'span' ? 'inline' : element.kind, true);
	return styles;
}
