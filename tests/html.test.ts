import { expect, test } from 'bun:test';
import { compile } from '../src';
import { mount } from '../src/runtime/dom';
import { buildStandalone } from '../src/targets/browser/vite';

const SOURCE = `<script lang="ts">
	let filter: 'all' | 'done' = $state('all');
	let ran = $state('no');
	$effect(() => { ran = 'yes'; });
</script>
<main><p>{filter} {ran}</p></main>`;

/** Mounts into a minimal document stand-in; returns the rendered text after effects had their chance. */
async function render(options?: Parameters<typeof mount>[2]) {
	const text: { data: string }[] = [];
	const node = (): any => ({
		style: { setProperty() {}, removeProperty() {} },
		setAttribute() {},
		appendChild: (n: any) => n,
		insertBefore: (n: any) => n,
		addEventListener() {}
	});
	const doc = { head: node(), createElement: node, createComment: () => ({}), createTextNode: (data: string) => (text.push({ data }), text.at(-1)) };
	const previous = (globalThis as any).document;
	(globalThis as any).document = doc;
	try {
		const program = new Function(`return (${compile(SOURCE, 'html.pat').module.replace(/^export default /m, '')})`)();
		mount(program, node(), options);
		await new Promise((resolve) => setTimeout(resolve, 0));
	} finally {
		(globalThis as any).document = previous;
	}
	return text.map((t) => t.data).join('');
}

test('mounting from overridden state skips effects; a plain mount runs them', async () => {
	expect(await render({ overrides: { filter: 'done' }, design: true })).toBe('done no');
	expect(await render()).toBe('all yes');
});

test('an HTML snapshot bundles the app with its state baked into the mount', async () => {
	const path = `${import.meta.dir}/.html-snapshot.pat`;
	await Bun.write(path, SOURCE);
	try {
		const html = await buildStandalone(path, { overrides: { filter: 'done' }, design: true });
		expect(html).toStartWith('<!doctype html>');
		expect(html).toMatch(/overrides:\{filter:[`"']done[`"']\}/);
		expect(html).toContain('design:!0');
	} finally {
		await Bun.file(path).delete();
	}
});
