#!/usr/bin/env bun
import { basename, extname } from 'node:path';
import { compile, toHtml } from './compiler';
import { renderRunic, toRunicClipboard, toRunicHtml } from './runic-adapter';

const usage = `usage:
  pat dev <input.pat> [--port 5173]
  pat build <input.pat> [output.html]
  pat runic <input.pat> [--state name=value]... [--viewport WxH | Wxhug] [--stdout | --output file.json | file.html]
  pat lsp

dev serves the app with Vite and reloads the browser when the file changes.
build writes a standalone HTML file (compile is an alias).
runic copies the evaluated design to the clipboard for pasting into Runic.
  --state   values are parsed as JSON, falling back to a plain string
  --stdout  print the clipboard payload instead of copying it
  --output  write the node graph as JSON, or as HTML for Runic's write_html import
lsp runs the PAT language server over stdio.`;

const fail = (message: string): never => {
	console.error(message);
	process.exit(1);
};

const [command, ...rest] = process.argv.slice(2);

try {
	if (command === 'lsp') (await import('./lsp')).startLanguageServer();
	else if (command === 'dev') await dev(rest);
	else if (command === 'build' || command === 'compile') await build(rest);
	else if (command === 'runic') await runic(rest);
	else fail(usage);
} catch (error) {
	fail(error instanceof Error ? error.message : String(error));
}

async function dev(args: string[]) {
	const { positional, flags } = parse(args, ['--port']);
	if (positional.length !== 1) fail(usage);
	await (await import('./dev')).startDevServer(positional[0], flags['--port'] ? Number(flags['--port']) : undefined);
}

async function build(args: string[]) {
	const { positional } = parse(args, []);
	const [input, output] = positional;
	if (!input || positional.length > 2) fail(usage);
	const stem = input.slice(0, input.length - extname(input).length);
	const out = output ?? `${stem}.html`;
	await Bun.write(out, toHtml(compile(await Bun.file(input).text(), basename(input)), basename(stem)));
	console.error(`wrote ${out}`);
}

async function runic(args: string[]) {
	const { positional, flags, state } = parse(args, ['--viewport', '--output'], ['--stdout']);
	const [input] = positional;
	if (!input || positional.length > 1) fail(usage);
	let viewport: { width: number; height: number | 'hug' } | undefined;
	if (flags['--viewport']) {
		const [w, h] = flags['--viewport'].split('x');
		viewport = { width: Number(w), height: h === 'hug' ? 'hug' : Number(h) };
	}

	const compiled = compile(await Bun.file(input).text(), basename(input));
	const result = renderRunic(compiled, { state, viewport });
	const count = Object.keys(result.nodes).length;
	console.error(`state: ${compiled.state.map((s) => `${s.id}=${JSON.stringify(s.id in state ? state[s.id] : s.defaultValue ?? s.defaultSource)}`).join(' ')}`);

	const out = flags['--output'];
	if (out) {
		await Bun.write(out, out.endsWith('.html') ? toRunicHtml(result) : JSON.stringify(result, null, '\t'));
		console.error(`wrote ${out} (${count} nodes)`);
	} else if (flags['--stdout']) {
		process.stdout.write(toRunicClipboard(result) + '\n');
	} else {
		await copyText(toRunicClipboard(result));
		console.error(`Copied ${count} Runic nodes to clipboard.`);
	}
}

/** Writes plain text (Runic's only clipboard format) to the system clipboard. */
async function copyText(text: string) {
	const commands: Record<string, string[][]> = {
		darwin: [['pbcopy']],
		linux: [['wl-copy'], ['xclip', '-selection', 'clipboard']]
	};
	for (const cmd of commands[process.platform] ?? []) {
		if (!Bun.which(cmd[0])) continue;
		// pbcopy decodes its input with the locale's encoding.
		const proc = Bun.spawn(cmd, { stdin: 'pipe', env: { ...process.env, LANG: 'en_US.UTF-8' } });
		proc.stdin.write(text);
		await proc.stdin.end();
		if ((await proc.exited) !== 0) throw new Error(`${cmd[0]} exited with ${proc.exitCode}`);
		return;
	}
	throw new Error(`No clipboard command found for ${process.platform}; use --stdout or --output`);
}

function parse(args: string[], valued: string[], boolean: string[] = []) {
	const positional: string[] = [];
	const flags: Record<string, string> = {};
	const state: Record<string, unknown> = {};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === '--state') {
			const [name, ...value] = (args[++i] ?? '').split('=');
			const raw = value.join('=');
			try {
				state[name] = JSON.parse(raw);
			} catch {
				state[name] = raw;
			}
		} else if (valued.includes(arg)) flags[arg] = args[++i] ?? fail(`${arg} needs a value`);
		else if (boolean.includes(arg)) flags[arg] = 'true';
		else if (arg.startsWith('--')) fail(`unknown option ${arg}\n\n${usage}`);
		else positional.push(arg);
	}
	return { positional, flags, state };
}
