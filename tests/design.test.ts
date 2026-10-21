import { expect, test } from 'bun:test';
import { compile } from '../src';
import { evaluate, parseStateOverrides } from '../src/design';

const TS = `<script lang="ts">
	type Task = { id: number; done: boolean };
	let filter: 'all' | 'active' | 'done' = $state('all');
	let loading = $state(false);
	let label = $state('');
	let count = $state(0);
	let tasks: Task[] = $state([]);
	let selected: number | null = $state(null);
</script>
<main><p>{filter} {loading ? 'loading' : 'idle'} {label} {count} {tasks.length} {selected}</p></main>`;

const app = compile(TS, 'state.pat');
const text = async (overrides = {}) => {
	const [main] = (await evaluate(app, overrides)) as any[];
	return main.children[0].runs.map((r: any) => r.text).join('');
};

test('without overrides the $state defaults are used', async () => {
	expect(await text()).toBe('all idle  0 0 ');
});

test('values are JSON, else plain strings, whichever fits the declared type', () => {
	expect(parseStateOverrides(app, ['filter=done', 'loading=true', 'label=123', 'count=3', 'selected=7', 'tasks=[{"id":1,"done":true}]'])).toEqual({
		filter: 'done',
		loading: true,
		label: '123',
		count: 3,
		selected: 7,
		tasks: [{ id: 1, done: true }]
	});
	expect(parseStateOverrides(app, ['label="quoted"', 'selected=null'])).toEqual({ label: 'quoted', selected: null });
});

test('overrides change the evaluated state', async () => {
	expect(await text(parseStateOverrides(app, ['filter=done', 'loading=true', 'tasks=[{"id":1,"done":true}]']))).toBe('done loading  0 1 ');
});

test('unknown names and ill-typed values fail with the reason', () => {
	expect(() => parseStateOverrides(app, ['nope=1'])).toThrow('Unknown state "nope". Available: filter, loading, label, count, tasks, selected');
	expect(() => parseStateOverrides(app, ['filter=dne'])).toThrow(`Invalid --state filter=dne: Type '"dne"' is not assignable to type '"all" | "active" | "done"'`);
	expect(() => parseStateOverrides(app, ['loading=yes'])).toThrow("Type 'string' is not assignable to type 'boolean'");
	expect(() => parseStateOverrides(app, ['tasks=[{"id":1}]'])).toThrow("Property 'done' is missing");
	expect(() => parseStateOverrides(app, ['count'])).toThrow('--state expects name=value, got "count"');
});

test('a plain <script> has no types: JSON, else the string', () => {
	const js = compile(`<script>let n = $state(0)</script><p>{n}</p>`, 'plain.pat');
	expect(parseStateOverrides(js, ['n=5'])).toEqual({ n: 5 });
	expect(parseStateOverrides(js, ['n=five'])).toEqual({ n: 'five' });
});

test('$effects never run at design time', async () => {
	const c = compile(`<script>let n = $state(1); $effect(() => { n = 99; });</script><p>{n}</p>`, 'effects.pat');
	expect(((await evaluate(c)) as any[])[0].runs[0].text).toBe('1');
});
