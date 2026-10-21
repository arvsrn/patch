// Browser rendering: mounts a program into the DOM with fine-grained effects.
// Sizing semantics live in one fixed stylesheet keyed on data-* attributes;
// each element's own style becomes inline CSS.

import type { ElementNode, InlinePart, Program, ProgramNode, SpanNode } from '../schema/program';
import { SHORTHANDS, type ElementKind, type Style } from '../schema/style';
import { createApi, type ApiOptions } from './api';
import { eachList, elementStyle, toText, withId } from './evaluate';
import { createReactive, type Cell, type Owner } from './reactive';

const BASE_CSS = `
html,body{margin:0;padding:0}
[data-p]{box-sizing:border-box;margin:0;padding:0;border:0;outline:0;min-width:0;min-height:0;flex:0 0 auto;font:inherit;color:inherit;letter-spacing:inherit;text-align:inherit;background:none;border-radius:0;appearance:none;-webkit-appearance:none;position:relative}
[data-p=frame]{display:flex;flex-direction:column;align-items:flex-start;align-content:flex-start}
[data-dir=row]{flex-direction:row}
[data-p=input],[data-p=textarea]{display:block;resize:none;overflow:hidden}
[data-p=input]::placeholder,[data-p=textarea]::placeholder{color:currentColor;opacity:.5}
[data-p=text]{display:block;white-space:pre}
[data-p=text][data-w=fixed],[data-p=text][data-w=fill]{white-space:pre-wrap}
[data-p=inline]{display:inline}
[data-dir=row]>[data-w=fill],[data-dir=column]>[data-h=fill]{flex:1 1 0}
[data-dir=row]>[data-h=fill],[data-dir=column]>[data-w=fill]{align-self:stretch!important}
[data-dir=row]>[data-p=frame][data-w=hug]{flex-shrink:1}
button[data-p]{cursor:pointer}
[data-host]{width:100vw;height:100vh;overflow:auto;background:#fff;font-family:"Inter";font-size:16px;font-weight:400;font-style:normal;line-height:1.2;letter-spacing:0;color:#000;text-align:start}
`;
const FLEX_VALUE: Record<string, string> = { start: 'flex-start', center: 'center', end: 'flex-end', 'space-between': 'space-between' };
const px = (v: unknown) => (v === 'auto' ? 'auto' : `${v}px`);

/** A validated style as inline CSS, plus the data-* attributes the stylesheet keys sizing on. */
function toCss(kind: ElementKind, st: Style) {
	const css: Record<string, string> = {};
	const data: Record<string, string> = {
		w: typeof st.width === 'number' ? 'fixed' : (st.width ?? 'hug'),
		h: typeof st.height === 'number' ? 'fixed' : (st.height ?? 'hug')
	};
	if (kind === 'frame') data.dir = st.flexDirection ?? 'column';
	if (typeof st.width === 'number') css.width = px(st.width);
	if (typeof st.height === 'number') css.height = px(st.height);
	for (const k of ['minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'left', 'top', 'gap', 'fontSize', 'lineHeight', 'letterSpacing'])
		if (st[k] !== undefined) css[k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())] = px(st[k]);
	const box = (prefix: string) => {
		const keys = SHORTHANDS[prefix];
		if (keys.some((k) => st[k] !== undefined)) css[prefix] = keys.map((k) => px(st[k] ?? 0)).join(' ');
	};
	box('padding');
	box('margin');
	if (st.justifyContent) css['justify-content'] = FLEX_VALUE[st.justifyContent];
	if (st.alignItems) css['align-items'] = FLEX_VALUE[st.alignItems];
	if (st.alignSelf) css['align-self'] = FLEX_VALUE[st.alignSelf];
	if (st.flexWrap) css['flex-wrap'] = st.flexWrap;
	if (st.position === 'absolute') css.position = 'absolute';
	if (st.background) css['background-color'] = st.background;
	if (st.color) css.color = st.color;
	if (st.opacity !== undefined) css.opacity = String(st.opacity);
	if (st.borderWidth) {
		// Borders are drawn inside the box and never affect layout.
		css.outline = `${st.borderWidth}px solid ${st.borderColor ?? '#000000'}`;
		css['outline-offset'] = `-${st.borderWidth}px`;
	}
	if (st.borderRadius) css['border-radius'] = st.borderRadius.map(px).join(' ');
	if (st.overflow) css.overflow = st.overflow;
	if (st.shadow) css['box-shadow'] = st.shadow.map((s: any) => `${s.x}px ${s.y}px ${s.blur}px ${s.spread}px ${s.color}`).join(', ');
	if (st.fontFamily) css['font-family'] = JSON.stringify(st.fontFamily);
	if (st.fontWeight) css['font-weight'] = String(st.fontWeight);
	if (st.fontStyle) css['font-style'] = st.fontStyle;
	if (st.textAlign) css['text-align'] = st.textAlign;
	return { css, data };
}

const removeRange = (start: Node, end: Node) => {
	let node: Node | null = start;
	while (node) {
		const next: Node | null = node === end ? null : node.nextSibling;
		node.parentNode?.removeChild(node);
		node = next;
	}
};
const moveRange = (start: Node, end: Node, before: Node) => {
	let node: Node | null = start;
	while (node) {
		const next: Node | null = node === end ? null : node.nextSibling;
		before.parentNode!.insertBefore(node, before);
		node = next;
	}
};

/**
 * Mounts `program` into `target`. Returns a function that disposes it.
 * `options` start it from overridden state, without effects (snapshots).
 */
export function mount(program: Program, target: HTMLElement, options: ApiOptions = {}): () => void {
	const r = createReactive();
	const { effect, newOwner, dispose, within, untrack, batch, cell } = r;

	const bindStyle = (el: HTMLElement, d: ElementNode | SpanNode, kind: ElementKind) => {
		let prev: Record<string, string> = {};
		effect(() => {
			const { css, data } = toCss(kind, elementStyle(d, kind));
			for (const k of Object.keys(prev)) if (!(k in css)) el.style.removeProperty(k);
			for (const [k, v] of Object.entries(css)) if (prev[k] !== v) el.style.setProperty(k, v);
			for (const [k, v] of Object.entries(data)) el.setAttribute(`data-${k}`, v);
			prev = css;
		});
	};

	const setAttribute = (el: any, name: string, value: unknown) => {
		if (name === 'value') {
			const next = toText(value);
			if (el.value !== next) el.value = next;
		} else if (name === 'disabled') el.disabled = !!value;
		else el.setAttribute(name, toText(value));
	};

	const element = (d: ElementNode | SpanNode, tag: string, kind: ElementKind) => {
		const el = document.createElement(tag);
		el.setAttribute('data-p', kind);
		if (d.style || kind !== 'inline') bindStyle(el, d, kind);
		if (d.t === 'el') {
			for (const [name, value] of Object.entries(d.attrs)) effect(() => setAttribute(el, name, withId(d.id, value)));
			for (const [name, handler] of Object.entries(d.on))
				el.addEventListener(name, (event: Event) =>
					batch(() => {
						const fn = untrack(handler);
						if (typeof fn === 'function') fn(event);
						else if (fn != null) throw new Error(`on${name} must be a function (at ${d.id})`);
					})
				);
		}
		return el;
	};

	const mountInline = (parts: InlinePart[], parent: Node) => {
		for (const part of parts) {
			if (typeof part === 'string') parent.appendChild(document.createTextNode(part));
			else if (typeof part === 'function') {
				const node = document.createTextNode('');
				effect(() => (node.data = toText(part())));
				parent.appendChild(node);
			} else {
				const span = element(part, 'span', 'inline');
				mountInline(part.kids, span);
				parent.appendChild(span);
			}
		}
	};

	const mountNodes = (nodes: ProgramNode[], parent: Node, before: Node | null) => {
		for (const d of nodes) {
			if (d.t === 'text') {
				const span = document.createElement('span');
				span.setAttribute('data-p', 'text');
				span.setAttribute('data-w', 'hug');
				span.setAttribute('data-h', 'hug');
				mountInline(d.parts, span);
				parent.insertBefore(span, before);
			} else if (d.t === 'el') {
				const el = element(d, d.tag, d.kind);
				if (d.kind === 'frame') mountNodes(d.kids, el, null);
				else if (d.kind === 'text') mountInline(d.kids, el);
				parent.insertBefore(el, before);
			} else if (d.t === 'if') mountIf(d, parent, before);
			else if (d.t === 'each') mountEach(d, parent, before);
		}
	};

	// A false branch is unmounted; re-entering it creates it again.
	const mountIf = (d: Extract<ProgramNode, { t: 'if' }>, parent: Node, before: Node | null) => {
		const end = parent.insertBefore(document.createComment('/if'), before);
		const container = newOwner();
		let active = -2;
		let branch: { start: Node; owner: Owner } | null = null;
		within(container, null, () =>
			effect(() => {
				const index = withId(d.id, () => d.b.findIndex(([test]) => test()));
				if (index === active) return;
				active = index;
				untrack(() => {
					if (branch) {
						dispose(branch.owner);
						removeRange(branch.start, end.previousSibling!);
					}
					const kids = index >= 0 ? d.b[index][1] : d.e;
					if (!kids) return (branch = null);
					const start = parent.insertBefore(document.createComment('if'), end);
					const o = within(container, null, () => newOwner());
					within(o, null, () => mountNodes(kids, parent, end));
					branch = { start, owner: o };
				});
			})
		);
	};

	// Keyed list: existing keys keep their DOM and state, removed keys are
	// destroyed, new keys are created. Items are moved to match list order.
	const mountEach = (d: Extract<ProgramNode, { t: 'each' }>, parent: Node, before: Node | null) => {
		const end = parent.insertBefore(document.createComment('/each'), before);
		const container = newOwner();
		type Item = { item: Cell; index: Cell<number>; start: Node; end: Node; owner: Owner };
		let items = new Map<unknown, Item>();
		within(container, null, () =>
			effect(() => {
				const list = withId(d.id, () => eachList(d.list()));
				untrack(() => {
					const next = new Map<unknown, Item>();
					const order: Item[] = [];
					list.forEach((raw, i) => {
						const key = withId(d.id, () => d.key({ v: raw }, { v: i }));
						if (next.has(key)) throw new Error(`Duplicate each key ${JSON.stringify(key)} (at ${d.id})`);
						let entry = items.get(key);
						if (entry) {
							// Mutation is tracked per state variable, not per object: the
							// same object may have changed in place, so its row re-reads it.
							if (Object.is(entry.item.v, raw)) entry.item.notify();
							else entry.item.v = raw;
							entry.index.v = i;
						} else {
							const o = within(container, null, () => newOwner());
							const item = cell(raw);
							const index = cell(i);
							const start = parent.insertBefore(document.createComment('item'), end);
							const stop = parent.insertBefore(document.createComment('/item'), end);
							within(o, null, () => mountNodes(d.kids(item, index), parent, stop));
							entry = { item, index, start, end: stop, owner: o };
						}
						next.set(key, entry);
						order.push(entry);
					});
					for (const [key, entry] of items)
						if (!next.has(key)) {
							dispose(entry.owner);
							removeRange(entry.start, entry.end);
						}
					let cursor: Node = end;
					for (let i = order.length - 1; i >= 0; i--) {
						const entry = order[i];
						if (entry.end.nextSibling !== cursor) moveRange(entry.start, entry.end, cursor);
						cursor = entry.start;
					}
					items = next;
				});
			})
		);
	};

	const sheet = document.createElement('style');
	sheet.textContent = BASE_CSS;
	document.head.appendChild(sheet);
	target.setAttribute('data-p', 'frame');
	target.setAttribute('data-dir', 'column');
	target.setAttribute('data-host', '');
	const root = newOwner();
	const api = createApi(r, options);
	batch(() => within(root, null, () => mountNodes(program(api), target, null)));
	return () => dispose(root);
}
