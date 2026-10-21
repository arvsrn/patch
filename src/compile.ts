// The compiler pipeline:
//
//   source ─ parse ─ lower ─► IR ─ bind ─► bindings ─┬─ check (script, template, styles) + typecheck ─► diagnostics
//                                                    └─ emit (only without errors) ─► ES module
//
// The compiled module keeps the script's imports at the top and
// default-exports `program($$rt)` (see schema/program.ts).

import { basename, resolve } from 'node:path';
import { bind, type Bindings } from './bind';
import { checkScript } from './check/script';
import { checkStyles } from './check/styles';
import { checkTemplate, checkTemplateNames } from './check/template';
import { CompileError, Reporter, type Diagnostic } from './diagnostics';
import { Edits } from './emit/edits';
import { emitScript } from './emit/script';
import { TemplateEmitter } from './emit/template';
import type { Component, StateInfo } from './ir';
import { lower } from './lower';
import { parse } from './parse';
import { collectStyles, type Styles } from './styles';
import { globalNames, typecheck } from './typecheck';

export type Compiled = {
	filename: string;
	/** Absolute path of the .pat file; the script's relative imports resolve from it. */
	path: string;
	/** ES module source: the script's imports, then `export default function program($$rt) { ... }`. */
	module: string;
	/** Specifiers the module still imports after type-only imports are removed. */
	imports: string[];
	state: StateInfo[];
	/** The .pat source and the script's offsets in it, for checking design-time state values. */
	script: { lang: 'ts' | 'js'; source: string; start: number; end: number } | null;
};

export type Analysis = { diagnostics: Diagnostic[]; state: StateInfo[] };

type Front = { component: Component; bindings: Bindings; styles: Styles };

/** parse → lower → bind → style analysis. Null when the source does not parse. */
export function front(source: string, reporter: Reporter): Front | null {
	const ast = parse(source, reporter);
	if (!ast) return null;
	const component = lower(ast, source, reporter);
	const bindings = bind(component);
	return { component, bindings, styles: collectStyles(component, bindings) };
}

function check(source: string, filename: string, reporter: Reporter): Front | null {
	const result = front(source, reporter);
	if (!result) return null;
	const { component, bindings, styles } = result;
	checkScript(component, bindings, reporter);
	checkTemplate(component, bindings, reporter);
	checkTemplateNames(component, bindings, globalNames(resolve(filename)), reporter);
	checkStyles(styles, reporter);
	reporter.diagnostics.sort((a, b) => a.start - b.start);

	// TypeScript diagnostics for the script. A PAT error already covering the
	// same spot wins (e.g. an `import "./App.pat"` is not also "Cannot find module").
	const script = component.script;
	if (script?.lang === 'ts') {
		const pat = reporter.diagnostics.filter((d) => d.severity === 'error');
		for (const d of typecheck(source, resolve(filename), script.span.start, script.span.end)) {
			if (pat.some((p) => p.start <= d.start && d.start < p.end)) continue;
			reporter.diagnostics.push({ ...d, source: 'typescript', ...reporter.position(d.start) });
		}
	}
	return result;
}

/** Validation only: every diagnostic, no code generation. */
export function analyze(source: string, options: { filename?: string } = {}): Analysis {
	const reporter = new Reporter(source);
	const result = check(source, options.filename ?? 'app.pat', reporter);
	return { diagnostics: reporter.diagnostics, state: result?.component.script?.state.map((d) => d.info) ?? [] };
}

/**
 * Validation, type checking and code generation. `filename` is the .pat path
 * (relative to the working directory or absolute). Throws a CompileError
 * listing every diagnostic.
 */
export function compile(source: string, filename = 'app.pat'): Compiled {
	const reporter = new Reporter(source);
	const result = check(source, filename, reporter);
	if (!result || reporter.hasErrors()) throw new CompileError(reporter.diagnostics, source, filename);
	const { component, bindings, styles } = result;

	const edits = new Edits(source);
	const script = emitScript(component, bindings, styles, source, edits);
	const nodes = new TemplateEmitter(edits, (offset) => {
		const { line, column } = reporter.position(offset);
		return `${line}:${column}`;
	}).nodes(component.template);
	const ts = `${script.imports.join('\n')}\nexport default function program($$rt) {\n${script.code}\nreturn [${nodes.join(',\n')}];\n}\n`;
	const module = new Bun.Transpiler({ loader: 'ts', target: 'browser' }).transformSync(ts);
	const imports = new Bun.Transpiler({ loader: 'js' }).scanImports(module).map((i) => i.path);
	const info = component.script;
	return {
		filename: basename(filename),
		path: resolve(filename),
		module,
		imports,
		state: info?.state.map((d) => d.info) ?? [],
		script: info ? { lang: info.lang, source, start: info.span.start, end: info.span.end } : null
	};
}
