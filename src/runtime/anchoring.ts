// Anchored positioning in the browser. Patch owns the geometry: an anchored
// element's left/top are derived from its anchor's rendered box with
// `placeAnchored`, after every render (the renderer calls `update`) and
// whenever boxes move without one: the viewport resizes, anything scrolls, or
// an anchor or anchored element changes size.
//
// The viewport is the app's host. An anchored element is still absolutely
// positioned in its rendered parent, so it scrolls and clips with it; render
// it into a portal to take it out of a clipping parent.

import { placeAnchored } from '../schema/anchor';

export type Anchoring = ReturnType<typeof createAnchoring>;

export type AnchorSpec = { name: string; position: string; offset: number; at: string };

export function createAnchoring(host: HTMLElement) {
	/** Elements by anchor name, in mount order. The first is the anchor; the others are duplicates. */
	const anchors = new Map<string, HTMLElement[]>();
	const names = new Map<HTMLElement, string>();
	const anchored = new Map<HTMLElement, AnchorSpec & { left?: string; top?: string }>();
	/** Anchored elements already reported as having no anchor, until they get one. */
	const reported = new Set<HTMLElement>();
	const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => update());
	const observe = (el: HTMLElement) => {
		if (anchored.has(el) || names.has(el)) observer?.observe(el);
		else observer?.unobserve(el);
	};

	/** Places one element. Returns whether it moved. */
	const place = (el: HTMLElement, spec: AnchorSpec & { left?: string; top?: string }): boolean => {
		const anchor = anchors.get(spec.name)?.find((a) => a.isConnected);
		if (!anchor) {
			el.style.setProperty('visibility', 'hidden');
			if (!reported.has(el)) {
				reported.add(el);
				console.error(`No element with anchorName="${spec.name}" is rendered; the element anchored to it at ${spec.at} is hidden until one is`);
			}
			return false;
		}
		reported.delete(el);
		el.style.removeProperty('visibility');
		const parent = (el.offsetParent ?? el.parentElement) as HTMLElement | null;
		if (!parent) return false;
		const frame = host.getBoundingClientRect();
		const viewport = { x: frame.left + host.clientLeft, y: frame.top + host.clientTop, width: host.clientWidth, height: host.clientHeight };
		const box = el.getBoundingClientRect();
		const { x, y } = placeAnchored(anchor.getBoundingClientRect(), box, viewport, spec.position, spec.offset);
		// left/top are inside the parent's padding box, which scrolls with it.
		const origin = parent.getBoundingClientRect();
		const left = `${x - origin.left - parent.clientLeft + parent.scrollLeft}px`;
		const top = `${y - origin.top - parent.clientTop + parent.scrollTop}px`;
		if (left === spec.left && top === spec.top) return false;
		el.style.setProperty('left', (spec.left = left));
		el.style.setProperty('top', (spec.top = top));
		return true;
	};

	/**
	 * Places every rendered anchored element. An anchor may itself be inside
	 * an anchored element, so this repeats (a few times at most) while
	 * something moved.
	 */
	const update = () => {
		for (let pass = 0; pass < 3; pass++) {
			let moved = false;
			for (const [el, spec] of anchored) if (el.isConnected && place(el, spec)) moved = true;
			if (!moved || anchored.size < 2) return;
		}
	};
	// Listening only while something is anchored.
	let listening = false;
	const listen = (on: boolean) => {
		if (on === listening) return;
		listening = on;
		if (on) {
			window.addEventListener('resize', update);
			document.addEventListener('scroll', update, { capture: true, passive: true });
		} else {
			window.removeEventListener('resize', update);
			document.removeEventListener('scroll', update, { capture: true });
		}
	};

	return {
		update,
		/** Whether any element is anchored: otherwise nothing needs placing after a render. */
		active: () => anchored.size > 0,
		/** Gives `el` an anchor name, or takes it away (null). */
		name(el: HTMLElement, name: string | null, at: string) {
			const previous = names.get(el);
			if (previous === (name ?? undefined)) return;
			if (previous !== undefined) {
				const list = anchors.get(previous)!;
				list.splice(list.indexOf(el), 1);
				if (!list.length) anchors.delete(previous);
				names.delete(el);
			}
			if (name !== null) {
				const list = anchors.get(name) ?? [];
				if (list.length) console.error(`Duplicate anchorName "${name}" (at ${at}); elements anchored to it follow the first one rendered`);
				list.push(el);
				anchors.set(name, list);
				names.set(el, name);
			}
			observe(el);
		},
		/**
		 * Anchors `el` (`spec`), or stops (null). `own` is the element's own
		 * inline CSS, which keeps any left/top it sets.
		 */
		track(el: HTMLElement, spec: AnchorSpec | null, own: Record<string, string>) {
			const previous = anchored.get(el);
			if (spec) {
				anchored.set(el, previous && previous.name === spec.name ? { ...previous, ...spec } : spec);
				el.setAttribute('data-anchored', '');
			} else if (previous) {
				anchored.delete(el);
				reported.delete(el);
				el.removeAttribute('data-anchored');
				el.style.removeProperty('visibility');
				for (const key of ['left', 'top']) if (!(key in own)) el.style.removeProperty(key);
			}
			observe(el);
			listen(anchored.size > 0);
		},
		dispose() {
			listen(false);
			observer?.disconnect();
		}
	};
}
