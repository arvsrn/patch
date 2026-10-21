// Value flow over the binder's definitions: what an expression's value may
// be, as far as names, members and a few well-known calls show it. Answers
// are conservative in the direction each caller states; anything not
// understood is treated as unrelated.

import { unwrap, type Estree } from './ast';
import { isSignal, type Bindings, type Symbol } from './bind';

/**
 * A reactive variable a value may share objects with. `fresh`: the value
 * is a new container whose contents are the variable's (`list.slice()`,
 * `[...list]`, `{ ...obj }`), so changing the container itself is safe.
 */
export type Alias = { symbol: Symbol; fresh: boolean };

/** Calls returning an element of the receiver. */
const ELEMENT = new Set(['find', 'findLast', 'at', 'get']);
/** Calls returning a new container holding the receiver's elements. */
const COPY = new Set(['filter', 'slice', 'concat', 'toSorted', 'toReversed', 'toSpliced', 'with', 'flat', 'values']);

/** The reactive variables (state, derived, each items) `expr`'s value may be, or be part of. */
export function aliases(bindings: Bindings, expr: Estree, seen = new Set<Symbol>()): Alias[] {
	const e = unwrap(expr);
	const within = (node: Estree) => aliases(bindings, node, seen).map((a) => ({ ...a, fresh: false }));
	const copied = (node: Estree) => aliases(bindings, node, seen).map((a) => ({ ...a, fresh: true }));
	switch (e?.type) {
		case 'Identifier': {
			const symbol = bindings.reference(e)?.symbol;
			if (!symbol || seen.has(symbol)) return [];
			if (isSignal(symbol)) return [{ symbol, fresh: false }];
			seen.add(symbol);
			return symbol.defs.flatMap((d) => (d.whole ? aliases(bindings, d.value, seen) : within(d.value)));
		}
		case 'MemberExpression':
			return within(e.object);
		case 'ChainExpression':
			return aliases(bindings, e.expression, seen);
		case 'ConditionalExpression':
			return [...aliases(bindings, e.consequent, seen), ...aliases(bindings, e.alternate, seen)];
		case 'LogicalExpression':
			return [...aliases(bindings, e.left, seen), ...aliases(bindings, e.right, seen)];
		case 'SequenceExpression':
			return aliases(bindings, e.expressions[e.expressions.length - 1], seen);
		case 'AssignmentExpression':
			return e.operator === '=' ? aliases(bindings, e.right, seen) : [];
		// A new container: changing it is safe, its contents are what went in.
		case 'ArrayExpression':
			return e.elements.flatMap((el: Estree) => (el ? copied(el.type === 'SpreadElement' ? el.argument : el) : []));
		case 'ObjectExpression':
			return e.properties.flatMap((p: Estree) => copied(p.type === 'SpreadElement' ? p.argument : p.value));
		case 'CallExpression': {
			const callee = unwrap(e.callee);
			if (callee.type !== 'MemberExpression' || callee.computed) return [];
			if (ELEMENT.has(callee.property.name)) return within(callee.object);
			if (COPY.has(callee.property.name)) return copied(callee.object);
			return [];
		}
	}
	return [];
}

/** A reactive variable whose objects `expr` is (not a fresh copy of), so changing `expr` in place changes it. */
export const sharedWith = (bindings: Bindings, expr: Estree): Symbol | null => aliases(bindings, expr).find((a) => !a.fresh)?.symbol ?? null;
