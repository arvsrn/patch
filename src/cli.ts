#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { compile } from './compile';
import { BUILTIN_NOT_FOUND, discoverRoutes, pageAt, resolveApp, type App } from './routes';
import type { Location } from './schema/route';

const usage = `usage:
  patch dev <app> [--port 5173]
  patch build <app> [output.html]
  patch snapshot figma <app> [--url /path] [--state name=value]...
  patch snapshot html <app> [output.html] [--url /path] [--state name=value]...
  patch routes <app>
  patch lsp

<app> is a .pat file, or a directory whose src/pages/**/+page.pat are its pages.
dev serves the app with Vite and reloads the browser when a file changes.
build bundles the app and its imports into one standalone HTML file (compile is an alias).
snapshot renders the app at its initial state, without running $effects:
  figma  copies it to the clipboard as editable Figma layers; paste it into Figma.
  html   writes the app as one standalone HTML file starting from that state
         (default <name>.snapshot.html). It stays interactive: $effects
         start at the first interaction.
--url picks the page of an app with pages (default /); query and hash included.
--state replaces a $state's initial value: JSON, else a plain string, checked
against the variable's type.
routes prints the app's route manifest as JSON.
Type errors fail build and snapshot; dev shows them in the browser overlay.
lsp runs the PAT language server over stdio.
Any other arguments are passed to the system patch(1).`;

const fail = (message: string): never => {
	console.error(message);
	process.exit(1);
};

const [command, ...rest] = process.argv.slice(2);
const commands = ['dev', 'build', 'compile', 'snapshot', 'routes', 'lsp', 'help'];

// `patch` is also the standard Unix tool. Anything that is not one of our
// commands (e.g. `patch -p1 < fix.diff`) goes to the system binary unchanged.
const system = '/usr/bin/patch';
if (!commands.includes(command) && (command !== undefined || !process.stdin.isTTY) && (await Bun.file(system).exists())) {
	const proc = Bun.spawn([system, ...process.argv.slice(2)], { stdio: ['inherit', 'inherit', 'inherit'] });
	process.exit(await proc.exited);
}

try {
	if (command === 'lsp') (await import('./lsp/server')).startLanguageServer();
	else if (command === 'dev') await dev(rest);
	else if (command === 'build' || command === 'compile') await build(rest);
	else if (command === 'snapshot') await snapshot(rest);
	else if (command === 'routes') routes(rest);
	else fail(usage);
} catch (error) {
	fail(error instanceof Error ? error.message : String(error));
}

async function dev(args: string[]) {
	const { positional, flags } = parse(args, ['--port']);
	if (positional.length !== 1) fail(usage);
	await (await import('./targets/browser/vite')).startDevServer(positional[0], flags['--port'] ? Number(flags['--port']) : undefined);
}

/** Where outputs go by default: next to a .pat file, inside an app directory. */
function stemOf(app: App) {
	return join(app.root, app.name);
}

async function build(args: string[]) {
	const { positional } = parse(args, []);
	const [input, output] = positional;
	if (!input || positional.length > 2) fail(usage);
	const out = output ?? `${stemOf(resolveApp(input))}.html`;
	await Bun.write(out, await (await import('./targets/browser/vite')).buildStandalone(input));
	console.error(`wrote ${out}`);
}

async function snapshot(args: string[]) {
	const { positional, flags, state } = parse(args, ['--url'], true);
	const [target, input, output] = positional;
	if (target !== 'figma' && target !== 'html') fail(`patch snapshot needs a target: figma or html\n\n${usage}`);
	if (!input || positional.length > (target === 'html' ? 3 : 2)) fail(usage);
	const app = resolveApp(input);
	if (app.kind === 'file' && flags['--url'] !== undefined) fail('--url picks a page; it needs an app directory with src/pages');
	const url = app.kind === 'pages' ? (flags['--url'] ?? '/') : undefined;
	const { file, location }: { file: string; location?: Location } = app.kind === 'pages' ? pageAt(discoverRoutes(app.pages), url!) : { file: app.file };
	const { evaluate, parseStateOverrides } = await import('./design');
	const compiled = compile(readFileSync(file, 'utf8'), file);
	const overrides = parseStateOverrides(compiled, state, app.root);

	if (target === 'html') {
		const out = output ?? `${stemOf(app)}.snapshot.html`;
		const html = await (await import('./targets/browser/vite')).buildStandalone(input, { overrides, design: true, url });
		await Bun.write(out, html);
		console.error(`wrote ${out}`);
		return;
	}

	const { copyFigmaClipboard, snapshotToFigma } = await import('./targets/figma');
	const { html, warnings } = await snapshotToFigma(await evaluate(compiled, overrides, { location, root: app.root }), app.name);
	for (const warning of warnings) console.error(`warning: ${warning}`);
	await copyFigmaClipboard(html);
	console.error('Copied snapshot to clipboard');
}

function routes(args: string[]) {
	const { positional } = parse(args, []);
	if (positional.length !== 1) fail(usage);
	const app = resolveApp(positional[0]);
	if (app.kind !== 'pages') fail(`${positional[0]} is a single .pat file; routes need an app directory with src/pages`);
	const manifest = discoverRoutes((app as Extract<App, { kind: 'pages' }>).pages);
	const file = (path: string) => relative(app.root, path);
	const routes = manifest.routes.map((r) => ({ ...r, file: file(r.file) }));
	console.log(JSON.stringify({ routes, notFound: manifest.notFound === BUILTIN_NOT_FOUND ? null : file(manifest.notFound) }, null, '\t'));
}

function parse(args: string[], valued: string[], withState = false) {
	const positional: string[] = [];
	const flags: Record<string, string> = {};
	const state: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (withState && arg === '--state') state.push(args[++i] ?? fail('--state needs name=value'));
		else if (withState && arg.startsWith('--state=')) state.push(arg.slice('--state='.length));
		else if (valued.includes(arg)) flags[arg] = args[++i] ?? fail(`${arg} needs a value`);
		else if (arg.startsWith('--')) fail(`unknown option ${arg}\n\n${usage}`);
		else positional.push(arg);
	}
	return { positional, flags, state };
}
