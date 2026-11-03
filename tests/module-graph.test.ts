import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from '../src';
import { evaluate } from '../src/design';
import { ModuleGraph, openGraphs } from '../src/module-graph';
import { realize } from '../src/runtime/realize';
import type { Program } from '../src/schema/program';

const root = mkdtempSync(join(tmpdir(), 'pat-graph-'));
const files: Record<string, string> = {
	'counter.pat.ts': `export const counter = $state({ count: 0 });\nexport const bump = () => (counter.count += 1);`,
	'App.pat': `<script lang="ts">\n\timport { bump, counter } from './counter.pat.ts';\n\tbump();\n</script>\n<p>{counter.count}</p>`,
	'ok.ts': 'export const ok = true;',
	// Throws once part of the graph has loaded.
	'boom.ts': `import './ok.ts';\nthrow new Error('boom');`,
	'Bad.pat': `<script lang="ts">\n\timport './boom.ts';\n</script>\n<p>bad</p>`
};
for (const [name, source] of Object.entries(files)) writeFileSync(join(root, name), source);
const app = compile(files['App.pat'], join(root, 'App.pat'));
const bad = compile(files['Bad.pat'], join(root, 'Bad.pat'));

const text = (program: Program) => (realize(program) as any[])[0].runs.map((r: any) => r.text).join('');
const counter = (count: number) => ({ 'counter.pat.ts#counter': { count } });
/** Modules the loader still holds for a graph. */
const loaded = (prefix: string) => Object.keys(require.cache).filter((key) => key.startsWith(prefix));

test('graphs importing the same source at once each get their own module state, from their own overrides', async () => {
	const a = new ModuleGraph(app, root, counter(10));
	const b = new ModuleGraph(app, root, counter(20));
	const [pa, pb] = await Promise.all([a.import(), b.import()]);
	expect([text(pa), text(pb)]).toEqual(['11', '21']);
	a.dispose();
	// Each render runs the script, which bumps its graph's counter: a disposed graph's program stays usable, and the graphs stay apart.
	expect([text(pa), text(pb)]).toEqual(['12', '22']);
	expect(openGraphs()).toEqual([b.prefix]);
	b.dispose();
});

test('a graph keeps its overrides as they were when it was made', async () => {
	const overrides = counter(1);
	const graph = new ModuleGraph(app, root, overrides);
	overrides['counter.pat.ts#counter'].count = 100;
	expect(text(await graph.import())).toBe('2');
	graph.dispose();
});

test('a failed import leaves other evaluations alone, and its graph disposes cleanly, once or twice', async () => {
	const [good, failed] = await Promise.allSettled([evaluate(app, counter(5), { root }), evaluate(bad, {}, { root })]);
	expect(good.status === 'fulfilled' && (good.value[0] as any).runs[0].text).toBe('6');
	expect(failed.status === 'rejected' && failed.reason.message).toBe('boom');

	const graph = new ModuleGraph(bad, root);
	await expect(graph.import()).rejects.toThrow('boom');
	expect(loaded(graph.prefix)).not.toEqual([]);
	graph.dispose();
	graph.dispose();
	await expect(graph.import()).rejects.toThrow('is disposed');
	expect(loaded(graph.prefix)).toEqual([]);
});

test('repeated evaluations leave no open graph and no loaded module behind', async () => {
	for (let i = 0; i < 5; i++) await Promise.all([evaluate(app, counter(i), { root }), evaluate(app, {}, { root })]);
	expect(openGraphs()).toEqual([]);
	expect(loaded('/__patch_eval_')).toEqual([]);
});
