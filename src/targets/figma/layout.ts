// Auto-layout resolution: the size and position of every layer, so the pasted
// layers open at the size they render at. Widths are resolved before heights
// because a wrapped text's height depends on its width.
//
// Fill shares the free space of the main axis equally and stretches across
// it; hug is the content size; fixed is the value. min/max clamp the result.

import { placeAnchored } from '../../schema/anchor';
import type { FigmaFrame, FigmaNode, FigmaText } from './adapter';
import type { TextMeasure } from './text';

type Axis = 'width' | 'height';

const clamp = (node: FigmaNode, axis: Axis, v: number) => {
	const min = axis === 'width' ? node.minWidth : node.minHeight;
	const max = axis === 'width' ? node.maxWidth : node.maxHeight;
	return Math.max(min ?? 0, Math.min(max ?? Infinity, v));
};
const flow = (frame: FigmaFrame) => frame.children.filter((c) => !c.absolute);
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const gaps = (frame: FigmaFrame, n: number) => frame.gap * Math.max(0, n - 1);

export function layout(root: FigmaFrame, measure: TextMeasure) {
	const hugWidths = new Map<FigmaNode, number>();
	const rows = new Map<FigmaFrame, FigmaNode[][]>();
	const wraps = (n: FigmaText) => n.width.kind !== 'HUG';

	/** Width from content, before any fill: unwrapped text, children side by side or stacked. */
	const hugWidth = (node: FigmaNode): number => {
		const cached = hugWidths.get(node);
		if (cached !== undefined) return cached;
		let w: number;
		if (node.width.kind === 'FIXED') w = node.width.value;
		else if (node.type === 'TEXT') w = measure(node).width;
		else {
			const kids = flow(node).map(own);
			w = (node.direction === 'HORIZONTAL' ? sum(kids) + gaps(node, kids.length) : Math.max(0, ...kids)) + node.padding[1] + node.padding[3];
		}
		w = clamp(node, 'width', w);
		hugWidths.set(node, w);
		return w;
	};
	const own = (node: FigmaNode) => (node.width.kind === 'FIXED' ? clamp(node, 'width', node.width.value) : hugWidth(node));

	/** Fill children share what fixed and hugging siblings leave. */
	const share = (kids: FigmaNode[], axis: Axis, inner: number, frame: FigmaFrame, size: (n: FigmaNode) => number) => {
		const fills = kids.filter((k) => k[axis].kind === 'FILL');
		const used = sum(kids.filter((k) => k[axis].kind !== 'FILL').map(size)) + gaps(frame, kids.length);
		const each = Math.max(0, (inner - used) / (fills.length || 1));
		return new Map(kids.map((k) => [k, k[axis].kind === 'FILL' ? clamp(k, axis, each) : size(k)]));
	};

	const resolveWidth = (node: FigmaNode, w: number) => {
		node.w = w;
		if (node.type !== 'FRAME') return;
		const inner = w - node.padding[1] - node.padding[3];
		const kids = flow(node);
		let widths: Map<FigmaNode, number>;
		if (node.direction === 'VERTICAL') widths = new Map(kids.map((k) => [k, k.width.kind === 'FILL' ? clamp(k, 'width', inner) : own(k)]));
		else if (!node.wrap) widths = share(kids, 'width', inner, node, own);
		else {
			// Break into rows at content widths, then let fills share each row.
			const lines: FigmaNode[][] = [];
			let line: FigmaNode[] = [];
			let used = 0;
			for (const k of kids) {
				const kw = own(k);
				if (line.length && used + node.gap + kw > inner + 0.01) {
					lines.push(line);
					line = [];
					used = 0;
				}
				used += (line.length ? node.gap : 0) + kw;
				line.push(k);
			}
			if (line.length) lines.push(line);
			rows.set(node, lines);
			widths = new Map();
			for (const l of lines) {
				const free = Math.max(0, inner - sum(l.map(own)) - gaps(node, l.length));
				const fills = l.filter((k) => k.width.kind === 'FILL');
				for (const k of l) widths.set(k, k.width.kind === 'FILL' ? clamp(k, 'width', own(k) + free / fills.length) : own(k));
			}
		}
		for (const k of kids) resolveWidth(k, widths.get(k)!);
		for (const k of node.children) if (k.absolute) resolveWidth(k, own(k));
	};

	const hugHeight = (node: FigmaNode): number => {
		let h: number;
		if (node.height.kind === 'FIXED') h = node.height.value;
		else if (node.type === 'TEXT') h = measure(node, wraps(node) ? node.w : undefined).height;
		else {
			const lines = node.direction === 'VERTICAL' ? null : (rows.get(node) ?? [flow(node)]);
			const kids = flow(node).map(ownHeight);
			const content = lines
				? sum(lines.map((l) => Math.max(0, ...l.map(ownHeight)))) + node.gap * Math.max(0, lines.length - 1)
				: sum(kids) + gaps(node, kids.length);
			h = content + node.padding[0] + node.padding[2];
		}
		return clamp(node, 'height', h);
	};
	const ownHeight = (node: FigmaNode) => (node.height.kind === 'FIXED' ? clamp(node, 'height', node.height.value) : hugHeight(node));

	const resolveHeight = (node: FigmaNode, h: number) => {
		node.h = h;
		if (node.type !== 'FRAME') return;
		const inner = h - node.padding[0] - node.padding[2];
		const kids = flow(node);
		let heights: Map<FigmaNode, number>;
		if (node.direction === 'VERTICAL') heights = share(kids, 'height', inner, node, ownHeight);
		else {
			heights = new Map();
			const lines = rows.get(node) ?? [kids];
			for (const l of lines) {
				const cross = lines.length > 1 ? Math.max(0, ...l.map(ownHeight)) : inner;
				for (const k of l) heights.set(k, k.height.kind === 'FILL' ? clamp(k, 'height', cross) : ownHeight(k));
			}
		}
		for (const k of kids) resolveHeight(k, heights.get(k)!);
		for (const k of node.children) if (k.absolute) resolveHeight(k, ownHeight(k));
	};

	const place = (frame: FigmaFrame) => {
		const horizontal = frame.direction === 'HORIZONTAL';
		const [top, right, bottom, left] = frame.padding;
		const mainStart = horizontal ? left : top;
		const innerMain = horizontal ? frame.w - left - right : frame.h - top - bottom;
		const innerCross = horizontal ? frame.h - top - bottom : frame.w - left - right;
		const main = (n: FigmaNode) => (horizontal ? n.w : n.h);
		const cross = (n: FigmaNode) => (horizontal ? n.h : n.w);
		const set = (n: FigmaNode, m: number, c: number) => {
			n.x = horizontal ? m : c;
			n.y = horizontal ? c : m;
		};
		const crossOffset = (n: FigmaNode, line: number) => {
			const align = (horizontal ? n.height : n.width).kind === 'FILL' ? 'MIN' : (n.alignSelf ?? frame.align);
			const free = line - cross(n);
			return align === 'CENTER' ? free / 2 : align === 'MAX' ? free : 0;
		};

		const lines = rows.get(frame) ?? [flow(frame)];
		let crossStart = horizontal ? top : left;
		for (const line of lines) {
			const lineCross = lines.length > 1 ? Math.max(0, ...line.map(cross)) : innerCross;
			const free = innerMain - sum(line.map(main)) - gaps(frame, line.length);
			let spacing = frame.gap;
			let m = mainStart;
			if (frame.justify === 'CENTER') m += free / 2;
			else if (frame.justify === 'MAX') m += free;
			else if (frame.justify === 'SPACE_BETWEEN' && line.length > 1) spacing += free / (line.length - 1);
			for (const n of line) {
				set(n, m, crossStart + crossOffset(n, lineCross));
				m += main(n) + spacing;
			}
			crossStart += lineCross + frame.gap;
		}

		// Absolute children: the given offsets, else where the browser puts an
		// out-of-flow child, as if it were the only item.
		for (const n of frame.children) {
			if (!n.absolute) continue;
			const free = innerMain - main(n);
			const m = mainStart + (frame.justify === 'CENTER' ? free / 2 : frame.justify === 'MAX' ? free : 0);
			set(n, m, (horizontal ? top : left) + crossOffset(n, innerCross));
			if (n.absolute.left !== undefined) n.x = n.absolute.left;
			if (n.absolute.top !== undefined) n.y = n.absolute.top;
		}
		for (const n of frame.children) if (n.type === 'FRAME') place(n);
	};

	resolveWidth(root, own(root));
	resolveHeight(root, ownHeight(root));
	place(root);
	placeAnchoredLayers(root);
}

/**
 * Anchored layers: positioned from their anchor's box, in the coordinates of
 * the root frame, which stands for the browser viewport. An anchor may sit
 * inside another anchored layer, so this repeats while something moves.
 */
function placeAnchoredLayers(root: FigmaFrame) {
	const parents = new Map<FigmaNode, FigmaFrame>();
	const named = new Map<string, FigmaNode>();
	const anchored: FigmaNode[] = [];
	const walk = (frame: FigmaFrame) => {
		for (const k of frame.children) {
			parents.set(k, frame);
			if (k.anchorName !== undefined) named.set(k.anchorName, k);
			if (k.anchor) anchored.push(k);
			if (k.type === 'FRAME') walk(k);
		}
	};
	walk(root);
	/** The position of `node`'s parent (or of `node`, with `self`) in the root frame. */
	const origin = (node: FigmaNode, self: boolean) => {
		let x = self ? node.x : 0;
		let y = self ? node.y : 0;
		for (let p = parents.get(node); p && p !== root; p = parents.get(p)) {
			x += p.x;
			y += p.y;
		}
		return { x, y };
	};
	const viewport = { x: 0, y: 0, width: root.w, height: root.h };
	for (let pass = 0; pass < 3; pass++) {
		let moved = false;
		for (const n of anchored) {
			const anchor = named.get(n.anchor!.name);
			if (!anchor) continue;
			const at = origin(anchor, true);
			const p = placeAnchored({ ...at, width: anchor.w, height: anchor.h }, { width: n.w, height: n.h }, viewport, n.anchor!.position, n.anchor!.offset);
			const parent = origin(n, false);
			const [x, y] = [p.x - parent.x, p.y - parent.y];
			if (x !== n.x || y !== n.y) moved = true;
			n.x = x;
			n.y = y;
		}
		if (!moved || anchored.length < 2) return;
	}
}
