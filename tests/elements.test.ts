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
