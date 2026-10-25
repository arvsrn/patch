// Pages: the routes of an app, read from the filesystem without running any
// of its code.
//
//   src/pages/+page.pat               /
//   src/pages/issues/+page.pat        /issues
//   src/pages/issues/[id]/+page.pat   /issues/:id
//   src/pages/+404.pat                rendered when no route matches (optional)
//
// Other files under src/pages (components, modules) are not routes. The
// manifest lists routes in precedence order (see schema/route.ts) and always
// has a not-found page: the app's +404.pat, else Patch's built-in one.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { compareRoutes, locate, parseSegment, routeInfo, shapeOf, toUrl, type Location, type RouteInfo, type Segment } from './schema/route';

export const PAGE_FILE = '+page.pat';
export const NOT_FOUND_FILE = '+404.pat';
export const BUILTIN_NOT_FOUND = resolve(import.meta.dir, 'runtime/not-found.pat');

/** A route and the file of its page. */
export type PageFile = RouteInfo & { file: string };

export type RouteManifest = {
	/** The src/pages directory. */
	dir: string;
	routes: PageFile[];
	/** The not-found page: src/pages/+404.pat, or BUILTIN_NOT_FOUND. */
	notFound: string;
};

/** What `patch <command> <path>` runs: one .pat file, or a directory whose src/pages are its routes. */
export type App = { kind: 'file'; name: string; root: string; file: string } | { kind: 'pages'; name: string; root: string; pages: string };

export function resolveApp(input: string): App {
	const path = resolve(input);
	if (!existsSync(path)) throw new Error(`${input} does not exist`);
	if (!statSync(path).isDirectory()) return { kind: 'file', name: basename(path).replace(/\.[^.]*$/, ''), root: resolve(path, '..'), file: path };
	const pages = join(path, 'src', 'pages');
	if (!existsSync(pages) || !statSync(pages).isDirectory()) throw new Error(`${input} is a directory without src/pages; pass a .pat file, or an app directory with src/pages/+page.pat`);
	return { kind: 'pages', name: basename(path), root: path, pages };
}

/** The routes under `dir` (an app's src/pages). Throws on anything that is not a valid, unambiguous route. */
export function discoverRoutes(dir: string): RouteManifest {
	const root = resolve(dir);
	const routes: PageFile[] = [];
	const errors: string[] = [];
	let notFound: string | null = null;
	const where = (file: string) => `src/pages/${relative(root, file)}`;

	const walk = (path: string, segments: Segment[] | null) => {
		const entries = readdirSync(path, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		for (const entry of entries) {
			if (entry.name.startsWith('.')) continue;
			const full = join(path, entry.name);
			if (entry.isDirectory()) {
				const segment = parseSegment(entry.name);
				walk(full, segments && !('error' in segment) ? [...segments, segment] : null);
				// A directory only has to be a valid segment when a page is below it.
				if ('error' in segment && hasPage(full)) errors.push(`${where(full)}: ${segment.error}`);
			} else if (entry.name === PAGE_FILE) {
				if (!segments) continue;
				const route = { ...routeInfo(segments), file: full };
				const repeated = route.params.find((p, i) => route.params.indexOf(p) !== i);
				if (repeated) errors.push(`${where(full)}: the param [${repeated}] appears twice in ${route.id}`);
				else routes.push(route);
			} else if (entry.name === NOT_FOUND_FILE && path === root) notFound = full;
			else if (entry.name === NOT_FOUND_FILE) errors.push(`${where(full)}: ${NOT_FOUND_FILE} is only supported directly in src/pages`);
			else if (entry.name.startsWith('+')) errors.push(`${where(full)}: only ${PAGE_FILE} and src/pages/${NOT_FOUND_FILE} are supported (no layouts, loaders or other + files)`);
		}
	};
	walk(root, []);

	const shapes = new Map<string, PageFile>();
	for (const route of routes) {
		const other = shapes.get(shapeOf(route));
		if (other) errors.push(`${other.id} (${where(other.file)}) and ${route.id} (${where(route.file)}) match the same URLs; rename one so they differ by a static segment`);
		else shapes.set(shapeOf(route), route);
	}
	if (!routes.length && !errors.length) errors.push(`no pages: add src/pages/${PAGE_FILE}`);
	if (errors.length) throw new Error(`Invalid routes in ${root}:\n${errors.map((e) => `  ${e}`).join('\n')}`);
	return { dir: root, routes: routes.sort(compareRoutes), notFound: notFound ?? BUILTIN_NOT_FOUND };
}

const hasPage = (dir: string): boolean =>
	readdirSync(dir, { withFileTypes: true }).some((e) => (e.isDirectory() ? !e.name.startsWith('.') && hasPage(join(dir, e.name)) : e.name === PAGE_FILE));

/** The page `url` (a path, or a full URL) selects, and the location it is evaluated at. */
export function pageAt(manifest: RouteManifest, url: string): { file: string; location: Location<PageFile> } {
	const location = locate(manifest.routes, toUrl(url));
	return { file: location.route?.file ?? manifest.notFound, location };
}
