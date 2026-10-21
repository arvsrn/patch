// Design-time evaluation: a compiled app at one static state.
//
// `--state name=value` overrides replace the initial value of a top-level
// `$state`. A value is read as JSON, falling back to the plain string. In a
// `<script lang="ts">` both readings are checked against the variable's
// declared type and the first that fits wins, so `filter=done` is the string
// "done" and `count=3` stays a number. `$effect`s never run. A module with
// imports is loaded through Bun so they resolve from the .pat file.

import type { Compiled } from './compile';
import { realize } from './runtime/realize';
import type { Concrete } from './schema/concrete';
import type { Program } from './schema/program';
import { checkValues } from './typecheck';

export type StateOverrides = Record<string, unknown>;

/** Parses `name=value` pairs against the app's `$state` declarations. Throws on unknown names and ill-typed values. */
export function parseStateOverrides(compiled: Compiled, pairs: string[]): StateOverrides {
	const known = compiled.state.map((s) => s.id);
	const parsed = pairs.map((pair) => {
		const eq = pair.indexOf('=');
		if (eq <= 0) throw new Error(`--state expects name=value, got "${pair}"`);
		const name = pair.slice(0, eq);
		const raw = pair.slice(eq + 1);
		if (!known.includes(name)) throw new Error(`Unknown state "${name}". Available: ${known.join(', ') || '(none)'}`);
		const candidates: unknown[] = [];
		try {
			candidates.push(JSON.parse(raw));
		} catch {}
		if (typeof candidates[0] !== 'string') candidates.push(raw);
		return { name, raw, candidates };
	});

	const script = compiled.script;
	if (script?.lang !== 'ts') return Object.fromEntries(parsed.map((p) => [p.name, p.candidates[0]]));

	const checks = parsed.flatMap((p) => p.candidates.map((value) => ({ name: p.name, expression: JSON.stringify(value) })));
	const errors = checkValues(script.source, compiled.path, script.start, script.end, checks);
	const out: StateOverrides = {};
	let i = 0;
	for (const p of parsed) {
		const results = p.candidates.map(() => errors[i++]);
		const fits = results.findIndex((error) => error === null);
		if (fits < 0) throw new Error(`Invalid --state ${p.name}=${p.raw}: ${results[0]}`);
		out[p.name] = p.candidates[fits];
	}
	return out;
}

/** Evaluates the app once at its initial state with `overrides` applied. */
export async function evaluate(compiled: Compiled, overrides: StateOverrides = {}): Promise<Concrete[]> {
	const known = compiled.state.map((s) => s.id);
	for (const id of Object.keys(overrides))
		if (!known.includes(id)) throw new Error(`Unknown state "${id}". Available: ${known.join(', ') || '(none)'}`);
	const program: Program = compiled.imports.length
		? await importProgram(compiled)
		: new Function(`return (${compiled.module.replace(/^export default /m, '')})`)();
	return realize(program, overrides);
}

// Compiled modules served to Bun's loader by path.
const loaded = new Map<string, string>();
async function importProgram(compiled: Compiled): Promise<Program> {
	if (!loaded.size)
		Bun.plugin({
			name: 'pat',
			setup(build) {
				build.onLoad({ filter: /\.pat$/ }, ({ path }) => ({ contents: loaded.get(path) ?? '', loader: 'js' }));
			}
		});
	loaded.set(compiled.path, compiled.module);
	return (await import(compiled.path)).default;
}
