// The editor's view of a Patch app: VS Code's TypeScript with the Patch
// plugin (editors/vscode/ts-plugin), and Patch's language server. Both run as
// the real servers, spoken to over their protocols.

import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = resolve(import.meta.dir, '..');

function app(files: Record<string, string>) {
	const root = mkdtempSync(join(tmpdir(), 'pat-editor-'));
	for (const [path, source] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), source);
	}
	return root;
}

/** A server speaking `Content-Length`-framed JSON on stdout. `frame` frames what is sent too (LSP), else one line per message (tsserver). */
function server(args: string[], frame: boolean) {
	const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'ignore'] });
	let buffer = Buffer.alloc(0);
	const listeners = new Set<(message: any) => void>();
	child.stdout.on('data', (chunk: Buffer) => {
		buffer = Buffer.concat([buffer, chunk]);
		for (;;) {
			const header = buffer.indexOf('\r\n\r\n');
			if (header < 0) return;
			const length = Number(/Content-Length: (\d+)/.exec(buffer.subarray(0, header).toString())![1]);
			if (buffer.length < header + 4 + length) return;
			const message = JSON.parse(buffer.subarray(header + 4, header + 4 + length).toString());
			buffer = buffer.subarray(header + 4 + length);
			for (const listener of [...listeners]) listener(message);
		}
	});
	const send = (message: object) => {
		const body = JSON.stringify(message);
		child.stdin.write(frame ? `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}` : `${body}\n`);
	};
	const next = (match: (message: any) => boolean) =>
		new Promise<any>((done) => {
			const listener = (message: any) => {
				if (!match(message)) return;
				listeners.delete(listener);
				done(message);
			};
			listeners.add(listener);
		});
	return { send, next, stop: () => child.kill() };
}

function tsserver() {
	const s = server(
		[join(REPO, 'node_modules/typescript-api/lib/tsserver.js'), '--globalPlugins', 'patch-typescript-plugin', '--pluginProbeLocations', join(REPO, 'editors/vscode'), '--disableAutomaticTypingAcquisition'],
		false
	);
	let seq = 0;
	const request = (command: string, args: object) => {
		const id = ++seq;
		const response = s.next((m) => m.type === 'response' && m.request_seq === id);
		s.send({ seq: id, type: 'request', command, arguments: args });
		return response;
	};
	// What the extension does once it starts.
	const configured = request('configurePlugin', { pluginName: 'patch-typescript-plugin', configuration: { types: join(REPO, 'src/types') } });
	const diagnostics = async (file: string) => {
		await configured;
		await request('open', { file });
		const { body } = await request('semanticDiagnosticsSync', { file });
		return body.map((d: any) => `${d.start.line}:${d.start.offset} ${d.source ?? 'ts'}: ${d.text.split('\n')[0]}`);
	};
	return { diagnostics, stop: s.stop };
}

const MODULE = `type Issue = { id: number; labels: string[] };
export const workspace = $state<{ issues: Issue[] }>({ issues: [] });
`;
const IMPORTER = `import Card from './Card.pat';
import { page } from 'patch';
import { workspace } from './workspace.pat.ts';
export const parts = [Card, page];
workspace.issues = [...workspace.issues, { id: 1, labels: [] }];
workspace.issues.push({ id: 2, labels: [] });
`;

test("the editor's TypeScript sees a Patch app as Patch's checker does", async () => {
	// No tsconfig: Patch's compiler options apply anyway, as in its own checker.
	const root = app({ 'src/Card.pat': '<p>card</p>', 'src/workspace.pat.ts': MODULE, 'src/use.ts': IMPORTER, 'src/plain.ts': 'export let x = $state(1);\nexport const y = { $state: 1 }.$state;\n' });
	const ts = tsserver();
	try {
		expect(await ts.diagnostics(join(root, 'src/workspace.pat.ts'))).toEqual([]);
		expect(await ts.diagnostics(join(root, 'src/use.ts'))).toEqual([
			"6:18 ts: Property 'push' does not exist on type 'readonly { readonly id: number; readonly labels: readonly string[]; }[]'."
		]);
		expect(await ts.diagnostics(join(root, 'src/plain.ts'))).toEqual([
			'1:16 patch: $state only works in .pat files and .pat.ts / .pat.js modules; Patch does not compile this file'
		]);
	} finally {
		ts.stop();
	}
}, 30000);

test('outside a Patch project the plugin leaves TypeScript alone', async () => {
	const root = app({ 'src/plain.ts': 'export let x = $state(1);\n' });
	const ts = tsserver();
	try {
		expect(await ts.diagnostics(join(root, 'src/plain.ts'))).toEqual(["1:16 ts: Cannot find name '$state'."]);
	} finally {
		ts.stop();
	}
}, 30000);

test("the language server publishes Patch's diagnostics for .pat.ts modules, and TypeScript's only for .pat files", async () => {
	const root = app({ 'src/workspace.pat.ts': MODULE });
	const lsp = server([join(REPO, 'src/cli.ts'), 'lsp'], true);
	const published = (uri: string) => lsp.next((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === uri);
	const open = (path: string, languageId: string, text: string) => {
		const uri = pathToFileURL(path).href;
		const diagnostics = published(uri);
		lsp.send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId, version: 1, text } } });
		return diagnostics.then((m) => m.params.diagnostics.map((d: any) => `${d.range.start.line}:${d.range.start.character} ${d.source}: ${d.message}`));
	};
	try {
		const initialized = lsp.next((m) => m.id === 1);
		lsp.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { processId: null, rootUri: pathToFileURL(root).href, capabilities: {} } });
		await initialized;
		lsp.send({ jsonrpc: '2.0', method: 'initialized', params: {} });
		// A Patch error and a type error: only the Patch error is published (the editor's TypeScript reports the other).
		expect(await open(join(root, 'src/bad.pat.ts'), 'typescript', 'export let a = $state({ n: 1 });\nexport const b: number = "x";\n')).toEqual([
			'0:7 pat: module state is declared as `const name = $state({ key: value, … })` at the top level; it is const, since the binding never changes (assign its properties)'
		]);
		expect(await open(join(root, 'src/App.pat'), 'pat', `<script lang="ts">\n\timport { workspace } from './workspace.pat.ts';\n\tworkspace.issues[0].labels = [];\n</script>\n<p>x</p>\n`)).toEqual([
			"2:21 typescript: Cannot assign to 'labels' because it is a read-only property."
		]);
	} finally {
		lsp.stop();
	}
}, 30000);
