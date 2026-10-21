// Figma draws a pasted text layer from its saved layout (`derivedTextData`),
// not from its characters: without it the layer stays blank until edited.
// This lays each text node out on the lines layout.ts measured and records
// what Figma saves: every glyph's outline and position, each line's baseline,
// each character's offset in its line, and the fonts used.
//
// Outlines are blobs on the clipboard message: commands (0 close, 1 move,
// 2 line, 4 cubic) each followed by little-endian float32 points, in ems with
// y pointing up as in the font; Figma flips them when it draws. A glyph's
// position is its origin on the baseline, in the layer's coordinates.

import type * as fontkit from 'fontkit';
import type { FigmaFrame, FigmaNode, FigmaText, TextStyle } from './adapter';
import type { Fonts } from './fonts';
import { breakLines } from './text';

export type DerivedGlyph = { blob: number; x: number; y: number; size: number; firstCharacter: number; advance: number; style: TextStyle };
export type DerivedText = {
	glyphs: DerivedGlyph[];
	baselines: { x: number; y: number; width: number; lineY: number; lineHeight: number; lineAscent: number; firstCharacter: number; endCharacter: number }[];
	/** Per UTF-16 character: its x offset from the start of its line. */
	offsets: number[];
	fonts: { style: TextStyle; lineHeight: number }[];
	truncationStart: number;
	truncatedHeight: number;
};

const CLOSE = 0;
const MOVE = 1;
const LINE = 2;
const CUBIC = 4;

function outline(path: fontkit.Glyph['path'], unitsPerEm: number): Uint8Array | null {
	const out: number[][] = [];
	let x = 0;
	let y = 0;
	const s = (v: number) => v / unitsPerEm;
	for (const { command, args } of path.commands as { command: string; args: number[] }[]) {
		if (command === 'moveTo') out.push([MOVE, s(args[0]), s(args[1])]);
		else if (command === 'lineTo') out.push([LINE, s(args[0]), s(args[1])]);
		else if (command === 'bezierCurveTo') out.push([CUBIC, ...args.map(s)]);
		else if (command === 'quadraticCurveTo') {
			// As the cubic with the same curve.
			const [qx, qy, ex, ey] = args;
			out.push([CUBIC, s(x + (2 / 3) * (qx - x)), s(y + (2 / 3) * (qy - y)), s(ex + (2 / 3) * (qx - ex)), s(ey + (2 / 3) * (qy - ey)), s(ex), s(ey)]);
		} else if (command === 'closePath') out.push([CLOSE]);
		if (args.length) [x, y] = args.slice(-2);
	}
	if (!out.some((c) => c[0] !== CLOSE && c[0] !== MOVE)) return null;
	const bytes = new Uint8Array(out.reduce((n, c) => n + 1 + (c.length - 1) * 4, 0));
	const view = new DataView(bytes.buffer);
	let offset = 0;
	for (const [cmd, ...points] of out) {
		bytes[offset++] = cmd;
		for (const p of points) {
			view.setFloat32(offset, p, true);
			offset += 4;
		}
	}
	return bytes;
}

/** Adds `derived` to every text node of the tree. Returns the outline blobs the glyphs refer to. */
export function deriveTexts(root: FigmaFrame, fonts: Fonts): Uint8Array[] {
	const blobs: Uint8Array[] = [];
	const blobIndex = new Map<string, number>();
	const blobFor = (fontId: string, glyph: fontkit.Glyph, font: fontkit.Font) => {
		const key = `${fontId}\0${glyph.id}`;
		if (!blobIndex.has(key)) {
			const bytes = outline(glyph.path, font.unitsPerEm);
			blobIndex.set(key, bytes ? blobs.push(bytes) - 1 : -1);
		}
		return blobIndex.get(key)!;
	};

	const derive = (node: FigmaText): DerivedText | null => {
		const styles = node.runs.length ? node.runs.map((r) => r.style) : [node.base];
		const sized = new Map(styles.map((s) => [s, fonts.fontFor(s)]));
		// All or nothing: a layer drawn with some glyphs missing would show gaps.
		if ([...sized.values()].some((f) => !f)) return null;
		const fontOf = (s: TextStyle) => sized.get(s)!;
		const metrics = (s: TextStyle) => {
			const { font } = fontOf(s);
			return { ascent: (font.ascent / font.unitsPerEm) * s.size, descent: (-font.descent / font.unitsPerEm) * s.size };
		};

		const lh = node.lineHeight;
		const lines = breakLines(node, fonts.widthOf, node.width.kind === 'HUG' ? undefined : node.w);
		const length = node.runs.reduce((n, r) => n + r.text.length, 0);
		const derived: DerivedText = {
			glyphs: [],
			baselines: [],
			offsets: new Array(length).fill(0),
			fonts: [],
			truncationStart: -1,
			truncatedHeight: -1
		};
		const seenFonts = new Set<string>();
		for (const s of styles) {
			const { font, id } = fontOf(s);
			const key = id.split('\0').slice(0, 3).join('\0');
			if (seenFonts.has(key)) continue;
			seenFonts.add(key);
			derived.fonts.push({ style: s, lineHeight: (font.ascent - font.descent + font.lineGap) / font.unitsPerEm });
		}

		lines.slice(0, node.truncate ? 1 : undefined).forEach((line, i) => {
			const lineStyles = line.pieces.length ? line.pieces.map((p) => p.style) : [node.base];
			const ascent = Math.max(...lineStyles.map((s) => metrics(s).ascent));
			const descent = Math.max(...lineStyles.map((s) => metrics(s).descent));
			const top = i * lh;
			// The line's content area sits in the middle of its line height.
			const baseline = top + (lh - ascent - descent) / 2 + ascent;
			const free = node.w - line.width;
			const left = node.textAlign === 'CENTER' ? free / 2 : node.textAlign === 'RIGHT' ? free : 0;
			const limit = node.truncate && line.width > node.w + 0.01 ? node.w : Infinity;
			let ellipsis = 0;
			if (limit < Infinity) {
				const s = line.pieces[0]?.style ?? node.base;
				ellipsis = fonts.widthOf(s, '…') + s.letterSpacing;
			}
			for (let c = line.start; c < line.end; c++) derived.offsets[c] = line.width;

			let truncated = false;
			for (const piece of line.pieces) {
				const { font, id } = fontOf(piece.style);
				const scale = piece.style.size / font.unitsPerEm;
				const run = font.layout(piece.text);
				let x = piece.x;
				let char = piece.start;
				run.glyphs.forEach((glyph, g) => {
					const pos = run.positions[g];
					const advance = pos.xAdvance * scale + piece.style.letterSpacing * glyph.codePoints.length;
					const units = glyph.codePoints.reduce((n, cp) => n + (cp > 0xffff ? 2 : 1), 0) || 1;
					for (let k = 0; k < units && char + k < length; k++) derived.offsets[char + k] = x + (advance * k) / units;
					if (!truncated && x + advance > limit - ellipsis + 0.01) {
						truncated = true;
						derived.truncationStart = char;
						derived.truncatedHeight = lh;
						const s = piece.style;
						const dots = fontOf(s).font.layout('…');
						const blob = dots.glyphs[0] ? blobFor(fontOf(s).id, dots.glyphs[0], fontOf(s).font) : -1;
						if (blob >= 0)
							derived.glyphs.push({ blob, x: left + x, y: baseline, size: s.size, firstCharacter: char, advance: dots.positions[0].xAdvance / font.unitsPerEm, style: s });
					}
					if (!truncated) {
						const blob = blobFor(id, glyph, font);
						if (blob >= 0)
							derived.glyphs.push({
								blob,
								x: left + x + pos.xOffset * scale,
								y: baseline - pos.yOffset * scale,
								size: piece.style.size,
								firstCharacter: char,
								advance: pos.xAdvance / font.unitsPerEm,
								style: piece.style
							});
					}
					x += advance;
					char += units;
				});
			}
			derived.baselines.push({
				x: left,
				y: baseline,
				width: Math.min(line.width, limit),
				lineY: top,
				lineHeight: lh,
				lineAscent: baseline - top,
				firstCharacter: line.start,
				endCharacter: line.end
			});
		});
		return derived;
	};

	const visit = (n: FigmaNode) => {
		if (n.type === 'TEXT') n.derived = derive(n) ?? undefined;
		else n.children.forEach(visit);
	};
	visit(root);
	return blobs;
}
