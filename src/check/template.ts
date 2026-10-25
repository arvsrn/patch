// Rules for template constructs that the IR can express but PAT rejects.

import { forEachNode } from '../ast';
import type { Bindings } from '../bind';
import type { Reporter } from '../diagnostics';
import type { DomNames } from '../typecheck';
import { staticValue } from './names';
import { elements, expressions, fragments, type Component, type TemplateNode } from '../ir';

const INPUT_TYPES = ['text', 'password', 'email', 'search', 'url', 'tel'];
const BUTTON_TYPES = ['submit', 'button', 'reset'];

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
				const types = element.tag === 'button' ? BUTTON_TYPES : INPUT_TYPES;
				if (typeof value !== 'string' || !types.includes(value)) reporter.report(a.nameSpan, `type must be one of ${types.join(', ')}`);
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
export function checkEvents(component: Component, { events }: DomNames, reporter: Reporter) {
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

/** WAI-ARIA 1.2 roles. */
const ROLES = new Set(
	`alert alertdialog application article banner blockquote button caption cell checkbox code columnheader combobox comment
	complementary contentinfo definition deletion dialog directory document emphasis feed figure form generic grid gridcell group
	heading img insertion link list listbox listitem log main mark marquee math menu menubar menuitem menuitemcheckbox menuitemradio
	meter navigation none note option paragraph presentation progressbar radio radiogroup region row rowgroup rowheader scrollbar
	search searchbox separator slider spinbutton status strong subscript suggestion superscript switch tab table tablist tabpanel
	term textbox time timer toolbar tooltip tree treegrid treeitem`.split(/\s+/)
);

/** The data-* attributes the renderer (runtime/dom.ts) sets on its elements. */
export const RESERVED_DATA = ['data-p', 'data-w', 'data-h', 'data-sw', 'data-sh', 'data-dir', 'data-overflow', 'data-host', 'data-anchored', 'data-mixed', 'data-run'];

/** The values of global and ARIA attributes, where they are static. (Element ids are checked with portal ids, in check/names.ts.) */
export function checkAttributes(component: Component, dom: DomNames, reporter: Reporter) {
	for (const element of elements(component.template)) {
		if (element.type !== 'element') continue;
		for (const a of element.attributes) {
			if (a.type !== 'attribute') continue;
			const value = staticValue(a.value);
			if (a.name.startsWith('aria-')) {
				if (!dom.aria.has(a.name)) {
					const near = closest(a.name, dom.aria);
					reporter.report(a.nameSpan, `"${a.name}" is not an ARIA attribute${near ? `; did you mean "${near}"?` : ''}`);
				}
			} else if (a.name.startsWith('data-')) {
				if (!/^data-[a-z0-9][a-z0-9._-]*$/.test(a.name)) reporter.report(a.nameSpan, `"${a.name}": a data attribute is named data- and lowercase letters, digits, ".", "_" and "-"`);
				else if (RESERVED_DATA.includes(a.name)) reporter.report(a.nameSpan, `${a.name} is used by Patch's renderer; choose another name`);
			} else if (a.name === 'role' && typeof value === 'string') {
				const unknown = value.split(/\s+/).filter((r) => r && !ROLES.has(r));
				if (!value.trim() || unknown.length) reporter.report(a.nameSpan, `role must be ARIA roles${unknown.length ? `; "${unknown[0]}" is not one` : ''}`);
			} else if (a.name === 'tabindex' && value !== null) {
				if (typeof value !== 'string' || !/^-?\d+$/.test(value.trim())) reporter.report(a.nameSpan, 'tabindex must be an integer: 0 to be reachable from the keyboard in document order, -1 to be focusable only by code');
				else if (Number(value) > 0)
					reporter.report(a.nameSpan, 'a positive tabindex moves the element ahead of the whole page in keyboard order; use 0 and order the template instead', 'warning');
			} else if (a.name === 'dir' && value !== null && !['ltr', 'rtl', 'auto'].includes(value as string)) {
				reporter.report(a.nameSpan, 'dir must be "ltr", "rtl" or "auto"');
			}
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
