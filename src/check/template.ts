// Rules for template constructs that the IR can express but PAT rejects.

import { forEachNode } from '../ast';
import type { Bindings } from '../bind';
import type { Reporter } from '../diagnostics';
import type { DomEvents } from '../typecheck';
import { elements, expressions, fragments, type Component, type TemplateNode } from '../ir';

const INPUT_TYPES = ['text', 'password', 'email', 'search', 'url', 'tel'];

export function checkTemplate(component: Component, bindings: Bindings, reporter: Reporter) {
	for (const element of elements(component.template)) {
		if (element.type !== 'element') continue;
		const bound = element.attributes.some((a) => a.type === 'bind' && a.name === 'value');
		for (const a of element.attributes) {
			if (a.type === 'bind') {
				const symbol = a.expression.type === 'Identifier' ? bindings.reference(a.expression)?.symbol : null;
				// Patch writes the element as it mounts and unmounts: the variable changes, so it is state.
				if (symbol?.kind !== 'state')
					reporter.report(a.nameSpan, a.name === 'value' ? 'bind:value needs a top-level $state variable' : 'bind:this needs a top-level $state variable: let el = $state<HTMLElement>()');
			} else if (bound && ((a.type === 'attribute' && a.name === 'value') || (a.type === 'event' && a.name === 'input'))) {
				reporter.report(a.nameSpan, 'bind:value cannot be combined with value= or oninput=');
			} else if (a.type === 'attribute' && a.name === 'type') {
				const value = a.value !== true && 'parts' in a.value && a.value.parts.length === 1 ? a.value.parts[0] : null;
				if (typeof value !== 'string' || !INPUT_TYPES.includes(value)) reporter.report(a.nameSpan, `type must be one of ${INPUT_TYPES.join(', ')}`);
			}
		}
	}
	snippetNames(component.template, reporter);
}

/** The closest of `names` to `name`, if it is a likely misspelling. */
export function closest(name: string, names: Iterable<string>): string | null {
	let best: string | null = null;
	let distance = Math.max(2, Math.floor(name.length / 4)) + 1;
	for (const candidate of names) {
		const d = editDistance(name, candidate);
		if (d < distance) [best, distance] = [candidate, d];
	}
	return best;
}

function editDistance(a: string, b: string): number {
	let row = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const next = [i];
		for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
		row = next;
	}
	return row[b.length];
}

/** `on…=` names an event the element has: a misspelled one would never fire. */
export function checkEvents(component: Component, events: DomEvents, reporter: Reporter) {
	for (const element of elements(component.template)) {
		if (element.type !== 'element') continue;
		const known = events.html;
		for (const a of element.attributes) {
			if (a.type !== 'event' || known.has(a.name)) continue;
			const near = closest(a.name, known);
			reporter.report(a.nameSpan, `"on${a.name}" is not an event of <${element.tag}>${near ? `; did you mean "on${near}"?` : ''}`);
		}
	}
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

/** Two snippets in one block would declare the same name. */
function snippetNames(nodes: TemplateNode[], reporter: Reporter) {
	const seen = new Set<string>();
	for (const node of nodes) {
		if (node.type === 'snippet') {
			if (seen.has(node.name.name)) reporter.report(node.name, `snippet "${node.name.name}" is already declared in this block`);
			seen.add(node.name.name);
		}
		for (const fragment of fragments(node)) snippetNames(fragment, reporter);
	}
}
