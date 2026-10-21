// Vite integration for `pat dev` and `pat build`. The .pat file is an ordinary
// module in Vite's graph (compiled by `transform`), so Vite resolves its
// imports, watches it, reloads the page when it changes and shows compile and
// type errors in its overlay. A virtual entry mounts the program. The PAT
// compiler and runtime are unchanged.

import { basename, dirname, extname, resolve } from 'node:path';
import { build, createServer, type Plugin } from 'vite';
import { CompileError, compile, htmlPage } from './compiler';

const ENTRY = '/@pat/entry.js';
const RESOLVED = '\0pat:entry';
const RUNTIME = resolve(import.meta.dir, 'runtime.ts');

export function patPlugin(file: string): Plugin {
	return {
		name: 'pat',
		resolveId: (id) => (id === ENTRY ? RESOLVED : undefined),
		load(id) {
			if (id !== RESOLVED) return;
			return [
				`import program from ${JSON.stringify(file)};`,
				`import { createRuntime } from ${JSON.stringify(RUNTIME)};`,
				`createRuntime().mount(program, document.getElementById("app"));`
			].join('\n');
		},
		transform(source, id) {
			const path = id.split('?')[0];
			if (!path.endsWith('.pat')) return;
			try {
				return { code: compile(source, path).module, map: null };
			} catch (error) {
				throw error instanceof CompileError ? overlayError(error, path) : error;
			}
		},
		configureServer(server) {
			server.middlewares.use(async (req, res, next) => {
				if (req.method !== 'GET' || !req.headers.accept?.includes('text/html')) return next();
				const html = htmlPage(title(file), `<script type="module" src="${ENTRY}"></script>`);
				res.setHeader('Content-Type', 'text/html');
				res.end(await server.transformIndexHtml(req.url ?? '/', html));
			});
		}
	};
}

const title = (file: string) => basename(file, extname(file));

// Vite's overlay shows `message`, `loc` and `frame`, and only renders frames in
// its `line | code` / `| ^^^` shape.
function overlayError(error: CompileError, file: string) {
	const lines = error.source.split('\n');
	const frame = error.diagnostics.map((d) => {
		const text = lines[d.line - 1] ?? '';
		const gutter = String(d.line);
		const width = Math.max(1, Math.min(d.end - d.start, text.length - d.column + 1));
		const code = d.code === undefined ? '' : ` (TS${d.code})`;
		return `${d.message}${code}\n${gutter} | ${text}\n${' '.repeat(gutter.length)} | ${text.slice(0, d.column - 1).replace(/[^\t]/g, ' ')}${'^'.repeat(width)}`;
	});
	const [first] = error.diagnostics;
	return Object.assign(new Error(first.message), {
		id: file,
		loc: { file, line: first.line, column: first.column },
		frame: frame.join('\n\n'),
		plugin: 'pat',
		stack: ''
	});
}

export async function startDevServer(input: string, port = 5173) {
	const file = resolve(input);
	const server = await createServer({
		configFile: false,
		root: dirname(file),
		appType: 'custom',
		plugins: [patPlugin(file)],
		server: { port, fs: { allow: [dirname(file), import.meta.dir] } }
	});
	await server.listen();
	server.printUrls();
	return server;
}

/** Bundles the app and its imports with Vite into one self-contained HTML document. */
export async function buildStandalone(input: string): Promise<string> {
	const file = resolve(input);
	const result = await build({
		configFile: false,
		root: dirname(file),
		logLevel: 'warn',
		plugins: [patPlugin(file)],
		build: {
			write: false,
			modulePreload: false,
			assetsInlineLimit: () => true,
			rolldownOptions: { input: ENTRY, output: { codeSplitting: false } }
		}
	});
	const outputs = (Array.isArray(result) ? result : [result]).flatMap((r) => ('output' in r ? r.output : []));
	const chunks = outputs.filter((o) => o.type === 'chunk');
	const css = outputs.filter((o) => o.type === 'asset' && o.fileName.endsWith('.css'));
	const other = outputs.filter((o) => o.type === 'asset' && !o.fileName.endsWith('.css'));
	if (chunks.length !== 1 || other.length) throw new Error(`Cannot inline build output: ${outputs.map((o) => o.fileName).join(', ')}`);
	const styles = css.map((o) => `<style>\n${String(o.type === 'asset' && o.source).replace(/<\/style/gi, '<\\/style')}\n</style>\n`).join('');
	const code = chunks[0].type === 'chunk' ? chunks[0].code : '';
	return htmlPage(title(file), `${styles}<script type="module">\n${code.replace(/<\/script/gi, '<\\/script')}\n</script>`);
}
