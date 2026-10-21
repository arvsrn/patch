#!/usr/bin/env bun
import { basename, extname } from 'node:path';
import { CompileError, compile, toHtml } from './compiler';
import { renderRunic, toRunicHtml } from './runic-adapter';

const usage = `usage:
  bun index.ts compile <input.pat> [output.html]
  bun index.ts runic <input.pat> [output.json | output.html] [--state name=value]... [--viewport WxH | Wxhug]
  bun index.ts lsp

--state values are parsed as JSON, falling back to a plain string.
An .html runic output is the node graph wrapped for Runic's write_html import.
lsp runs the PAT language server over stdio.`;

const [command, ...rest] = process.argv.slice(2);

if (command === 'lsp') {
	(await import('./lsp')).startLanguageServer();
} else if (command === 'compile' || command === 'runic') {
	await build(command, rest);
} else {
	console.error(usage);
	process.exit(1);
}

async function build(command: 'compile' | 'runic', args: string[]) {
	const positional: string[] = [];
	const state: Record<string, unknown> = {};
	let viewport: { width: number; height: number | 'hug' } | undefined;

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
		} else if (arg === '--viewport') {
			const [w, h] = (args[++i] ?? '').split('x');
			viewport = { width: Number(w), height: h === 'hug' ? 'hug' : Number(h) };
		} else positional.push(arg);
	}

	const [input, output] = positional;
	if (!input) {
		console.error(usage);
		process.exit(1);
	}

	try {
		const source = await Bun.file(input).text();
		const compiled = compile(source, basename(input));
		const stem = input.slice(0, input.length - extname(input).length);
		if (command === 'compile') {
			const out = output ?? `${stem}.html`;
			await Bun.write(out, toHtml(compiled, basename(stem)));
			console.error(`wrote ${out}`);
		} else {
			const out = output ?? `${stem}.runic.json`;
			const result = renderRunic(compiled, { state, viewport });
			await Bun.write(out, out.endsWith('.html') ? toRunicHtml(result) : JSON.stringify(result, null, '\t'));
			console.error(`state: ${compiled.state.map((s) => `${s.id}=${JSON.stringify(s.id in state ? state[s.id] : s.defaultValue ?? s.defaultSource)}`).join(' ')}`);
			console.error(`wrote ${out} (${Object.keys(result.nodes).length} nodes)`);
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	}
}
