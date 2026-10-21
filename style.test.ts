import { expect, test } from 'bun:test';
import { analyze, compile, complete } from './compiler';
import { renderRunic } from './runic-adapter';
import { createRuntime } from './runtime';

const messages = (source: string) => analyze(source).diagnostics.map((d) => `${d.line}:${d.column} ${d.message}`);
const labels = (doc: string) => complete(doc.replace('|', ''), doc.indexOf('|')).map((c) => c.label).sort();
const legal = (kind: string) => createRuntime({}, true).styleProperties(kind).map((p) => p.name).sort();
const SPAN = '"padding" is not supported on nested <span>s inside text; only typography is allowed there';

test('direct, inline and reusable styles get the same compile-time validation, once', () => {
	expect(messages(`<p>a <span style={{ padding: 4 }}>b</span></p>`)).toEqual([`1:21 ${SPAN}`]);
	expect(messages(`<p>a <span style={$style({ padding: 4 })}>b</span></p>`)).toEqual([`1:28 ${SPAN}`]);
	const reusable = `<script>const foo = $style({ padding: 4 })</script><p>a <span style={foo}>b</span> <span style={[foo]}>c</span></p>`;
	expect(messages(reusable)).toEqual([`1:30 ${SPAN}`]);
	expect(messages(`<input style={{ width: 'fill', gap: 4 }} />`)).toEqual(['1:32 "gap" is not supported on <input>']);
});

test('shared styles are checked against every element that uses them', () => {
	expect(messages(`<script>const t = $style({ color: '#111111', fontSize: 14 })</script><div style={t}><p style={t}>a <span style={t}>b</span></p></div>`)).toEqual([]);
	expect(messages(`<script>const t = $style({ padding: 4 })</script><div style={t}><p style={t}>a</p></div>`)).toEqual([
		'1:28 "padding" is not supported on text elements (<p>, <span>); wrap the text in a <div> for boxes, padding and backgrounds'
	]);
});

test('a direct style object compiles to the same code as $style(...)', () => {
	const strip = (module: string) => module.replace(/id: "[^"]*"/g, '');
	const direct = compile(`<script>let d = $state(false)</script><div style={[{ gap: 4 }, d && { opacity: 0.5 }]}><p style={{ color: '#111111' }}>x</p></div>`);
	const explicit = compile(`<script>let d = $state(false)</script><div style={[$style({ gap: 4 }), d && $style({ opacity: 0.5 })]}><p style={$style({ color: '#111111' })}>x</p></div>`);
	expect(strip(direct.module)).toBe(strip(explicit.module));
	expect(direct.module).toContain('style: () => [$$rt.style({ gap: 4 }), d.v && $$rt.style({ opacity: 0.5 })]');
});

test('direct and explicit forms render the same in the browser and in Runic', async () => {
	const app = (s: (style: string) => string) =>
		`<script lang="ts">let off = $state(true)</script><main style={${s(`{ padding: 8, background: '#181818', gap: 4 }`)}}><div style={[${s(`{ width: 40, height: 20 }`)}, ${s(`{ opacity: off ? 0.5 : 1 }`)}]}></div><p style={${s(`{ color: '#ffffff' }`)}}>hi</p></main>`;
	const direct = compile(app((o) => o), 'direct.pat');
	const explicit = compile(app((o) => `$style(${o})`), 'direct.pat');

	// Node ids are source positions, which the extra `$style(` text shifts.
	const runic = async (c: typeof direct, state = {}) => JSON.stringify(await renderRunic(c, { state })).replace(/n:\d+:\d+/g, 'n');
	expect(await runic(direct)).toBe(await runic(explicit));
	expect(await runic(direct, { off: false })).toBe(await runic(explicit, { off: false }));
	expect(await runic(direct)).toContain('"transparency":50');

	// The same DOM, via a minimal document stand-in for mount().
	const dom = (c: typeof direct) => {
		const created: any[] = [];
		const node = (tag: string): any => ({
			tag, attrs: {} as Record<string, string>, style: {} as Record<string, string>, children: [] as any[],
			setAttribute(k: string, v: string) { this.attrs[k] = v; },
			appendChild(n: any) { this.children.push(n); return n; },
			insertBefore(n: any) { this.children.push(n); return n; },
			addEventListener() {}
		});
		const doc: any = { head: node('head'), createElement: (t: string) => { const n = node(t); n.style = { setProperty(k: string, v: string) { n.css[k] = v; }, removeProperty() {} }; n.css = {}; created.push(n); return n; }, createTextNode: (data: string) => ({ data }), createComment: () => ({}) };
		const previous = (globalThis as any).document;
		(globalThis as any).document = doc;
		try {
			const program = new Function(`return (${c.module.replace(/^export default /m, '')})`)();
			createRuntime().mount(program, node('div'));
		} finally {
			(globalThis as any).document = previous;
		}
		return JSON.stringify(created.map((n) => [n.tag, n.css, n.attrs]));
	};
	expect(dom(direct)).toBe(dom(explicit));
	expect(dom(direct)).toContain('"background-color":"#181818"');
});

test('direct style objects get element-specific completion', () => {
	expect(labels(`<p>a <span style={{\n  |\n}}>b</span></p>`)).toEqual(legal('inline'));
	expect(labels(`<input style={{\n  |\n}} />`)).toEqual(legal('input'));
	expect(labels(`<div style={[{ gap: 4 }, { | }]}></div>`)).toEqual(legal('frame'));
	expect(labels(`<p>a <span style={$style({ | })}>b</span></p>`)).toEqual(legal('inline'));
	expect(labels(`<script>const s = $style({ | })</script><p>a <span style={s}>b</span></p>`)).toEqual(legal('inline'));
	expect(labels(`<script>const s = $style({ | })</script>`)).toEqual(legal('frame'));
});
