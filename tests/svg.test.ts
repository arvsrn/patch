import { expect, test } from 'bun:test';
import { analyze, compile } from '../src';
import { evaluate } from '../src/design';
import { mount } from '../src/runtime/dom';
import { SVG_NS, svgSize } from '../src/schema/svg';
import { snapshotToFigma } from '../src/targets/figma';
import { install, program, settle } from './fake-dom';

const messages = (source: string) => analyze(source).diagnostics.map((d) => d.message);

const ICON = `<script>
	let n = $state(2);
	globalThis.__icon = { more: () => n++ };
</script>
<svg viewBox="0 0 24 12" width="48" style={{ color: '#2563eb' }} aria-label="Dots">
	<g fill="currentColor">
		{#each Array.from({ length: n }, (_, i) => i) as i (i)}<circle cx={4 + i * 4} cy="6" r="1.5" />{/each}
		<text x="2" y="10">Hello <tspan font-weight="bold">{n}</tspan> dots</text>
	</g>
</svg>`;

test('any SVG element and attribute is allowed inside <svg>, and nothing else', () => {
	expect(messages(ICON)).toEqual([]);
	expect(messages(`<svg><div></div><g style={{ color: '#000' }} xlink:href="#a" portal="o">loose text</g><script></script><foreignObject></foreignObject><circle onclik={() => 1} /></svg>`)).toEqual([
		'<div> cannot be inside <svg>; only SVG elements can',
		'SVG elements are styled with presentation attributes (fill, stroke, opacity, …), not style=',
		'xlink:href is not supported; SVG 2 uses href',
		'portal is not supported on SVG elements; put it on the <svg>',
		'text in an SVG element is only rendered in <text>, <tspan> or <textPath> (or read in <title> and <desc>)',
		'<script> is not supported in SVG: scripts belong in the component script',
		'<foreignObject> is not supported in SVG: HTML inside SVG is not supported',
		'"onclik" is not an event of <circle>; did you mean "onclick"?'
	]);
	// bind:this has the element's SVG type.
	expect(messages(`<script lang="ts">let el = $state<SVGCircleElement>();</script><svg><circle bind:this={el} /></svg>`)).toEqual([]);
	expect(analyze(`<script lang="ts">let el = $state<HTMLDivElement>();</script><svg><circle bind:this={el} /></svg>`).diagnostics[0].message).toContain('SVGCircleElement');
});

test('an <svg> hugs its width and height, the viewBox giving the missing one, else 300 × 150', () => {
	expect(svgSize({ width: '48', viewBox: '0 0 24 12' })).toEqual({ width: 48, height: 24 });
	expect(svgSize({ height: '10px', viewBox: '0 0 24 12' })).toEqual({ width: 20, height: 10 });
	expect(svgSize({ viewBox: '0 0 24 12' })).toEqual({ width: 24, height: 12 });
	expect(svgSize({ width: '100%' })).toEqual({ width: 300, height: 150 });
});

test('SVG renders in the SVG namespace, its text as text, and updates like any template', async () => {
	const { target } = install();
	mount(program(ICON), target as any);
	await settle();
	const svg = target.children[0];
	expect([svg.namespaceURI, svg.getAttribute('data-p'), svg.getAttribute('viewBox'), svg.css.get('--hug-w'), svg.css.get('--hug-h')]).toEqual([SVG_NS, 'svg', '0 0 24 12', '48px', '24px']);
	const g = svg.children[0];
	expect([g.namespaceURI, g.getAttribute('data-p')]).toEqual([SVG_NS, null]);
	expect(g.children.filter((c) => c.tag === 'circle')).toHaveLength(2);
	expect(g.find((el) => el.tag === 'text')!.text).toBe('Hello 2 dots');
	(globalThis as any).__icon.more();
	expect(g.children.filter((c) => c.tag === 'circle').map((c) => c.getAttribute('cx'))).toEqual(['4', '8', '12']);
});

test('an SVG-only tag can be the root of a component rendered in an <svg>, and only there', async () => {
	(globalThis as any).__Dot = program(`<script>let { x } = $props();</script><circle cx={x} r="1" />`);
	const { target } = install();
	mount(program(`<script>const Dot = globalThis.__Dot;</script><svg><Dot x={3} /></svg>`), target as any);
	await settle();
	const circle = target.children[0].children[0];
	expect([circle.tag, circle.namespaceURI, circle.getAttribute('cx')]).toEqual(['circle', SVG_NS, '3']);
	// Like any error mounting a component, it is reported and the rest renders.
	const outside = install();
	const logged: unknown[] = [];
	const error = console.error;
	console.error = (e: unknown) => logged.push(e);
	try {
		mount(program(`<script>const Dot = globalThis.__Dot;</script><div><Dot x={3} /></div>`), outside.target as any);
	} finally {
		console.error = error;
	}
	expect(String(logged[0])).toContain('<circle> is SVG and must be rendered inside an <svg> (at 1:39)');
});

test('at design time an <svg> keeps its content; Figma draws a frame of its size and says so', async () => {
	const [svg] = (await evaluate(compile(ICON, 'icon.pat'))) as any[];
	expect([svg.type, svg.size, svg.attrs['aria-label']]).toEqual(['svg', { width: 48, height: 24 }, 'Dots']);
	expect(svg.children[0]).toMatchObject({ tag: 'g', attrs: { fill: 'currentColor' } });
	expect(svg.children[0].children.at(-1)).toEqual({ tag: 'text', attrs: { x: '2', y: '10' }, children: ['Hello ', { tag: 'tspan', attrs: { 'font-weight': 'bold' }, children: ['2'] }, ' dots'] });
	const { warnings } = await snapshotToFigma([svg], 'icon', (font, text) => text.length * font.size * 0.5);
	expect(warnings).toEqual(['inline SVG is not converted to Figma vectors yet; an empty frame of its size stands in for it (at 5:1)']);
});
