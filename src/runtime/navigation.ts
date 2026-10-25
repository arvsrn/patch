// Browser navigation for an app with pages: the window's history, and which
// link clicks become client-side navigations.

import type { History } from './router';

/** The parts of `window` navigation uses. */
export type NavigationWindow = {
	location: { href: string };
	history: { pushState(data: unknown, unused: string, url: string): void };
	addEventListener(type: 'popstate', listener: () => void): void;
	removeEventListener(type: 'popstate', listener: () => void): void;
};

export const browserHistory = (win: NavigationWindow): History => ({ push: (url) => win.history.pushState(null, '', url.href) });

type Click = { defaultPrevented: boolean; button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean };
type Anchor = { getAttribute(name: string): string | null; hasAttribute(name: string): boolean };

/**
 * The URL a click on `anchor` navigates to when the app should handle it,
 * else null and the browser handles it. The app handles a plain left click
 * on a link to one of its own routes (`owns`). It leaves alone a click that a
 * handler already prevented, with a modifier key or another button, a link
 * with a `target` other than `_self`, `download` or `rel="external"`, a URL
 * on another origin (including `mailto:` and the like), one no route
 * matches, and a link to a fragment of the current page.
 */
export function appLink(event: Click, anchor: Anchor, current: URL, owns: (url: URL) => boolean): URL | null {
	if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
	const target = anchor.getAttribute('target');
	if (target && target !== '_self') return null;
	if (anchor.hasAttribute('download')) return null;
	if ((anchor.getAttribute('rel') ?? '').split(/\s+/).includes('external')) return null;
	const href = anchor.getAttribute('href');
	if (href === null) return null;
	let url: URL;
	try {
		url = new URL(href, current);
	} catch {
		return null;
	}
	if (url.origin !== current.origin || !owns(url)) return null;
	if (url.hash && url.pathname === current.pathname && url.search === current.search) return null;
	return url;
}
