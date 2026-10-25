// TypeScript server plugin: the editor's TypeScript sees a Patch app as
// Patch's own checker does (src/typecheck.ts), from the same files in
// src/types:
//
// - runes.d.ts is in every program: the runes, `.pat` imports as components,
//   and the 'patch' module.
// - A .pat.ts module is read with module-runes.d.ts appended, so its
//   `$state({ … })` is module state: assignable properties, read-only values,
//   in the module and wherever it is imported.
// - compiler-options.cjs applies Patch's options over the tsconfig's
//   (.ts import extensions, bundler resolution, DOM types).
// - Runes in any other TypeScript file are errors: Patch only compiles them in
//   .pat files and .pat.ts / .pat.js modules.
//
// It only acts in a Patch project: one with a .pat file under its directory,
// or a .pat.ts / .pat.js module among its files. Elsewhere (a Svelte app, say)
// TypeScript is left exactly as it is.
//
// The extension says where the files are, in the Patch install it uses
// (`configurePlugin` with `{ types }`). Until then the plugin does nothing.

const fs = require('node:fs');
const path = require('node:path');

const RUNES = new Set(['$state', '$derived', '$effect', '$style', '$props']);
const isPatModule = (file) => /\.pat\.[jt]s$/.test(file);
const isPatTs = (file) => file.endsWith('.pat.ts');

function init({ typescript: ts }) {
	/** The loaded src/types, or null when they cannot be found. */
	let patch = null;
	let generation = 0;
	const projects = new Set();

	const configure = (dir) => {
		try {
			patch = {
				runes: path.join(dir, 'runes.d.ts'),
				moduleRunes: '\n' + fs.readFileSync(path.join(dir, 'module-runes.d.ts'), 'utf8'),
				options: require(path.join(dir, 'compiler-options.cjs'))
			};
			fs.accessSync(patch.runes);
		} catch {
			patch = null;
		}
		generation++;
	};

	/** Whether `dir` has a .pat file, skipping dependencies. */
	const hasComponents = (dir) => ts.sys.readDirectory(dir, ['.pat'], ['**/node_modules', '**/.git'], ['**/*'], 8).length > 0;

	function create(info) {
		// Configuration sent before this project existed.
		if (info.config?.types && !patch) configure(info.config.types);
		const project = info.project;
		const host = info.languageServiceHost;
		const service = info.languageService;
		const state = { project, components: false, generation: -1 };
		projects.add(state);

		const getScriptFileNames = host.getScriptFileNames.bind(host);
		/** The loaded types when this is a Patch project, else null. */
		const active = () => {
			if (!patch) return null;
			if (state.generation !== generation) {
				state.generation = generation;
				state.components = hasComponents(project.getCurrentDirectory());
			}
			return state.components || getScriptFileNames().some(isPatModule) ? patch : null;
		};

		// A root of every program, in projects with a tsconfig or without one.
		host.getScriptFileNames = () => {
			const names = getScriptFileNames();
			const on = active();
			return on && !names.includes(on.runes) ? [...names, on.runes] : names;
		};
		const getScriptSnapshot = host.getScriptSnapshot.bind(host);
		host.getScriptSnapshot = (file) => {
			const snapshot = getScriptSnapshot(file);
			const on = active();
			if (!snapshot || !on || !isPatTs(file)) return snapshot;
			return ts.ScriptSnapshot.fromString(snapshot.getText(0, snapshot.getLength()) + on.moduleRunes);
		};
		const getScriptVersion = host.getScriptVersion.bind(host);
		host.getScriptVersion = (file) => (isPatTs(file) ? `${getScriptVersion(file)}:patch${generation}` : getScriptVersion(file));
		const getCompilationSettings = host.getCompilationSettings.bind(host);
		let settings = { base: null, generation: -1, options: null };
		host.getCompilationSettings = () => {
			const base = getCompilationSettings();
			const on = active();
			if (!on) return base;
			if (settings.base !== base || settings.generation !== generation) settings = { base, generation, options: on.options(ts, base) };
			return settings.options;
		};

		const proxy = Object.create(null);
		for (const key of Object.keys(service)) proxy[key] = (...args) => service[key](...args);
		proxy.getSemanticDiagnostics = (file) => {
			const diagnostics = service.getSemanticDiagnostics(file);
			const on = active();
			if (!on || isPatModule(file) || file.endsWith('.d.ts')) return diagnostics;
			const program = service.getProgram();
			const source = program?.getSourceFile(file);
			if (!source) return diagnostics;
			const checker = program.getTypeChecker();
			const runes = path.resolve(on.runes);
			const extra = [];
			const visit = (node) => {
				if (ts.isIdentifier(node) && RUNES.has(node.text) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) {
					const declaration = checker.getSymbolAtLocation(node)?.declarations?.[0];
					if (declaration && path.resolve(declaration.getSourceFile().fileName) === runes)
						extra.push({
							file: source,
							start: node.getStart(source),
							length: node.getWidth(source),
							messageText: `${node.text} only works in .pat files and .pat.ts / .pat.js modules; Patch does not compile this file`,
							category: ts.DiagnosticCategory.Error,
							code: 99001,
							source: 'patch'
						});
				}
				ts.forEachChild(node, visit);
			};
			visit(source);
			return [...diagnostics, ...extra];
		};
		return proxy;
	}

	return {
		create,
		onConfigurationChanged(config) {
			if (config?.types) configure(config.types);
			for (const { project } of projects) {
				project.markAsDirty?.();
				project.refreshDiagnostics?.();
			}
		}
	};
}

module.exports = init;
