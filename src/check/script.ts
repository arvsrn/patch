// Rules for the JS/TS in a .pat file (the script and template expressions):
// reactivity (what may be written, mutated, or called as a rune) and escape
// hatches around the visual model.

import { forEachNode, rootOf, type Estree } from '../ast';
import { isSignal, type Bindings } from '../bind';
import type { Reporter } from '../diagnostics';
import { expressions, type Component } from '../ir';

const ARRAY_MUTATORS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin']);

// Straightforward attempts to bypass the template/style model.
const VISUAL_ESCAPES = new Set([
	'querySelector', 'querySelectorAll', 'getElementById', 'getElementsByClassName', 'getElementsByTagName',
	'getElementsByName', 'createElement', 'createElementNS', 'createTextNode', 'createDocumentFragment',
	'appendChild', 'insertBefore', 'removeChild', 'replaceChild', 'replaceChildren', 'replaceWith',
	'insertAdjacentHTML', 'insertAdjacentElement', 'insertAdjacentText', 'innerHTML', 'outerHTML', 'innerText',
	'textContent', 'setProperty', 'cssText', 'classList', 'className', 'attachShadow', 'getComputedStyle',
	'getBoundingClientRect', 'adoptedStyleSheets', 'styleSheets'
]);
const DOCUMENT_ESCAPES = new Set(['body', 'documentElement', 'head', 'write', 'writeln']);
const RUNES = ['$state', '$derived', '$derived.by', '$effect'];

export function checkScript(component: Component, bindings: Bindings, reporter: Reporter) {
	references(bindings, reporter);
	memberWrites(bindings, reporter);
	runeCalls(component, bindings, reporter);
	const roots = [...(component.script?.body ?? []), ...expressions(component.template)];
	for (const root of roots) forEachNode(root, (node) => syntax(node, bindings, reporter));
}

function references(bindings: Bindings, reporter: Reporter) {
	for (const ref of bindings.references) {
		const { node, symbol } = ref;
		const name: string = node.name;
		if (name.startsWith('$$')) reporter.report(node, 'identifiers starting with $$ are reserved');
		else if (!symbol && name.startsWith('$'))
			reporter.report(node, `${name} is not supported here (runes: $state, $derived, $effect as top-level declarations/statements; $style anywhere)`);
		if (!symbol && name === 'getComputedStyle') reporter.report(node, 'getComputedStyle is a visual escape hatch and is not allowed');
		if (ref.access !== 'write') continue;
		if (symbol?.kind === 'derived') reporter.report(node, `"${name}" is $derived and read-only`);
		if (symbol?.kind === 'item') reporter.report(node, `"${name}" is an {#each} binding and read-only; reassign the source array instead`);
		if (ref.destructured && isSignal(symbol))
			reporter.report(ref.destructured, 'destructuring assignment into a reactive variable is not supported; assign it directly');
	}
}

function memberWrites(bindings: Bindings, reporter: Reporter) {
	for (const write of bindings.memberWrites) {
		const symbol = write.root?.symbol;
		const name = write.root?.node.name;
		if (write.inPattern) {
			if (isSignal(symbol)) reporter.report(write.node, 'destructuring into a member of a reactive variable is not supported');
			continue;
		}
		if (symbol?.kind === 'derived') reporter.report(write.node, `"${name}" is $derived and read-only`);
		if (symbol?.kind === 'item') reporter.report(write.node, `"${name}" is an {#each} binding and cannot be mutated; reassign the source array instead`);
		const object = write.target.object;
		if (object?.type === 'MemberExpression' && !object.computed && object.property.name === 'style')
			reporter.report(write.node, 'assigning to .style bypasses the visual model');
	}
}

function runeCalls(component: Component, bindings: Bindings, reporter: Reporter) {
	const allowed = component.script?.runes ?? new Set();
	for (const { node, name } of bindings.runeCalls) {
		const count = node.arguments.length;
		if (name === '$style') {
			if (count !== 1) reporter.report(node, '$style takes exactly one object');
		} else if (!allowed.has(node)) {
			const where = name === '$effect' ? 'a top-level statement' : 'a top-level `let x = ...` declaration';
			reporter.report(node, RUNES.includes(name) ? `${name}(...) is only allowed as ${where}` : `${name} is not supported`);
		} else if (name === '$state') {
			if (count > 1) reporter.report(node, '$state takes at most one initial value');
		} else if (name === '$derived') {
			if (count !== 1) reporter.report(node, '$derived takes exactly one expression');
		} else if (count !== 1) reporter.report(node, `${name} takes exactly one function`);
	}
}

/** Rules that depend only on the shape of one node. */
function syntax(node: Estree, bindings: Bindings, reporter: Reporter) {
	switch (node.type) {
		case 'MemberExpression': {
			if (node.computed || node.property.type !== 'Identifier') return;
			const name = node.property.name;
			if (VISUAL_ESCAPES.has(name)) reporter.report(node.property, `.${name} bypasses the visual model; render through the template and style={...} instead`);
			if (node.object.type === 'Identifier' && node.object.name === 'document' && DOCUMENT_ESCAPES.has(name))
				reporter.report(node.property, `document.${name} bypasses the visual model`);
			return;
		}
		case 'CallExpression': {
			const callee = node.callee;
			if (callee.type !== 'MemberExpression' || callee.computed || !ARRAY_MUTATORS.has(callee.property.name)) return;
			const root = rootOf(callee.object);
			const ref = root?.type === 'Identifier' ? bindings.reference(root) : undefined;
			if (isSignal(ref?.symbol))
				reporter.report(callee.property, `.${callee.property.name}() mutates reactive "${root.name}" in place, which is not tracked; assign a new array instead`);
			return;
		}
		case 'ImportExpression':
			return reporter.report(node, 'dynamic import() is not supported in v0');
		case 'TSEnumDeclaration':
		case 'TSModuleDeclaration':
			return reporter.report(node, 'TypeScript enums/namespaces are not supported');
	}
}
