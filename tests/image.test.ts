import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyze, compile } from '../src';
import { evaluate } from '../src/design';
import { mount } from '../src/runtime/dom';
import { snapshotToFigma } from '../src/targets/figma';
import { install, program, settle } from './fake-dom';

const dir = mkdtempSync(join(tmpdir(), 'pat-image-'));
writeFileSync(join(dir, 'logo.png'), 'png');
const file = join(dir, 'app.pat');
const messages = (source: string) => analyze(source, { filename: file }).diagnostics.map((d) => `${d.severity}: ${d.message}`);

test('<img> needs src, should have alt, and a relative src must exist', () => {
	expect(messages(`<img src="./logo.png" alt="Logo" style={{ width: 40, objectFit: 'cover', borderRadius: 4 }} />`)).toEqual([]);
	expect(messages(`<img alt="x" /><img src="./logo.png" /><img src="./nope.png" alt="" /><img src="./logo.png" alt="" style={{ gap: 2 }} />`)).toEqual([
		'error: <img> needs src',
		'warning: <img> needs alt: what the image shows, or alt="" when it is decorative',
		'error: cannot find ./nope.png',
		'error: "gap" is not supported on <img>'
	]);
});

test('a relative src is imported as an asset; any other src is used as written', async () => {
	const source = `<script>let url = $state('https://example.com/a.png');</script><img src="./logo.png" alt="Logo" /><img src={url} alt="Remote" /><img src="/static/b.png" alt="" />`;
	const { module, imports } = compile(source, file);
	expect(imports).toContain('./logo.png');
	expect(module).toContain('src: () => $$asset0');
	expect(module).toContain('src: () => url.v');

	const { target } = install();
	// (A program with an asset import is a module; this one has none.)
	mount(program(source.replace('<img src="./logo.png" alt="Logo" />', ''), file), target as any);
	await settle();
	expect(target.children.map((img) => [img.tag, img.getAttribute('data-p'), img.getAttribute('src')])).toEqual([
		['img', 'image', 'https://example.com/a.png'],
		['img', 'image', '/static/b.png']
	]);
});

test('at design time an image keeps its source; Figma draws a frame for it and says so', async () => {
	const [img] = (await evaluate(compile(`<img src="./logo.png" alt="Logo" style={{ width: 40, height: 20 }} />`, file))) as any[];
	expect([img.type, realpathSync(img.src), img.alt]).toEqual(['image', realpathSync(join(dir, 'logo.png')), 'Logo']);
	const { warnings } = await snapshotToFigma([img], 'img', (font, text) => text.length * font.size * 0.5);
	expect(warnings).toEqual(['images are not drawn in Figma yet; an empty frame stands in for "Logo" (at 1:1)']);
});
