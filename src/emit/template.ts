// IR template → the program description (see schema/program.ts) as JS
// source. Expressions are the author's text with the script edits applied;
// dynamic parts become closures.

import type { Estree } from '../ast';
import type { Each, Element, If, Inline, TemplateNode } from '../ir';
import type { Edits } from './edits';

const str = JSON.stringify;
const record = (entries: [string, string][]) => `{${entries.map(([k, v]) => `${str(k)}: ${v}`).join(',')}}`;

export class TemplateEmitter {
	constructor(
		private edits: Edits,
		/** `line:column` of an offset: node ids. */
		private id: (offset: number) => string,
		/** How a top-level variable is read and written: `name.v` for state, else `name`. */
		private variable: (node: Estree) => string
	) {}

	private expression(node: Estree) {
		return this.edits.render(node.start, node.end);
	}
	private getter(node: Estree) {
		return `() => (${this.expression(node)})`;
	}

	nodes(nodes: TemplateNode[]): string[] {
		return nodes.map((node) => {
			if (node.type === 'text') return `{t:"text",id:${str(this.id(node.span.start))},parts:[${this.inline(node.content)}]}`;
			if (node.type === 'element') return this.element(node);
			if (node.type === 'if') return this.ifBlock(node);
			if (node.type === 'portal') return `{t:"portal",id:${str(this.id(node.span.start))},name:${str(node.name)}}`;
			return this.eachBlock(node);
		});
	}

	private element(node: Element) {
		const attrs: [string, string][] = [];
		const on: [string, string][] = [];
		let ref = 'null';
		let portal = 'null';
		let anchorName = 'null';
		for (const a of node.attributes) {
			if (a.type === 'event') on.push([a.name, this.getter(a.handler)]);
			else if (a.type === 'attribute' && a.name === 'portal') portal = `() => (${this.attributeValue(a.value)})`;
			else if (a.type === 'attribute' && a.name === 'anchorName') anchorName = `() => (${this.attributeValue(a.value)})`;
			else if (a.type === 'bind' && a.name === 'this') {
				const target = this.variable(a.expression);
				ref = `{get: () => (${target}), set: (node) => { ${target} = node }}`;
			} else if (a.type === 'bind') {
				const name = a.expression.name;
				attrs.push(['value', `() => (${name}.v)`]);
				on.push(['input', `() => (event) => { ${name}.v = event.currentTarget.value }`]);
			} else attrs.push([a.name, `() => (${this.attributeValue(a.value)})`]);
		}
		const kids = node.kind === 'frame' ? this.nodes(node.children).join(',') : node.kind === 'text' ? this.inline(node.content) : '';
		const style = node.style ? this.getter(node.style) : 'null';
		return `{t:"el",tag:${str(node.tag)},kind:"${node.kind}",id:${str(this.id(node.span.start))},style:${style},attrs:${record(attrs)},on:${record(on)},ref:${ref},portal:${portal},anchorName:${anchorName},kids:[${kids}]}`;
	}

	private attributeValue(value: Extract<Element['attributes'][number], { type: 'attribute' }>['value']) {
		if (value === true) return 'true';
		if ('expression' in value) return this.expression(value.expression);
		return value.parts.map((part) => (typeof part === 'string' ? str(part) : `String((${this.expression(part)}) ?? "")`)).join(' + ') || '""';
	}

	private inline(content: Inline[]): string {
		return content
			.map((part) => {
				if (part.type === 'static') return str(part.value);
				if (part.type === 'expression') return this.getter(part.expression);
				const style = part.style ? this.getter(part.style) : 'null';
				return `{t:"span",id:${str(this.id(part.span.start))},style:${style},kids:[${this.inline(part.content)}]}`;
			})
			.join(',');
	}

	private ifBlock(node: If) {
		const branches = node.branches.map((b) => `[${this.getter(b.test)}, [${this.nodes(b.body).join(',')}]]`);
		const otherwise = node.otherwise ? `[${this.nodes(node.otherwise).join(',')}]` : 'null';
		return `{t:"if",id:${str(this.id(node.span.start))},b:[${branches.join(',')}],e:${otherwise}}`;
	}

	private eachBlock(node: Each) {
		const params = `(${node.item.name}, ${node.index ?? '$$i'})`;
		const key = node.key ? this.expression(node.key) : 'null';
		return `{t:"each",id:${str(this.id(node.span.start))},list:${this.getter(node.list)},key:${params} => (${key}),kids:${params} => [${this.nodes(node.body).join(',')}]}`;
	}
}
