// Concrete application state → Runic nodes.
//
// Uses Runic's own node factory (`createNode`), defaults, and zod schema from
// ../runic.design. Layout is not computed here: authored sizing and flex intent
// are mapped onto Runic's fields and Runic performs layout itself.

import { createNode, type CreateNodeOptions } from '../runic.design/packages/types/create-node';
import { DEFAULT_FONT, solidFill } from '../runic.design/packages/types/node-defaults';
import type { Border, Color, Effect, Fill, Flex, TextSection } from '../runic.design/packages/types/features';
import type { Node } from '../runic.design/packages/types/nodes';
import { NodeSchema } from '../runic.design/packages/types/zod';
import { evaluate, type Compiled, type Concrete, type Font, type Style } from './compiler';

export type RunicOptions = {
	/** Overrides keyed by state id (see `compiled.state`). */
	state?: Record<string, unknown>;
	/** The browser viewport the app is rendered into. `height: "hug"` grows with content. */
	viewport?: { width: number; height: number | 'hug' };
};

export type RunicResult = { rootNodeIds: string[]; nodes: Record<string, Node> };

const color = (hex: string): Color => {
	let h = hex.slice(1);
	if (h.length <= 4) h = [...h].map((c) => c + c).join('');
	const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
	return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? Math.round((n(6) / 255) * 1000) / 1000 : 1 };
};
const fill = (hex: string, alpha = 1): Fill => {
	const c = color(hex);
	return solidFill(c.r, c.g, c.b, c.a * alpha);
};

const size = (value: unknown) =>
	typeof value === 'number'
		? { kind: 'fixed' as const, value }
		: { kind: (value ?? 'hug') as 'hug' | 'fill', value: 0 };

const layerName = (text: string) => {
	const t = text.replace(/\s+/g, ' ').trim();
	return !t ? 'Text' : t.length <= 48 ? t : `${t.slice(0, 47).trimEnd()}…`;
};

// Fields every node kind shares: sizing, constraints, margins, opacity, position.
const baseOptions = (st: Style) => {
	const width = size(st.width);
	const height = size(st.height);
	return {
		box: { x: st.left ?? 0, y: st.top ?? 0, w: width.value, h: height.value },
		options: {
			widthKind: width.kind,
			heightKind: height.kind,
			transparency: (st.opacity ?? 1) * 100,
			margin: [st.marginTop ?? 0, st.marginRight ?? 0, st.marginBottom ?? 0, st.marginLeft ?? 0],
			absolutePosition: st.position === 'absolute',
			clipContent: false
		} satisfies CreateNodeOptions,
		// createNode does not copy these optional fields.
		extra: Object.fromEntries(
			['minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'alignSelf'].filter((k) => st[k] !== undefined).map((k) => [k, st[k]])
		)
	};
};

const paint = (st: Style) => ({
	fills: st.background ? [fill(st.background)] : [],
	borders: st.borderWidth
		? [
				{
					visible: true,
					color: color(st.borderColor ?? '#000000'),
					position: 'Inside',
					sides: [st.borderWidth, st.borderWidth, st.borderWidth, st.borderWidth],
					style: 'solid',
					lineJoin: 'miter'
				} satisfies Border
			]
		: [],
	effects: (st.shadow ?? []).map(
		(s: any): Effect => ({
			type: 'drop-shadow',
			visible: true,
			color: color(s.color),
			position: { x: s.x, y: s.y },
			blur: s.blur,
			spread: s.spread
		})
	),
	...(st.borderRadius ? { cornerRadius: st.borderRadius } : {})
});

const padding = (st: Style): [number, number, number, number] => [
	st.paddingTop ?? 0,
	st.paddingRight ?? 0,
	st.paddingBottom ?? 0,
	st.paddingLeft ?? 0
];

const runicFont = (font: Font) => ({
	family: font.fontFamily,
	size: font.fontSize,
	weight: font.fontWeight,
	style: font.fontStyle,
	lineHeight: font.lineHeight === null ? DEFAULT_FONT.lineHeight : { value: font.lineHeight, unit: 'px' },
	letterSpacing: { value: font.letterSpacing, unit: 'px' }
});

const sections = (runs: { text: string; font: Font }[], fallback: Font): { text: string; sections: TextSection[] } => {
	let text = '';
	const out: (TextSection & { key: string })[] = [];
	for (const run of runs) {
		if (!run.text) continue;
		const key = JSON.stringify(run.font);
		const start = text.length;
		text += run.text;
		const last = out[out.length - 1];
		if (last && last.key === key) last.end = text.length;
		else out.push({ key, start, end: text.length, font: runicFont(run.font), fills: [fill(run.font.color)], decoration: null });
	}
	if (!out.length) out.push({ key: '', start: 0, end: 0, font: runicFont(fallback), fills: [fill(fallback.color)], decoration: null });
	return { text, sections: out.map(({ key: _, ...section }) => section) };
};

class Converter {
	nodes: Record<string, Node> = {};

	private add(node: Node, extra: Record<string, unknown> = {}) {
		Object.assign(node, extra);
		if (this.nodes[node.id]) throw new Error(`Duplicate Runic node id ${node.id}`);
		this.nodes[node.id] = node;
		return node.id;
	}

	convert(n: Concrete): string {
		const { box, options, extra } = baseOptions(n.style);
		if (n.type === 'frame') {
			const st = n.style;
			const spaceBetween = st.justifyContent === 'space-between';
			const flex: Flex = {
				direction: st.flexDirection ?? 'column',
				justify: spaceBetween ? 'start' : (st.justifyContent ?? 'start'),
				align: st.alignItems ?? 'start',
				gap: spaceBetween ? 'auto' : [st.gap ?? 0, st.gap ?? 0],
				padding: padding(st),
				...(st.flexWrap === 'wrap' ? { wrap: 'wrap' as const } : {})
			};
			return this.add(
				createNode('frame', `n:${n.id}`, box, {
					...options,
					name: n.tag,
					...paint(st),
					flex,
					clipContent: st.overflow === 'hidden',
					children: n.children.map((child) => this.convert(child))
				}),
				extra
			);
		}
		if (n.type === 'text') {
			const content = sections(n.runs, n.font);
			return this.add(
				createNode('text', `n:${n.id}`, box, {
					...options,
					name: layerName(content.text),
					...content,
					align: n.font.textAlign,
					wrap: options.widthKind !== 'hug'
				}),
				extra
			);
		}
		// <input>/<textarea>: a clipped frame holding the current value (or the
		// placeholder at half opacity, matching the browser stylesheet).
		const multiline = n.tag === 'textarea';
		const shown = n.value ? (n.inputType === 'password' ? '•'.repeat(n.value.length) : n.value) : n.placeholder;
		const content = sections([{ text: shown, font: n.font }], n.font);
		if (!n.value) for (const s of content.sections) s.fills = [fill(n.font.color, 0.5)];
		const lineHeight = n.font.lineHeight ?? n.font.fontSize * 1.2;
		const text = this.add(
			createNode('text', `n:${n.id}/value`, { x: 0, y: 0, w: 0, h: multiline ? 0 : lineHeight }, {
				name: layerName(shown),
				...content,
				align: n.font.textAlign,
				widthKind: 'fill',
				heightKind: multiline ? 'hug' : 'fixed',
				wrap: multiline,
				clipContent: false
			})
		);
		return this.add(
			createNode('frame', `n:${n.id}`, box, {
				...options,
				name: n.tag,
				...paint(n.style),
				flex: {
					direction: multiline ? 'column' : 'row',
					justify: 'start',
					align: multiline ? 'start' : 'center',
					gap: [0, 0],
					padding: padding(n.style)
				},
				clipContent: true,
				children: [text]
			}),
			extra
		);
	}
}

/**
 * The same node graph as HTML for Runic's `write_html` import. Every field
 * travels verbatim in `data-runic`, so nothing is reinterpreted as CSS.
 */
export function toRunicHtml(result: RunicResult): string {
	const attr = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
	const render = (id: string): string => {
		const { id: _id, kind, children, ...fields } = result.nodes[id] as Node & { children?: string[] };
		const inner = (children ?? []).map(render).join('');
		return `<div data-runic-kind="${kind}" data-name="${attr(fields.name)}" data-runic="${attr(JSON.stringify(fields))}">${inner}</div>`;
	};
	return result.rootNodeIds.map(render).join('\n');
}

/**
 * Runic's native clipboard payload: what copying nodes in Runic writes as
 * `text/plain` (`serialise` in runic.design/packages/core/clipboard.ts), a
 * JSON array of every node in each copied subtree, pre-order. Paste parses it
 * with `NodesSchema`, treats nodes no other node lists as a child as roots, and
 * regenerates every id.
 */
export function toRunicClipboard(result: RunicResult): string {
	const out: Node[] = [];
	const visit = (id: string) => {
		const node = result.nodes[id];
		out.push(node);
		if ('children' in node) node.children.forEach(visit);
	};
	result.rootNodeIds.forEach(visit);
	return JSON.stringify(out);
}

/** Renders one concrete state of a compiled app as a validated Runic node graph. */
export async function renderRunic(compiled: Compiled, options: RunicOptions = {}): Promise<RunicResult> {
	const viewport = options.viewport ?? { width: 1280, height: 800 };
	const tree = await evaluate(compiled, { state: options.state });
	const converter = new Converter();
	const children = tree.map((n) => converter.convert(n));
	// The viewport the browser host provides: a white column flex frame.
	const app = createNode('frame', 'app', { x: 0, y: 0, w: viewport.width, h: viewport.height === 'hug' ? 0 : viewport.height }, {
		name: compiled.filename,
		widthKind: 'fixed',
		heightKind: viewport.height === 'hug' ? 'hug' : 'fixed',
		fills: [solidFill(255, 255, 255)],
		flex: { direction: 'column', justify: 'start', align: 'start', gap: [0, 0], padding: [0, 0, 0, 0] },
		clipContent: true,
		children
	});
	converter.nodes[app.id] = app;
	for (const node of Object.values(converter.nodes)) {
		const parsed = NodeSchema.safeParse(node);
		if (!parsed.success) throw new Error(`Invalid Runic node ${node.id}: ${parsed.error.message}`);
	}
	return { rootNodeIds: [app.id], nodes: converter.nodes };
}
