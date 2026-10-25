import { expect, test } from 'bun:test';
import { analyze } from '../src';
import { mount } from '../src/runtime/dom';
import { install, program, settle } from './fake-dom';

const messages = (source: string) => analyze(source).diagnostics.map((d) => `${d.severity}: ${d.message}`);

test('global, ARIA, data and form attributes are accepted, and their static values checked', () => {
	expect(
		messages(`<div id="main" title="Main" role="region" tabindex="0" lang="en" dir="ltr" aria-label="Main" aria-labelledby="t" data-testid="x"></div>
<input style={{ width: 100 }} name="q" autocomplete="off" readonly required minlength="2" maxlength="20" autofocus spellcheck="false" inputmode="search" enterkeyhint="go" />
<textarea style={{ width: 100, height: 40 }} name="body" required></textarea>`)
	).toEqual([]);
	expect(
		messages(`<div aria-lable="x" data-Test="1" data-p="1" role="buton" tabindex="first" dir="up"></div><div tabindex="3"></div><div class="x" name="n"></div>`)
	).toEqual([
		'error: "aria-lable" is not an ARIA attribute; did you mean "aria-label"?',
		'error: "data-Test": a data attribute is named data- and lowercase letters, digits, ".", "_" and "-"',
		"error: data-p is used by Patch's renderer; choose another name",
		'error: role must be ARIA roles; "buton" is not one',
		'error: tabindex must be an integer: 0 to be reachable from the keyboard in document order, -1 to be focusable only by code',
		'error: dir must be "ltr", "rtl" or "auto"',
		'warning: a positive tabindex moves the element ahead of the whole page in keyboard order; use 0 and order the template instead',
		'error: class= is not supported; use style={...}',
		'error: attribute "name" is not supported on <div>'
	]);
});

test('a static id is unique among what can render at the same time', () => {
	expect(messages(`<script>let a = $state(true);</script>{#if a}<div id="x"></div>{:else}<div id="x"></div>{/if}`)).toEqual([]);
	expect(messages(`<div id="x"></div><div id="x"></div><div id="has space"></div>`)).toEqual([
		'error: duplicate id="x": another element with it can be rendered at the same time',
		'error: id needs a value without spaces: id="name"'
	]);
	expect(messages(`{#each [1, 2] as n (n)}<div id="row"></div><div id="row-{n}"></div>{/each}`)).toEqual([
		'error: id="row" is repeated by {#each}, once per item; make it unique per item: id="row-{item.id}"'
	]);
});

test('ARIA, data and spellcheck values are strings; other booleans are presence', async () => {
	const { target } = install();
	mount(program(`<button aria-expanded={false} aria-pressed={true} data-open={false} title={false} disabled={false}>x</button><input style={{ width: 100 }} required={true} readonly={false} spellcheck={false} />`), target as any);
	await settle();
	const [button, input] = target.children;
	expect(Object.fromEntries(button.attributes)).toMatchObject({ 'aria-expanded': 'false', 'aria-pressed': 'true', 'data-open': 'false' });
	expect(button.hasAttribute('title')).toBe(false);
	expect(input.getAttribute('required')).toBe('');
	expect(input.hasAttribute('readonly')).toBe(false);
	expect(input.getAttribute('spellcheck')).toBe('false');
});

test('semantic containers and headings lay out as frames and text, and elements nest in text', async () => {
	expect(
		messages(`<nav><ul><li><a href="/">Home</a></li></ul></nav><header><h1>Title</h1></header><section><article><p>Read <a href="/docs" title="Docs" onclick={() => 1}>the docs</a>,<br/>then <strong>try</strong> <code>it</code>.</p></article></section><footer><aside><small>x</small></aside></footer>`)
	).toEqual([]);
	const { target } = install();
	mount(program(`<nav><h2>Hi</h2></nav><p>Read <a href="/docs">docs</a><br/><em>now</em></p>`), target as any);
	await settle();
	const [nav, p] = target.children;
	expect([nav.tag, nav.children[0].tag, nav.children[0].getAttribute('data-p')]).toEqual(['nav', 'h2', 'text']);
	const link = p.find((el) => el.tag === 'a')!;
	expect([link.getAttribute('data-p'), link.getAttribute('href')]).toEqual(['inline', '/docs']);
	expect(p.text).toBe('Read docs\nnow');
	expect(messages(`<span>a <div>b</div> <br class="x"/></span>`)).toEqual([
		'error: <div> cannot appear inside text; only span, strong, em, b, i, code, small, s, mark, a and br can',
		'error: <br> takes no attributes or content'
	]);
});

test('a form never navigates; submitting it runs its onsubmit', async () => {
	(globalThis as any).__log = [];
	const { target } = install();
	mount(program(`<form onsubmit={() => globalThis.__log.push('submitted')}><button type="submit">Go</button></form>`), target as any);
	await settle();
	const event = { defaultPrevented: false, preventDefault() { event.defaultPrevented = true; } };
	for (const fn of target.children[0].listeners.get('submit')!) fn(event);
	expect([event.defaultPrevented, (globalThis as any).__log]).toEqual([true, ['submitted']]);
	expect(messages(`<button type="link">x</button>`)).toEqual(['error: type must be one of submit, button, reset']);
});

test('a select holds options, and its selection follows its value as options come and go', async () => {
	const source = `<script>
	let choice = $state('b');
	let options = $state(['a', 'b', 'c']);
	globalThis.__select = { set: (v) => (choice = v), options: (o) => (options = o) };
</script>
<select style={{ width: 120 }} bind:value={choice}>
	<optgroup label="Letters">
		{#each options as o (o)}<option value={o}>Letter {o}</option>{/each}
	</optgroup>
	<option>none</option>
</select>`;
	expect(messages(source)).toEqual([]);
	const { target } = install();
	mount(program(source), target as any);
	await settle();
	const select = target.children[0];
	const selected = () => select.find((el) => el.tag === 'option' && (el as any).selected)?.text;
	expect([select.getAttribute('data-p'), selected()]).toEqual(['select', 'Letter b']);
	const api = (globalThis as any).__select;
	api.set('none');
	expect(selected()).toBe('none');
	api.set('d');
	api.options(['c', 'd']);
	expect(selected()).toBe('Letter d');

	expect(messages(`<option>x</option><select style={{ width: 1 }}><div></div><option style={{ color: '#000' }}><b>x</b></option></select><select></select>`)).toEqual([
		'error: <option> can only be inside <select>',
		'error: <div> cannot be inside <select>; it holds <option>s and <optgroup>s',
		'error: <option> is drawn by the browser and takes no style=',
		'error: <option> holds plain text: its label',
		'error: <select> needs width: <number> or "fill"'
	]);
});

test('at design time a select shows the label of its selected option', async () => {
	const { evaluate } = await import('../src/design');
	const { compile } = await import('../src');
	const c = compile(`<script>let v = $state('2');</script><select style={{ width: 100 }} value={v}>{#each [1, 2] as n (n)}<option value={String(n)}>Option {n}</option>{/each}</select>`, 'select.pat');
	const [select] = (await evaluate(c)) as any[];
	expect([select.type, select.tag, select.value]).toEqual(['input', 'select', 'Option 2']);
});
