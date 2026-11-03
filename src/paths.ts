// Where Patch's own files are: what generated code imports from the runtime,
// and what loaders and servers must tell apart from an app's files.

import { resolve } from 'node:path';

/** Patch's sources. */
export const PATCH_SRC = import.meta.dir;
/** The Patch install: its sources and their dependencies. */
export const PATCH_ROOT = resolve(PATCH_SRC, '..');

export const RUNTIME = {
	dom: resolve(PATCH_SRC, 'runtime/dom.ts'),
	moduleState: resolve(PATCH_SRC, 'runtime/module-state.ts'),
	/** What `import … from 'patch'` is outside a .pat script. */
	patch: resolve(PATCH_SRC, 'runtime/context.ts'),
	/** The not-found page of an app without src/pages/+404.pat. */
	notFound: resolve(PATCH_SRC, 'runtime/not-found.pat')
};

/** Declarations and compiler options shared with the editor's TypeScript plugin. */
export const TYPES = resolve(PATCH_SRC, 'types');
