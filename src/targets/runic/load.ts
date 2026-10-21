// Design-time evaluation of a compiled module: initialize state, apply
// overrides, evaluate derived values and the template once. `$effect`s never
// run. A module with imports is loaded through Bun so they resolve from the
// .pat file.

import type { Compiled } from '../../compile';
import type { Concrete } from '../../schema/concrete';
import type { Program } from '../../schema/program';
import { realize } from '../../runtime/realize';

export async function evaluate(compiled: Compiled, options: { state?: Record<string, unknown> } = {}): Promise<Concrete[]> {
	const overrides = options.state ?? {};
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
