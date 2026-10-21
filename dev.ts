// `pat dev`: Vite serves a generated host page whose entry module is the
// compiled .pat file. Vite owns the HTTP server, file watching, the reload
// channel and the error overlay; the PAT compiler and runtime are unchanged.

import { readFileSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { createServer, type Plugin } from 'vite';
import { CompileError, compile, htmlPage, mountScript } from './compiler';

const ENTRY = '/@pat/app.js';
const RESOLVED = '\0pat:app';
const RUNTIME = resolve(import.meta.dir, 'runtime.ts');

/** Serves `file` as the app at `/`. Saving the file reloads the page. */
export function patPlugin(file: string): Plugin {
	const title = basename(file, extname(file));
	return {
		name: 'pat',
		resolveId: (id) => (id === ENTRY ? RESOLVED : undefined),
		load(id) {
			if (id !== RESOLVED) return;
			this.addWatchFile(file);
			const source = readFileSync(file, 'utf8');
			try {
				return `import { createRuntime } from ${JSON.stringify(RUNTIME)};\n${mountScript(compile(source, basename(file)))}\n`;
			} catch (error) {
				if (!(error instanceof CompileError)) throw error;
				// Vite's overlay shows `message`, `loc` and `frame`, and only renders
				// frames in its `line | code` / `| ^^^` shape.
				const [first] = error.diagnostics;
				const lines = source.split('\n');
				const frame = error.diagnostics.map((d) => {
					const text = lines[d.line - 1] ?? '';
					const gutter = String(d.line);
					const width = Math.max(1, Math.min(d.end - d.start, text.length - d.column + 1));
					return `${d.message}\n${gutter} | ${text}\n${' '.repeat(gutter.length)} | ${text.slice(0, d.column - 1).replace(/[^\t]/g, ' ')}${'^'.repeat(width)}`;
				});
				throw Object.assign(new Error(first.message), {
					id: file,
					loc: { file, line: first.line, column: first.column },
					frame: frame.join('\n\n'),
					plugin: 'pat',
					stack: ''
				});
			}
		},
		hotUpdate({ file: changed }) {
			if (this.environment.name !== 'client' || resolve(changed) !== file) return;
			const module = this.environment.moduleGraph.getModuleById(RESOLVED);
			if (module) this.environment.moduleGraph.invalidateModule(module);
			this.environment.hot.send({ type: 'full-reload' });
			return [];
		},
		configureServer(server) {
			server.middlewares.use(async (req, res, next) => {
				if (req.method !== 'GET' || !req.headers.accept?.includes('text/html')) return next();
				const html = htmlPage(title, `<script type="module" src="${ENTRY}"></script>`);
				res.setHeader('Content-Type', 'text/html');
				res.end(await server.transformIndexHtml(req.url ?? '/', html));
			});
		}
	};
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
