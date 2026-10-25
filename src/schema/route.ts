// Routes: what a URL path resolves to. Shared by build-time discovery
// (routes.ts), design-time evaluation and the browser router, so all three
// agree on which page a URL selects.
//
//   segment   one directory under src/pages: `issues` (static) or `[id]` (a param)
//   route id  the directories from src/pages, `/issues/[id]`; `/` for src/pages itself
//   pattern   the same with `:name` params, `/issues/:id`
//
// Route ids name application routes; they are unrelated to the rendered-node
// paths and state ids of schema/path.ts.

/** One directory of a route: a literal path segment, or a parameter matching any one segment. */
export type Segment = { kind: 'static'; value: string } | { kind: 'param'; name: string };

/** A route as tooling sees it. `params` are the param names, in path order. */
export type RouteInfo = { id: string; pattern: string; params: string[] };

/** The route a URL resolved to (null: none, the not-found page), and its decoded path params. */
export type Location<R extends RouteInfo = RouteInfo> = { url: URL; route: R | null; params: Readonly<Record<string, string>> };

/** What `page` from 'patch' reads: the current location. */
export type Page = {
	readonly url: URL;
	readonly params: Readonly<Record<string, string>>;
	readonly route: { readonly id: string | null };
};

/** The origin an explicit URL given as a bare path (`/issues/1`) is resolved against. */
export const DEFAULT_ORIGIN = 'http://localhost';

export const toUrl = (url: string | URL) => new URL(String(url), DEFAULT_ORIGIN);

const PARAM = /^\[([A-Za-z_][A-Za-z0-9_]*)\]$/;
const RESERVED = /[[\]()+:*?#%]/;

/** The segment a directory name stands for, or why it cannot be one. */
export function parseSegment(name: string): Segment | { error: string } {
	const param = PARAM.exec(name);
	if (param) return { kind: 'param', name: param[1] };
	if (name.startsWith('[...') || name.startsWith('[[...')) return { error: `catch-all segments are not supported ("${name}")` };
	if (name.startsWith('[[')) return { error: `optional segments are not supported ("${name}")` };
	if (name.includes('[')) return { error: `"${name}": a param is a whole directory named [name], with a name made of letters, digits and _` };
	if (RESERVED.test(name)) return { error: `"${name}": a static segment cannot contain any of [ ] ( ) + : * ? # %` };
	return { kind: 'static', value: name };
}

export const routeId = (segments: Segment[]) => '/' + segments.map((s) => (s.kind === 'static' ? s.value : `[${s.name}]`)).join('/');
export const routePattern = (segments: Segment[]) => '/' + segments.map((s) => (s.kind === 'static' ? s.value : `:${s.name}`)).join('/');

export function routeInfo(segments: Segment[]): RouteInfo {
	return { id: routeId(segments), pattern: routePattern(segments), params: segments.flatMap((s) => (s.kind === 'param' ? [s.name] : [])) };
}

const parsed = new WeakMap<RouteInfo, Segment[]>();

/** The segments of a route id. */
export function routeSegments(route: RouteInfo): Segment[] {
	let segments = parsed.get(route);
	if (!segments) {
		segments = route.id === '/' ? [] : route.id.slice(1).split('/').map((name) => {
			const s = parseSegment(name);
			if ('error' in s) throw new Error(`Invalid route id ${route.id}: ${s.error}`);
			return s;
		});
		parsed.set(route, segments);
	}
	return segments;
}

/**
 * Precedence, and the order routes are listed in: segment by segment, a
 * route that ends comes first, a static segment before a param, statics in
 * code-point order. Of two routes matching the same URL (same length), the
 * one with a static segment where the other first has a param wins:
 * `/issues/new` over `/issues/[id]`, `/a/[x]` over `/[y]/b`.
 */
export function compareRoutes(a: RouteInfo, b: RouteInfo): number {
	const x = routeSegments(a);
	const y = routeSegments(b);
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		if (!x[i] || !y[i]) return x[i] ? 1 : -1;
		if (x[i].kind !== y[i].kind) return x[i].kind === 'static' ? -1 : 1;
		const p = x[i].kind === 'static' ? (x[i] as { value: string }).value : '';
		const q = y[i].kind === 'static' ? (y[i] as { value: string }).value : '';
		if (p !== q) return p < q ? -1 : 1;
	}
	return 0;
}

/** Two routes conflict when they match exactly the same URLs: the same segments, params named differently. */
export const shapeOf = (route: RouteInfo) => '/' + routeSegments(route).map((s) => (s.kind === 'static' ? s.value : '[]')).join('/');

/**
 * A URL path as decoded segments. One trailing slash is ignored (`/issues/`
 * is `/issues`); an empty segment (`/a//b`) or malformed percent-encoding
 * matches nothing.
 */
function pathSegments(pathname: string): string[] | null {
	let path = pathname.startsWith('/') ? pathname.slice(1) : pathname;
	if (path.endsWith('/')) path = path.slice(0, -1);
	if (!path) return [];
	const raw = path.split('/');
	if (raw.includes('')) return null;
	try {
		return raw.map(decodeURIComponent);
	} catch {
		return null;
	}
}

/** The route `pathname` selects, by precedence, with its decoded params; null when none matches. */
export function matchRoute<R extends RouteInfo>(routes: readonly R[], pathname: string): { route: R; params: Record<string, string> } | null {
	const parts = pathSegments(pathname);
	if (!parts) return null;
	let best: { route: R; params: Record<string, string> } | null = null;
	for (const route of routes) {
		const segments = routeSegments(route);
		if (segments.length !== parts.length) continue;
		const params: Record<string, string> = {};
		const matches = segments.every((s, i) => (s.kind === 'static' ? s.value === parts[i] : ((params[s.name] = parts[i]), true)));
		if (matches && (!best || compareRoutes(route, best.route) < 0)) best = { route, params };
	}
	return best;
}

/** Where `url` leads: the matched route and its params. The query stays on the URL. */
export function locate<R extends RouteInfo>(routes: readonly R[], url: URL): Location<R> {
	const match = matchRoute(routes, url.pathname);
	return { url, route: match?.route ?? null, params: Object.freeze(match?.params ?? {}) };
}
