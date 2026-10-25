import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { compile } from '../src';
import { evaluate } from '../src/design';
import { BUILTIN_NOT_FOUND, discoverRoutes, pageAt } from '../src/routes';
import { appLink } from '../src/runtime/navigation';
import { mount } from '../src/runtime/dom';
import { realize } from '../src/runtime/realize';
import type { Pages, Program } from '../src/schema/program';
import { matchRoute, routeInfo, parseSegment, type RouteInfo } from '../src/schema/route';

/** An app directory with these files under src/pages. */
function pagesDir(files: Record<string, string>) {
	const root = mkdtempSync(join(tmpdir(), 'pat-pages-'));
	const dir = join(root, 'src', 'pages');
	for (const [path, source] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), source);
	}
	return dir;
}

const route = (id: string): RouteInfo => routeInfo(id === '/' ? [] : id.slice(1).split('/').map((s) => parseSegment(s) as any));

test('src/pages becomes a manifest of routes in precedence order, without running any page', () => {
	const dir = pagesDir({
		'+page.pat': '<p>home</p>',
		'issues/+page.pat': '<p>issues</p>',
		'issues/[id]/+page.pat': '<p>issue</p>',
		'issues/new/+page.pat': '<p>new</p>',
		'issues/Row.pat': '<p>a component, not a route</p>',
		'settings/+page.pat': '<p>settings</p>',
		'components/Card.pat': '<p>no page below: not a route</p>'
	});
	const manifest = discoverRoutes(dir);
	expect(manifest.routes.map(({ file, ...r }) => ({ ...r, file: file.slice(dir.length) }))).toEqual([
		{ id: '/', pattern: '/', params: [], file: '/+page.pat' },
		{ id: '/issues', pattern: '/issues', params: [], file: '/issues/+page.pat' },
		{ id: '/issues/new', pattern: '/issues/new', params: [], file: '/issues/new/+page.pat' },
		{ id: '/issues/[id]', pattern: '/issues/:id', params: ['id'], file: '/issues/[id]/+page.pat' },
		{ id: '/settings', pattern: '/settings', params: [], file: '/settings/+page.pat' }
	]);
	expect(manifest.notFound).toBe(BUILTIN_NOT_FOUND);
	expect(discoverRoutes(pagesDir({ '+page.pat': '', '+404.pat': '' })).notFound).toEndWith('/src/pages/+404.pat');
});

test('ambiguous and unsupported routes fail discovery, listing every problem', () => {
	const error = (files: Record<string, string>) => {
		try {
			discoverRoutes(pagesDir(files));
		} catch (e) {
			return (e as Error).message;
		}
		throw new Error('expected discovery to fail');
	};
	const conflict = error({ 'issues/[id]/+page.pat': '', 'issues/[slug]/+page.pat': '' });
	expect(conflict).toContain('/issues/[id] (src/pages/issues/[id]/+page.pat) and /issues/[slug] (src/pages/issues/[slug]/+page.pat) match the same URLs');
	const unsupported = error({
		'[...rest]/+page.pat': '',
		'[[opt]]/+page.pat': '',
		'a[b]/+page.pat': '',
		'[id]/x/[id]/+page.pat': '',
		'+layout.pat': '',
		'nested/+404.pat': '',
		'nested/+page.pat': ''
	});
	expect(unsupported.split('\n').slice(1).map((l) => l.trim())).toEqual([
		'src/pages/+layout.pat: only +page.pat and src/pages/+404.pat are supported (no layouts, loaders or other + files)',
		'src/pages/[...rest]: catch-all segments are not supported ("[...rest]")',
		'src/pages/[[opt]]: optional segments are not supported ("[[opt]]")',
		'src/pages/[id]/x/[id]/+page.pat: the param [id] appears twice in /[id]/x/[id]',
		'src/pages/a[b]: "a[b]": a param is a whole directory named [name], with a name made of letters, digits and _',
		'src/pages/nested/+404.pat: +404.pat is only supported directly in src/pages'
	]);
	expect(error({ 'Card.pat': '' })).toContain('no pages: add src/pages/+page.pat');
});

test('matching: root, statics, decoded params, static over param, and nothing else', () => {
	const routes = ['/', '/issues', '/issues/[id]', '/issues/new', '/[team]/board', '/a/[x]', '/[y]/b'].map(route);
	const match = (path: string) => {
		const m = matchRoute(routes, path);
		return m && [m.route.id, m.params];
	};
	expect(match('/')).toEqual(['/', {}]);
	expect(match('/issues')).toEqual(['/issues', {}]);
	expect(match('/issues/')).toEqual(['/issues', {}]);
	expect(match('/issues/123')).toEqual(['/issues/[id]', { id: '123' }]);
	expect(match('/issues/new')).toEqual(['/issues/new', {}]);
	expect(match('/issues/a%20b%2Fc%E2%9C%93')).toEqual(['/issues/[id]', { id: 'a b/c✓' }]);
	expect(match('/eng/board')).toEqual(['/[team]/board', { team: 'eng' }]);
	// Both match; the first segment decides.
	expect(match('/a/b')).toEqual(['/a/[x]', { x: 'b' }]);
	for (const path of ['/nope', '/issues/1/2', '/issues//', '/issues/%E0%A4%A']) expect(match(path)).toBeNull();
});

test('a link is the app\'s only for a plain left click on a same-origin URL one of its routes matches', () => {
	const current = new URL('http://app.test/issues?q=1');
	const owns = (url: URL) => matchRoute([route('/issues'), route('/issues/[id]')], url.pathname) !== null;
	const click = { defaultPrevented: false, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
	const anchor = (attrs: Record<string, string>) => ({ getAttribute: (n: string) => attrs[n] ?? null, hasAttribute: (n: string) => n in attrs });
	const link = (attrs: Record<string, string>, event = {}) => appLink({ ...click, ...event }, anchor(attrs), current, owns)?.href ?? null;

	expect(link({ href: '/issues/7' })).toBe('http://app.test/issues/7');
	expect(link({ href: 'issues/7?x=1' })).toBe('http://app.test/issues/7?x=1');
	expect(link({ href: '/issues/7', target: '_self' })).toBe('http://app.test/issues/7');
	for (const attrs of <Record<string, string>[]>[
		{ href: 'https://example.com/issues/7' },
		{ href: 'mailto:a@b.c' },
		{ href: '/issues/7', target: '_blank' },
		{ href: '/issues/7', download: '' },
		{ href: '/issues/7', rel: 'noopener external' },
		{ href: '/elsewhere' },
		{ href: '#top' },
		{}
	])
		expect(link(attrs)).toBeNull();
	for (const event of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { defaultPrevented: true }])
		expect(link({ href: '/issues/7' }, event)).toBeNull();
});

// ---------------------------------------------------------------- mounting

/** A document just big enough for the DOM renderer. */
class FakeNode {
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
class FakeText extends FakeNode {
	constructor(public data: string) {
		super();
	}
}
class FakeElement extends FakeNode {
	childNodes: FakeNode[] = [];
	attributes = new Map<string, string>();
	listeners = new Map<string, Set<(event: any) => void>>();
	style = { position: '', setProperty() {}, removeProperty() {} };
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
function fakeWindow(href: string) {
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

function install(win?: ReturnType<typeof fakeWindow>) {
	const doc = {
		head: new FakeElement('head'),
		createElement: (tag: string) => new FakeElement(tag),
		createComment: () => new FakeNode(),
		createTextNode: (data: string) => new FakeText(data)
	};
	const log: string[] = [];
	Object.assign(globalThis, { document: doc, window: win, __log: log });
	return { target: new FakeElement('div'), log };
}

const program = (source: string): Program => new Function(`return (${compile(source, 'page.pat').module.replace(/^export default /m, '')})`)();

const LIST = program(`<script>
	import { page } from 'patch';
	$effect(() => { __log.push('list sees ' + page.url.pathname); return () => __log.push('list destroyed'); });
</script>
<p>list</p><a href="/issues/1"><span>one</span></a><a href="https://example.com/issues/1">out</a>`);
const ISSUE = program(`<script>
	import { page, goto } from 'patch';
	let instance = $state(++globalThis.__instances);
	$effect(() => () => __log.push('issue destroyed'));
</script>
<p>{page.route.id} id={page.params.id} q={page.url.searchParams.get('q')} #{instance}</p>
<button onclick={() => goto('/issues')}>back</button>`);
const NOT_FOUND = program(`<script>import { page } from 'patch';</script><p>missing {page.url.pathname} {String(page.route.id)}</p>`);
const pages: Pages = {
	routes: [
		{ ...route('/issues'), program: LIST },
		{ ...route('/issues/[id]'), program: ISSUE }
	],
	notFound: NOT_FOUND
};

/** Lets queued effects and sizing run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const click = (target: FakeElement, on: FakeElement, event: Record<string, unknown> = {}) => {
	const e = { target: on, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false, preventDefault() { e.defaultPrevented = true; }, ...event };
	for (const fn of target.listeners.get('click') ?? []) fn(e);
	return e;
};

test('links and goto navigate through history; another route replaces the page, the same route keeps it', async () => {
	(globalThis as any).__instances = 0;
	const win = fakeWindow('http://app.test/issues');
	const { target, log } = install(win);
	const dispose = mount(pages, target as any);
	await settle();
	expect(target.text).toBe('listoneout');
	expect(log).toEqual(['list sees /issues']);

	// A plain click on an internal link: no browser navigation, a history entry, the new page.
	const span = target.find((el) => el.tag === 'span' && el.text === 'one')!;
	expect(click(target, span).defaultPrevented).toBe(true);
	await settle();
	expect(win.pushes).toEqual(['http://app.test/issues/1']);
	expect(target.text).toBe('/issues/[id] id=1 q= #1back');
	// The list's effects were cleaned up and it no longer follows the location.
	expect(log).toEqual(['list sees /issues', 'list destroyed']);

	// Params and query change on the same route: the page instance stays and reads the new location.
	(target.find((el) => el.tag === 'button')!.listeners.get('click')!.values().next().value as any)({});
	await settle();
	expect(win.pushes.at(-1)).toBe('http://app.test/issues');
	expect(target.text).toBe('listoneout');
	win.go(-1);
	await settle();
	expect(target.text).toBe('/issues/[id] id=1 q= #2back');
	win.go(1);
	win.go(-1);
	await settle();
	expect(win.pushes).toHaveLength(2);

	// Popstate within one route.
	win.location.href = 'http://app.test/issues/a%20b?q=x';
	for (const fn of win.listeners) fn();
	await settle();
	expect(target.text).toBe('/issues/[id] id=a b q=x #3back');

	// Clicks the app leaves alone.
	win.go(-1);
	await settle();
	const before = win.pushes.length;
	const external = target.find((el) => el.tag === 'a' && el.text === 'out')!;
	expect(click(target, external).defaultPrevented).toBe(false);
	expect(click(target, span.parentNode!, { metaKey: true }).defaultPrevented).toBe(false);
	expect(win.pushes.length).toBe(before);

	// Disposing removes the app's listeners and destroys the page.
	dispose();
	expect(target.listeners.get('click')!.size).toBe(0);
	expect(win.listeners.size).toBe(0);
	expect(log.at(-1)).toBe('list destroyed');
});

test('an unknown URL renders the not-found page, never another route', async () => {
	const { target } = install(fakeWindow('http://app.test/nope'));
	mount(pages, target as any);
	await settle();
	expect(target.text).toBe('missing /nope null');
});

test('an explicit URL is used without a browser, and overrides apply only to the first page', async () => {
	(globalThis as any).__instances = 0;
	const { target } = install(undefined);
	mount(pages, target as any, { url: '/issues/7?q=open', overrides: { instance: 42 } });
	await settle();
	expect(target.text).toBe('/issues/[id] id=7 q=open #42back');
	(target.find((el) => el.tag === 'button')!.listeners.get('click')!.values().next().value as any)({});
	click(target, target.find((el) => el.tag === 'a' && el.text === 'one')!);
	await settle();
	expect(target.text).toBe('/issues/[id] id=1 q= #1back');
});

test('design time evaluates the page a URL selects, at that location', async () => {
	const dir = pagesDir({
		'+page.pat': '<p>home</p>',
		'issues/[id]/+page.pat': `<script lang="ts">\n\timport { page } from 'patch';\n\tlet open = $state(false);\n</script>\n<p>{page.route.id} {page.params.id} {page.url.searchParams.get('tab')} {open}</p>\n`
	});
	const manifest = discoverRoutes(dir);
	const runs = async (url: string, overrides = {}) => {
		const { file, location } = pageAt(manifest, url);
		const tree = (await evaluate(compile(await Bun.file(file).text(), file), overrides, location)) as any[];
		return JSON.stringify(tree).match(/"text":"([^"]*)"/g)!.map((t) => t.slice(8, -1)).join('');
	};
	expect(await runs('/issues/a%20b?tab=activity', { open: true })).toBe('/issues/[id] a b activity true');
	expect(await runs('/')).toBe('home');
	expect(await runs('/missing')).toContain('No page at /missing');
	expect(() => realize(program(`<script>import { page } from 'patch';</script><p>{page.url}</p>`))).toThrow('page is only available in an app with pages');
});
