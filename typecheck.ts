// TypeScript semantic checking for the <script lang="ts"> of a .pat file.
//
// The script is checked as `<file>.pat.ts`: the .pat source with everything
// outside the script blanked to spaces (newlines kept), so TypeScript offsets
// are .pat offsets. The author's code is checked as written, before the
// reactive rewrite; rune declarations describe what the author sees. One
// LanguageService per tsconfig is kept for the life of the process.

import { dirname } from 'node:path';
import ts from 'typescript-api';

export type TypeDiagnostic = { message: string; severity: 'error' | 'warning'; start: number; end: number; code: number };

const RUNES = `
declare function $state<T>(initial: T): T;
declare function $state<T>(): T | undefined;
declare function $derived<T>(value: T): T;
declare namespace $derived {
	function by<T>(fn: () => T): T;
}
declare function $effect(fn: () => void | (() => void)): void;
/** A validated style. Which properties are legal where is checked by the PAT compiler. */
interface PatStyle {
	readonly [property: string]: unknown;
}
declare function $style(style: { readonly [property: string]: unknown }): PatStyle;
`;

type Project = { service: ts.LanguageService; files: Map<string, { text: string; version: number }> };
const projects = new Map<string, Project>();

function project(file: string): Project {
	const config = ts.findConfigFile(dirname(file), ts.sys.fileExists);
	const existing = projects.get(config ?? '');
	if (existing) return existing;

	const root = config ? dirname(config) : dirname(file);
	const base = config
		? ts.parseJsonConfigFileContent(ts.readConfigFile(config, ts.sys.readFile).config, ts.sys, root).options
		: { strict: true };
	// What a .pat script is regardless of the tsconfig: a browser ES module whose
	// imports Vite resolves, and whose bindings the template may use.
	const options: ts.CompilerOptions = {
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
	const files = new Map([[`${root}/__pat_runes__.d.ts`, { text: RUNES, version: 0 }]]);
	const host: ts.LanguageServiceHost = {
		getScriptFileNames: () => [...files.keys()],
		getScriptVersion: (f) => String(files.get(f)?.version ?? ts.sys.getModifiedTime?.(f)?.getTime() ?? 0),
		getScriptSnapshot: (f) => {
			const text = files.get(f)?.text ?? ts.sys.readFile(f);
			return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
		},
		getCurrentDirectory: () => root,
		getCompilationSettings: () => options,
		getDefaultLibFileName: ts.getDefaultLibFilePath,
		fileExists: (f) => files.has(f) || ts.sys.fileExists(f),
		readFile: (f) => files.get(f)?.text ?? ts.sys.readFile(f),
		readDirectory: ts.sys.readDirectory,
		directoryExists: ts.sys.directoryExists,
		getDirectories: ts.sys.getDirectories,
		realpath: ts.sys.realpath
	};
	const created = { service: ts.createLanguageService(host, ts.createDocumentRegistry()), files };
	projects.set(config ?? '', created);
	return created;
}

/** Type-checks `source.slice(start, end)` as the script of the .pat file at `path`. */
export function typecheck(source: string, path: string, start: number, end: number): TypeDiagnostic[] {
	const { service, files } = project(path);
	const blank = (text: string) => text.replace(/[^\r\n]/g, ' ');
	const text = blank(source.slice(0, start)) + source.slice(start, end) + blank(source.slice(end));
	const virtual = `${path}.ts`;
	const previous = files.get(virtual);
	if (previous?.text !== text) files.set(virtual, { text, version: (previous?.version ?? 0) + 1 });
	return [...service.getSyntacticDiagnostics(virtual), ...service.getSemanticDiagnostics(virtual)]
		.filter((d) => d.start !== undefined && (d.category === ts.DiagnosticCategory.Error || d.category === ts.DiagnosticCategory.Warning))
		.map((d) => ({
			message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
			severity: d.category === ts.DiagnosticCategory.Error ? 'error' : 'warning',
			start: d.start!,
			end: d.start! + Math.max(1, d.length ?? 1),
			code: d.code
		}));
}
