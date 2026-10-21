import { expect, test } from 'bun:test';
import { analyze } from '../src';
import { bind } from '../src/bind';
import { Reporter } from '../src/diagnostics';
import { lower } from '../src/lower';
import { parse } from '../src/parse';

const messages = (source: string) => analyze(source).diagnostics.map((d) => d.message);

const ir = (source: string) => {
	const reporter = new Reporter(source);
	const component = lower(parse(source, reporter)!, source, reporter);
	return { component, diagnostics: reporter.diagnostics.map((d) => d.message) };
};

test('lowering normalizes svelte syntax into the IR', () => {
	const { component, diagnostics } = ir(
		`<main>\n  <p title="x">  hello <span style={s}>  {name} </span>  </p>\n  {#if a}<div></div>{:else if b}<div></div>{:else}<div></div>{/if}\n  {#each list as item, i (item.id)}<input bind:value={draft} type="text" />{/each}\n</main>`
	);
	expect(diagnostics).toEqual(['attribute "title" is not supported on <p>']);
	const [main] = component.template as any[];
	expect(main).toMatchObject({ type: 'element', tag: 'main', kind: 'frame' });
	const [p, ifBlock, each] = main.children;
	// Whitespace is collapsed and trimmed across the nested span.
	expect(p.content.map((c: any) => c.type)).toEqual(['static', 'span']);
	expect(p.content[0].value).toBe('hello ');
	expect(p.content[1].content.map((c: any) => c.type)).toEqual(['expression']);
	// `{:else if}` chains flatten into branches.
	expect(ifBlock.branches).toHaveLength(2);
	expect(ifBlock.otherwise).toHaveLength(1);
	expect(each).toMatchObject({ type: 'each', index: 'i' });
	expect(each.item.name).toBe('item');
	expect(each.body[0].attributes.map((a: any) => a.type)).toEqual(['bind', 'attribute']);
});

test('lowering classifies top-level runes', () => {
	const { component } = ir(`<script>let a = $state(1); let b = $derived(a * 2); let c = $derived.by(() => a); const s = $style({ gap: 1 }); $effect(() => {}); import x from './x.ts';</script>`);
	const script = component.script!;
	expect(script.state.map((d) => d.info)).toMatchObject([{ id: 'a', defaultValue: 1 }]);
	expect(script.derived.map((d) => [d.id.name, d.by])).toEqual([['b', false], ['c', true]]);
	expect(script.styles.map((d) => d.id.name)).toEqual(['s']);
	expect(script.effects).toHaveLength(1);
	expect(script.imports).toHaveLength(1);
	expect(script.runes.size).toBe(4);
});

test('binding resolves through scopes, shadowing and each items', () => {
	const { component } = ir(`<script>let n = $state(0); function f(n) { return n; } const g = () => n;</script>{#each items as n (n)}<p>{n}</p>{/each}<p>{n}</p>`);
	const kinds = bind(component).references.filter((r) => r.node.name === 'n').map((r) => r.symbol?.kind);
	// f's parameter, g's closure, the each key and body, the template outside the each.
	expect(kinds).toEqual(['local', 'state', 'item', 'item', 'state']);
});

test('every problem in a statement is reported, not just the first', () => {
	expect(messages(`<script>let a = $state([1]); let d = $derived(a); function f() { d = a.push(1); }</script><p>x</p>`)).toEqual([
		'"d" is $derived and read-only',
		'.push() mutates reactive "a" in place, which is not tracked; assign a new array instead'
	]);
	expect(messages(`<div style={['gap: 4px', { zIndex: 1 }]}></div>`)).toEqual([
		'CSS strings are not supported; use an object or $style({...})',
		'Unsupported style property "zIndex"'
	]);
});

test('the contents of unsupported constructs are still checked', () => {
	expect(messages(`<section><p style={{ padding: 1 }}>x</p><img /></section>`)).toEqual([
		'<section> is not supported (use main, div, button, p, span, input, textarea)',
		'"padding" is not supported on text elements (<p>, <span>); wrap the text in a <div> for boxes, padding and backgrounds',
		'<img> is not supported (use main, div, button, p, span, input, textarea)'
	]);
	expect(messages(`{#each [1] as [a] (a)}<div class="x"></div>{/each}`)).toEqual([
		'{#each} needs `as item` with a plain identifier',
		'class= is not supported; use style={...}'
	]);
});

test('diagnostics are in source order', () => {
	const diagnostics = analyze(`<script>const s = $style({ zIndex: 1 })</script><div class="a"></div><p style={{ gap: 1 }}>x</p>`).diagnostics;
	expect(diagnostics.map((d) => d.start)).toEqual([...diagnostics.map((d) => d.start)].sort((a, b) => a - b));
	expect(diagnostics).toHaveLength(3);
});
