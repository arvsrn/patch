// What TypeScript in a Patch app is, whatever its tsconfig says: browser ES
// modules whose imports Vite resolves (with their .ts extensions), and whose
// unused bindings a template may still use. Used by Patch's type checker
// (src/typecheck.ts) and the editor's TypeScript plugin, so both check the
// same program. CommonJS so that both Bun and the editor's Node can load it.

/** `base` (the tsconfig's options) with Patch's applied. `ts` is the TypeScript API in use. */
module.exports = function patchCompilerOptions(ts, base) {
	return {
		...base,
		noEmit: true,
		allowJs: true,
		allowImportingTsExtensions: true,
		moduleDetection: ts.ModuleDetectionKind.Force,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		target: base.target ?? ts.ScriptTarget.ESNext,
		lib: [...new Set([...(base.lib ?? ['lib.esnext.d.ts']), 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'])],
		noUnusedLocals: false,
		noUnusedParameters: false
	};
};
