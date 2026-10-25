// A document just big enough for the DOM renderer, and a browser window over
// an in-memory history, for mounting apps in tests.

import { afterEach } from 'bun:test';
import { compile } from '../src';
import type { Program } from '../src/schema/program';

/** A document just big enough for the DOM renderer. */
export class FakeNode {
	parentNode: FakeElement | null = null;
	get nextSibling(): FakeNode | null {
		const kids = this.parentNode?.childNodes;
		return kids?.[kids.indexOf(this) + 1] ?? null;
	}
	get previousSibling(): FakeNode | null {
		const kids = this.parentNode?.childNodes;
		return kids?.[kids.indexOf(this) - 1] ?? null;
	}
	remove() {
		this.parentNode?.removeChild(this);
	}
}
export class FakeText extends FakeNode {
	constructor(public data: string) {
		super();
	}
}
export class FakeElement extends FakeNode {
	childNodes: FakeNode[] = [];
	attributes = new Map<string, string>();
	listeners = new Map<string, Set<(event: any) => void>>();
	style = { position: '', setProperty() {}, removeProperty() {} };
	scrollTop = 0;
	scrollLeft = 0;
	scrolledIntoView = 0;
	scrollIntoView() {
		this.scrolledIntoView++;
	}
	constructor(public tag: string) {
		super();
	}
	get children() {
		return this.childNodes.filter((n) => n instanceof FakeElement);
	}
	insertBefore(node: FakeNode, before: FakeNode | null) {
		node.parentNode?.removeChild(node);
		const at = before ? this.childNodes.indexOf(before) : this.childNodes.length;
		this.childNodes.splice(at, 0, node);
		node.parentNode = this;
		return node;
	}
	appendChild(node: FakeNode) {
		return this.insertBefore(node, null);
	}
	removeChild(node: FakeNode) {
		this.childNodes.splice(this.childNodes.indexOf(node), 1);
		node.parentNode = null;
		return node;
	}
	setAttribute(name: string, value: string) {
		this.attributes.set(name, value);
	}
	getAttribute(name: string) {
		return this.attributes.get(name) ?? null;
	}
	hasAttribute(name: string) {
		return this.attributes.has(name);
	}
	removeAttribute(name: string) {
		this.attributes.delete(name);
	}
	addEventListener(type: string, fn: (event: any) => void) {
		if (!this.listeners.has(type)) this.listeners.set(type, new Set());
		this.listeners.get(type)!.add(fn);
	}
	removeEventListener(type: string, fn: (event: any) => void) {
		this.listeners.get(type)?.delete(fn);
	}
	closest(tag: string): FakeElement | null {
		for (let el: FakeElement | null = this; el; el = el.parentNode) if (el.tag === tag) return el;
		return null;
	}
	contains(node: FakeNode) {
		for (let n: FakeNode | null = node; n; n = n.parentNode) if (n === this) return true;
		return false;
	}
	get text(): string {
		return this.childNodes.map((n) => (n instanceof FakeText ? n.data : n instanceof FakeElement ? n.text : '')).join('');
	}
	find(test: (el: FakeElement) => boolean): FakeElement | null {
		for (const kid of this.children) {
			if (test(kid)) return kid;
			const found = kid.find(test);
			if (found) return found;
		}
		return null;
	}
}

/** A browser window over an in-memory history. */
export function fakeWindow(href: string) {
	const listeners = new Set<() => void>();
	const entries = [href];
	let index = 0;
	const win = {
		location: { href },
		pushes: [] as string[],
		listeners,
		history: {
			pushState(_: unknown, __: string, url: string) {
				win.pushes.push(url);
				entries.splice(++index, entries.length, url);
				win.location.href = url;
			}
		},
		addEventListener: (_: 'popstate', fn: () => void) => listeners.add(fn),
		removeEventListener: (_: 'popstate', fn: () => void) => listeners.delete(fn),
		/** Back (-1) or forward (1), as the browser does it: the location moves, then popstate. */
		go(delta: number) {
			index += delta;
			win.location.href = entries[index];
			for (const fn of [...listeners]) fn();
		}
	};
	return win;
}

const saved = { document: (globalThis as any).document, window: (globalThis as any).window, log: (globalThis as any).__log };
afterEach(() => Object.assign(globalThis, { document: saved.document, window: saved.window, __log: saved.log }));

export function install(win?: ReturnType<typeof fakeWindow>) {
	const target = new FakeElement('div');
	const doc = {
		head: new FakeElement('head'),
		getElementById: (id: string) => target.find((el) => el.getAttribute('id') === id),
		createElement: (tag: string) => new FakeElement(tag),
		createComment: () => new FakeNode(),
		createTextNode: (data: string) => new FakeText(data)
	};
	const log: string[] = [];
	Object.assign(globalThis, { document: doc, window: win, __log: log });
	return { target, log };
}

/** Lets queued effects and sizing run. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
export const click = (target: FakeElement, on: FakeElement, event: Record<string, unknown> = {}) => {
	const e = { target: on, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false, preventDefault() { e.defaultPrevented = true; }, ...event };
	for (const fn of target.listeners.get('click') ?? []) fn(e);
	return e;
};

/** A compiled .pat source without imports, as a program. */
export const program = (source: string, filename = 'page.pat'): Program => new Function(`return (${compile(source, filename).module.replace(/^export default /m, '')})`)();
