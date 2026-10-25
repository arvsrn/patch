import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { analyze, compile } from '../src';
import { compileModule } from '../src/compile';
import { evaluate, parseStateOverrides } from '../src/design';
import { moduleState } from '../src/runtime/module-state';
import { reactive } from '../src/runtime/reactive';
import { parseModuleStateId } from '../src/schema/path';

/** An app directory with these files. */
function app(files: Record<string, string>) {
	const root = mkdtempSync(join(tmpdir(), 'pat-module-'));
	for (const [path, source] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), source);
	}
	return root;
}

const WORKSPACE = `import { seed } from './seed.ts';
type Issue = { id: number; labels: string[] };
export const workspace = $state<{ issues: Issue[]; nextId: number }>({ issues: seed, nextId: 1 });
export function add() {
	workspace.issues = [...workspace.issues, { id: workspace.nextId, labels: [] }];
	workspace.nextId += 1;
}
`;

const errors = (root: string, file: string) => {
	try {
		compileModule(require('node:fs').readFileSync(join(root, file), 'utf8'), join(root, file), root);
	} catch (e) {
		return (e as Error).message.split('\n\n').map((m) => m.split('\n')[0].replace(/^.*?error( TS\d+)?: /, ''));
	}
	return [];
};

test('module $state compiles to state named by the module file relative to the app root', () => {
	const root = app({ 'src/workspace.pat.ts': WORKSPACE, 'src/seed.ts': 'export const seed = [];' });
	const compiled = compileModule(WORKSPACE, join(root, 'src/workspace.pat.ts'), root);
	expect(compiled.states).toEqual([{ name: 'workspace', id: 'src/workspace.pat.ts#workspace', keys: ['issues', 'nextId'] }]);
	expect(compiled.module).toContain('export const workspace = $$moduleState("src/workspace.pat.ts#workspace", ["issues", "nextId"], () => ({ issues: seed, nextId: 1 }));');
	expect(compiled.imports).toContain('./seed.ts');
});

test('module state is a const object of listed properties, assigned but never changed in place', () => {
	const root = app({
		'src/bad.pat.js': `export let a = $state({ n: 1 });
export const b = $state(0);
export const c = $state({ ...{ x: 1 }, list: [] });
const d = $derived(1);
export function f() {
	c.list.push(1);
	c.list[0] = 2;
	c = null;
	const e = $state({ y: 1 });
}
`,
		'src/Card.pat': '<p>card</p>',
		'src/Card.pat.ts': 'export const x = 1;'
	});
	expect(errors(root, 'src/bad.pat.js')).toEqual([
		'module state is declared as `const name = $state({ key: value, … })` at the top level; it is const, since the binding never changes (assign its properties)',
		'module state is declared as `const name = $state({ key: value, … })` at the top level: module $state holds an object, whose properties are assigned',
		'list each property of module state as `key: value`; spreads, computed keys, methods and accessors are not supported',
		'$derived is not supported in .pat.ts modules; only $state is',
		'.push() changes module state "c" in place, which is not tracked; assign a new value to its property instead',
		'this changes module state "c" in place, which is not tracked; assign a new value to its property instead',
		'"c" is module state and is never reassigned; assign its properties: c.key = value',
		'$state(...) in a module is only allowed as `const name = $state({ … })` at the top level'
	]);
	expect(errors(root, 'src/Card.pat.ts')).toEqual(['Card.pat is a component next to this module; rename one (TypeScript would resolve the component\'s import to this file)']);
});

test('importers see module state as assignable properties of read-only values', () => {
	const root = app({ 'src/workspace.pat.ts': WORKSPACE, 'src/seed.ts': 'export const seed = [];' });
	const source = `<script lang="ts">
	import { workspace } from './workspace.pat.ts';
	const list = workspace.issues;
	function bad() {
		list.push({ id: 1, labels: [] });
		workspace.issues[0].labels = [];
	}
	function good() {
		workspace.issues = [...workspace.issues, { id: 2, labels: [] }];
		workspace.nextId += 1;
	}
</script>
<p>{workspace.issues.length}</p>`;
	const messages = analyze(source, { filename: join(root, 'src/App.pat') }).diagnostics.map((d) => d.message);
	expect(messages).toHaveLength(2);
	expect(messages[0]).toStartWith("Property 'push' does not exist on type 'readonly");
	expect(messages[1]).toBe("Cannot assign to 'labels' because it is a read-only property.");
});

test('one cell per declaration: assigning a property replaces the value, and readers of any property rerun', () => {
	const state = moduleState('test.pat.ts#s', ['a', 'b'], () => ({ a: 1, b: { n: 1 } })) as { a: number; b: { n: number } };
	const seen: number[] = [];
	const first = state.b;
	reactive.effect(() => void seen.push(state.a));
	state.b = { n: 2 };
	state.a = 3;
	expect(seen).toEqual([1, 1, 3]);
	expect(state.b).toEqual({ n: 2 });
	expect(first).toEqual({ n: 1 });
	expect(Object.keys(state)).toEqual(['a', 'b']);
	expect(() => ((state as any).c = 1)).toThrow();
});

test('module state ids keep the file opaque, so route directories are not each keys', () => {
	expect(parseModuleStateId('src/pages/issues/[id]/form.pat.ts#form')).toEqual({ file: 'src/pages/issues/[id]/form.pat.ts', name: 'form' });
	expect(parseModuleStateId('Row@1:2/open')).toBeNull();
	expect(parseModuleStateId('src/state.ts#x')).toBeNull();
});

test('every evaluation loads the app afresh: module state starts from its initializer or override, never another evaluation', async () => {
	const root = app({
		'src/workspace.pat.ts': WORKSPACE,
		'src/seed.ts': 'export const seed = [{ id: 0, labels: [] }];',
		// Reaches the module through a plain .ts file, which must not keep an earlier evaluation's copy.
		'src/helpers.ts': `import { add, workspace } from './workspace.pat.ts';\nexport const grow = () => { add(); return workspace.issues.length; };`,
		'src/pages/[id]/form.pat.ts': `export const form = $state({ title: 'draft' });`,
		'src/pages/+page.pat': `<script lang="ts">
	import { grow } from '../helpers.ts';
	import { form } from './[id]/form.pat.ts';
	const count = grow();
</script>
<p>{count} {form.title}</p>`
	});
	const file = join(root, 'src/pages/+page.pat');
	const page = compile(await Bun.file(file).text(), file);
	const text = async (state: string[] = []) => {
		const tree = (await evaluate(page, parseStateOverrides(page, state))) as any[];
		return tree[0].runs.map((r: any) => r.text).join('');
	};
	expect(await text()).toBe('2 draft');
	expect(await text()).toBe('2 draft');
	const empty = 'src/workspace.pat.ts#workspace={"issues":[],"nextId":5}';
	expect(await Promise.all([text([empty, 'src/pages/[id]/form.pat.ts#form={"title":"x"}']), text()])).toEqual(['1 x', '2 draft']);
	expect(() => parseStateOverrides(page, ['src/workspace.pat.ts#workspace={"issues":3,"nextId":1}'])).toThrow("Type 'number' is not assignable");
	expect(() => parseStateOverrides(page, ['src/workspace.pat.ts#nope=1'])).toThrow('no module state "nope" is declared in src/workspace.pat.ts');
});
