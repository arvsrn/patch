// Rules for template constructs that the IR can express but PAT rejects.

import { forEachNode } from '../ast';
import type { Bindings } from '../bind';
import type { Reporter } from '../diagnostics';
import { elements, expressions, type Component, type TemplateNode } from '../ir';

const INPUT_TYPES = ['text', 'password', 'email', 'search', 'url', 'tel'];

export function checkTemplate(component: Component, bindings: Bindings, reporter: Reporter) {
	for (const element of elements(component.template)) {
		if (element.type !== 'element') continue;
		const bound = element.attributes.find((a) => a.type === 'bind');
		for (const a of element.attributes) {
			if (a.type === 'bind') {
				const symbol = a.expression.type === 'Identifier' ? bindings.reference(a.expression)?.symbol : null;
				if (symbol?.kind !== 'state') reporter.report(a.nameSpan, 'bind:value needs a top-level $state variable');
			} else if (bound && ((a.type === 'attribute' && a.name === 'value') || (a.type === 'event' && a.name === 'input'))) {
				reporter.report(a.nameSpan, 'bind:value cannot be combined with value= or oninput=');
			} else if (a.type === 'attribute' && a.name === 'type') {
				const value = a.value !== true && 'parts' in a.value && a.value.parts.length === 1 ? a.value.parts[0] : null;
				if (typeof value !== 'string' || !INPUT_TYPES.includes(value)) reporter.report(a.nameSpan, `type must be one of ${INPUT_TYPES.join(', ')}`);
			}
		}
	}
	eachKeys(component.template, reporter);
}

/** Template expressions may only name script bindings, `{#each}` names and real globals. */
export function checkTemplateNames(component: Component, bindings: Bindings, globals: Set<string>, reporter: Reporter) {
	for (const expression of expressions(component.template))
		forEachNode(expression, (node) => {
			if (node.type !== 'Identifier' || node.name.startsWith('$')) return;
			const ref = bindings.reference(node);
			if (ref && !ref.symbol && !globals.has(node.name)) reporter.report(node, `"${node.name}" is not defined`);
		});
}

function eachKeys(nodes: TemplateNode[], reporter: Reporter) {
	for (const node of nodes) {
		if (node.type === 'each') {
			if (!node.key) reporter.report(node.span, '{#each} must be keyed: {#each list as item (item.id)}');
			eachKeys(node.body, reporter);
		} else if (node.type === 'if') {
			for (const branch of node.branches) eachKeys(branch.body, reporter);
			if (node.otherwise) eachKeys(node.otherwise, reporter);
		} else if (node.type === 'element' && node.kind === 'frame') eachKeys(node.children, reporter);
	}
}
