// The router: the current location of an app with pages, as reactive state.
// It starts from an explicit URL and records navigations in a `History`; the
// browser (navigation.ts) supplies `window.location` and `history.pushState`,
// design time and tests a fixed URL and no history. Which route a URL selects
// is schema/route.ts.

import { locate, matchRoute, toUrl, type Location, type Page, type RouteInfo } from '../schema/route';
import type { Reactive } from './reactive';

/** Where navigations are recorded. */
export type History = { push(url: URL): void };

/** Navigations are not recorded anywhere: the location lives only in the app. */
export const MEMORY_HISTORY: History = { push() {} };

/** What a component instance gets as `page` and `goto`. */
export type Routing = { page: Page; goto: (url: string | URL) => void };

/** `page` over a location getter: reading it reads the location. */
export function pageOf(read: () => Location): Page {
	let last: Location | null = null;
	let route = { id: null as string | null };
	return Object.freeze({
		get url() {
			return read().url;
		},
		get params() {
			return read().params;
		},
		get route() {
			const location = read();
			if (location !== last) {
				last = location;
				route = Object.freeze({ id: location.route?.id ?? null });
			}
			return route;
		}
	});
}

export type Router<R extends RouteInfo> = ReturnType<typeof createRouter<R>>;

export function createRouter<R extends RouteInfo>(r: Reactive, routes: readonly R[], start: string | URL, history: History) {
	const current = r.cell<Location<R>>(locate(routes, toUrl(start)));
	const peek = () => r.untrack(() => current.v);

	/** Shows `url` without recording it (the browser already moved there: back, forward). */
	const show = (url: string | URL) => r.batch(() => void (current.v = locate(routes, new URL(String(url), peek().url))));

	/** Moves to `url`, relative to the current one, and records it. The same URL again is not recorded. */
	const goto = (url: string | URL) => {
		const from = peek().url;
		const to = new URL(String(url), from);
		if (to.origin !== from.origin) throw new Error(`goto(${JSON.stringify(String(url))}) leaves the app (${to.origin}); use a link for other origins`);
		if (to.href === from.href) return;
		history.push(to);
		show(to);
	};

	/** Whether `url` is one of this app's routes: a URL a link click navigates to without leaving. */
	const owns = (url: URL) => url.origin === peek().url.origin && matchRoute(routes, url.pathname) !== null;

	return { location: () => current.v, peek, show, goto, owns, page: pageOf(() => current.v) };
}
