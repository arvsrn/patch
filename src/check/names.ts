// App-wide names: portal ids. A name links two places in the app that may be
// far apart, so these checks see the whole app at once:
// names that cannot resolve, declarations that can be rendered twice at the
// same time, and an element that would render into itself.

import { literal, NOT_STATIC } from '../ast';
import type { Reporter, Span } from '../diagnostics';
import type { AttributeValue, If, TemplateNode } from '../ir';

/**
 * Where a node sits: the `{#if}` branches leading to it, and whether a
 * `{#each}` repeats it in every item (no `{#if}` in between).
 */
type Site = { branches: [If, number][]; repeated: boolean };

/** A name declared once in the template, by `<portal id>`. */
type Declaration = { name: string; span: Span; site: Site };

/** `"name"` or `{"name"}`: the string, null when it is computed, or true for a bare attribute. */
function staticValue(value: AttributeValue): string | null | true {
	if (value === true) return true;
	if ('expression' in value) {
		const v = literal(value.expression);
		return v !== NOT_STATIC && typeof v === 'string' ? v : null;
	}
	return value.parts.every((p) => typeof p === 'string') ? value.parts.join('') : null;
}

/** Two sites that are never rendered together: different branches of the same `{#if}`. */
const exclusive = (a: Site, b: Site) => a.branches.some(([node, i]) => b.branches.some(([other, j]) => node === other && i !== j));

function duplicates(declarations: Declaration[], describe: (name: string) => string, reporter: Reporter) {
	declarations.forEach((d, i) => {
		if (declarations.slice(0, i).some((e) => e.name === d.name && !exclusive(d.site, e.site)))
			reporter.report(d.span, `duplicate ${describe(d.name)}: another one can be rendered at the same time`);
	});
}

export function checkNames(template: TemplateNode[], reporter: Reporter) {
	const portals: Declaration[] = [];
	const portalUses: { name: string; span: Span }[] = [];

	// `into`: static portal names of the enclosing elements.
	const walk = (nodes: TemplateNode[], site: Site, into: string[]) => {
		for (const node of nodes) {
			if (node.type === 'portal') {
				portals.push({ name: node.name, span: node.nameSpan, site });
				if (site.repeated) reporter.report(node.nameSpan, `<portal id="${node.name}"> cannot be repeated by {#each}: it would be declared once per item`);
				if (into.includes(node.name)) reporter.report(node.nameSpan, `<portal id="${node.name}"> is inside an element that renders into it`);
			} else if (node.type === 'element') {
				let inner = into;
				for (const a of node.attributes) {
					if (a.type !== 'attribute' || a.name !== 'portal') continue;
					const name = staticValue(a.value);
					if (name === true || name === '') reporter.report(a.nameSpan, 'portal needs a name: portal="name"');
					else if (name !== null) {
						portalUses.push({ name, span: a.span });
						inner = [...into, name];
					}
				}
				if (node.kind === 'frame') walk(node.children, site, inner);
			} else if (node.type === 'if') {
				node.branches.forEach((b, i) => walk(b.body, { repeated: false, branches: [...site.branches, [node, i]] }, into));
				if (node.otherwise) walk(node.otherwise, { repeated: false, branches: [...site.branches, [node, node.branches.length]] }, into);
			} else if (node.type === 'each') walk(node.body, { ...site, repeated: true }, into);
		}
	};
	walk(template, { branches: [], repeated: false }, []);

	duplicates(portals, (name) => `<portal id="${name}">`, reporter);
	const declaredPortals = new Set(portals.map((p) => p.name));
	for (const use of portalUses) if (!declaredPortals.has(use.name)) reporter.report(use.span, `no <portal id="${use.name}"> in the app`);
}
