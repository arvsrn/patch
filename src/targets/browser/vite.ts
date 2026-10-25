// Vite integration for `patch dev`, `patch build` and `patch snapshot html`.
// The .pat file is an ordinary module in Vite's graph (compiled by
// `transform`), so Vite resolves its imports, watches it, reloads the page
// when it changes and shows compile and type errors in its overlay. A virtual
// entry mounts the app, optionally from overridden state. Imported .pat
// components are modules of the graph like the entry. `patch` (what .ts
// modules import createContext from) resolves to the runtime's context module.
//
// An app with pages mounts the route manifest, the virtual module
// `/@pat/routes.js`: generated from src/pages (routes.ts) when it loads, and
// again when a page is added or removed in dev.
//
// .pat.ts / .pat.js modules are compiled before Vite's own TypeScript
// transform sees them. Overrides of their module state are set by the first
// module the entry imports, before any of the app's modules is evaluated.

import { basename, resolve, sep } from 'node:path';
import { build, createServer, type Plugin } from 'vite';
import { compile, compileModule } from '../../compile';
import { CompileError } from '../../diagnostics';
import { discoverRoutes, resolveApp, type App, type RouteManifest } from '../../routes';
import type { MountOptions } from '../../runtime/dom';
import { isPatModule, parseModuleStateId } from '../../schema/path';
import { htmlPage, overlayError } from './html';

const ENTRY = '/@pat/entry.js';
const RESOLVED = '\0pat:entry';
const ROUTES = '/@pat/routes.js';
const RESOLVED_ROUTES = '\0pat:routes';
const MODULE_OVERRIDES = '/@pat/module-overrides.js';
const RESOLVED_MODULE_OVERRIDES = '\0pat:module-overrides';
const MODULE_STATE = resolve(import.meta.dir, '../../runtime/module-state.ts');
const DOM = resolve(import.meta.dir, '../../runtime/dom.ts');
export const PATCH_MODULE = resolve(import.meta.dir, '../../runtime/context.ts');
const REPO = resolve(import.meta.dir, '../../..');

/** The manifest as a module: each page imported, `routes` in precedence order, and `notFound`. */
export function routesModule(manifest: RouteManifest): string {
	const files = [...manifest.routes.map((r) => r.file), manifest.notFound];
	return [
		...files.map((file, i) => `import page${i} from ${JSON.stringify(file)};`),
		`export const routes = [`,
		...manifest.routes.map((r, i) => `\t{ id: ${JSON.stringify(r.id)}, pattern: ${JSON.stringify(r.pattern)}, params: ${JSON.stringify(r.params)}, program: page${i} },`),
		`];`,
		`export const notFound = page${files.length - 1};`
	].join('\n');
}

export function patPlugin(app: App, mount: MountOptions = {}): Plugin {
	const moduleOverrides = Object.fromEntries(Object.entries(mount.overrides ?? {}).filter(([id]) => parseModuleStateId(id)));
	const virtual = new Map([
		[ENTRY, RESOLVED],
		[ROUTES, RESOLVED_ROUTES],
		[MODULE_OVERRIDES, RESOLVED_MODULE_OVERRIDES],
		['patch', PATCH_MODULE]
	]);
	return {
		name: 'pat',
		enforce: 'pre',
		resolveId: (id) => virtual.get(id),
		load(id) {
			if (id === RESOLVED_ROUTES && app.kind === 'pages') return routesModule(discoverRoutes(app.pages));
			if (id === RESOLVED_MODULE_OVERRIDES)
				return `import { setModuleOverrides } from ${JSON.stringify(MODULE_STATE)};\nsetModuleOverrides(${JSON.stringify(moduleOverrides)});`;
			if (id !== RESOLVED) return;
			return [
				...(Object.keys(moduleOverrides).length ? [`import ${JSON.stringify(MODULE_OVERRIDES)};`] : []),
				app.kind === 'file' ? `import app from ${JSON.stringify(app.file)};` : `import * as app from ${JSON.stringify(ROUTES)};`,
				`import { mount } from ${JSON.stringify(DOM)};`,
				`mount(app, document.getElementById("app"), ${JSON.stringify(mount)});`
			].join('\n');
		},
		transform(source, id) {
			const path = id.split('?')[0];
			if (!path.endsWith('.pat') && !isPatModule(path)) return;
			try {
				return { code: path.endsWith('.pat') ? compile(source, path).module : compileModule(source, path, app.root).module, map: null };
			} catch (error) {
				throw error instanceof CompileError ? overlayError(error, path) : error;
			}
		},
		configureServer(server) {
			// Every URL is the app: an app with pages routes it in the browser.
			server.middlewares.use(async (req, res, next) => {
				if (req.method !== 'GET' || !req.headers.accept?.includes('text/html')) return next();
				const html = htmlPage(app.name, `<script type="module" src="${ENTRY}"></script>`);
				res.setHeader('Content-Type', 'text/html');
				res.end(await server.transformIndexHtml(req.url ?? '/', html));
			});
			if (app.kind !== 'pages') return;
			server.watcher.add(app.pages);
			server.watcher.on('all', (event, path) => {
				if (!['add', 'unlink', 'addDir', 'unlinkDir'].includes(event) || !resolve(path).startsWith(app.pages + sep)) return;
				const routes = server.moduleGraph.getModuleById(RESOLVED_ROUTES);
				if (routes) server.moduleGraph.invalidateModule(routes);
				server.ws.send({ type: 'full-reload' });
			});
		}
	};
}

export async function startDevServer(input: string, port = 5173) {
	const app = resolveApp(input);
	const server = await createServer({
		configFile: false,
		root: app.root,
		appType: 'custom',
		plugins: [patPlugin(app)],
		server: { port, fs: { allow: [app.root, REPO] } }
	});
	await server.listen();
	server.printUrls();
	return server;
}

/**
 * Bundles the app and its imports with Vite into one self-contained HTML
 * document. `mount` starts it from overridden state; with `design`, its
 * effects start at the first interaction; with `url`, an app with pages
 * starts at that URL instead of the browser's.
 */
export async function buildStandalone(input: string, mount: MountOptions = {}): Promise<string> {
	const app = resolveApp(input);
	const result = await build({
		configFile: false,
		root: app.root,
		logLevel: 'warn',
		plugins: [patPlugin(app, mount)],
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
	return htmlPage(app.name, `${styles}<script type="module">\n${code.replace(/<\/script/gi, '<\\/script')}\n</script>`);
}
