// Text measurement for layout. Words and spaces are measured once each (in
// one batch), then lines are broken greedily the way `white-space: pre-wrap`
// breaks them: at spaces, with spaces at a break hanging past the edge.

import type { FigmaText, TextStyle } from './adapter';

export type FontKey = Pick<TextStyle, 'family' | 'size' | 'weight' | 'italic'>;
/** Advance width of `text` on one line, without letter spacing. */
export type WidthOf = (font: FontKey, text: string) => number;
export type TextMeasure = (node: FigmaText, maxWidth?: number) => { width: number; height: number };

type Piece = { text: string; style: TextStyle };
type Token = { space: boolean; pieces: Piece[] };

/** The text split into hard lines of word and space tokens, each a list of single-style pieces. */
function tokenize(node: FigmaText): Token[][] {
	const lines: Token[][] = [[]];
	for (const run of node.runs)
		for (const part of run.text.split(/(\n| +)/)) {
			if (!part) continue;
			if (part === '\n') {
				lines.push([]);
				continue;
			}
			const line = lines[lines.length - 1];
			const space = part[0] === ' ';
			const last = line[line.length - 1];
			// A word continuing across a style change is still one word.
			if (last && last.space === space && !space) last.pieces.push({ text: part, style: run.style });
			else line.push({ space, pieces: [{ text: part, style: run.style }] });
		}
	return lines;
}

/** Every distinct piece a node's measurement needs. */
export function textPieces(node: FigmaText): Piece[] {
	return tokenize(node).flatMap((line) => line.flatMap((t) => t.pieces));
}

export function measureWith(widthOf: WidthOf): TextMeasure {
	const pieceWidth = (p: Piece) => widthOf(p.style, p.text) + p.style.letterSpacing * [...p.text].length;
	return (node, maxWidth) => {
		const lineHeight = node.lineHeight;
		let width = 0;
		let count = 0;
		for (const tokens of tokenize(node)) {
			let line = 0;
			let pending = 0;
			count++;
			for (const token of tokens) {
				const w = token.pieces.reduce((sum, p) => sum + pieceWidth(p), 0);
				if (token.space) {
					pending += w;
					continue;
				}
				if (maxWidth !== undefined && !node.truncate && line > 0 && line + pending + w > maxWidth + 0.01) {
					width = Math.max(width, line);
					count++;
					line = w;
				} else line += pending + w;
				pending = 0;
			}
			// Unwrapped text keeps its trailing spaces (`white-space: pre`).
			width = Math.max(width, maxWidth === undefined ? line + pending : line);
		}
		const empty = node.runs.every((r) => !r.text);
		const lines = node.truncate ? 1 : empty ? 0 : count;
		return { width: Math.ceil(width * 100) / 100, height: lines * lineHeight };
	};
}

// One osascript (JavaScript for Automation) call: resolves each font with
// AppKit and measures every piece with it. Reads the request from stdin.
const JXA = `
ObjC.import('AppKit');
function run() {
	const input = $.NSString.alloc.initWithDataEncoding($.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile, $.NSUTF8StringEncoding).js;
	const { fonts, items } = JSON.parse(input);
	const manager = $.NSFontManager.sharedFontManager;
	const families = ObjC.deepUnwrap(manager.availableFontFamilies);
	const WEIGHTS = [['thin', 100], ['extralight', 200], ['ultralight', 200], ['semibold', 600], ['demibold', 600], ['extrabold', 800], ['ultrabold', 800], ['light', 300], ['medium', 500], ['bold', 700], ['heavy', 800], ['black', 900]];
	const weightOf = (style) => {
		const s = style.toLowerCase().replace(/[\\s_-]/g, '');
		const hit = WEIGHTS.find(([name]) => s.includes(name));
		return hit ? hit[1] : 400;
	};
	const resolved = fonts.map(({ family, weight, italic }) => {
		const name = families.includes(family) ? family : families.includes(family + ' Variable') ? family + ' Variable' : null;
		if (!name) return { family, postscript: null };
		let best = null;
		for (const [postscript, style, , traits] of ObjC.deepUnwrap(manager.availableMembersOfFontFamily(name))) {
			const slanted = (traits & 1) === 1 || /italic|oblique/i.test(style);
			const score = Math.abs(weightOf(style) - weight) + (slanted === italic ? 0 : 1000);
			if (!best || score < best.score) best = { score, postscript };
		}
		return { family: name, postscript: best && best.postscript };
	});
	const cache = {};
	const widths = items.map(([font, size, text]) => {
		const key = font + '/' + size;
		if (!cache[key]) {
			const postscript = resolved[font].postscript;
			const f = postscript ? $.NSFont.fontWithNameSize(postscript, size) : null;
			cache[key] = f && !f.isNil() ? f : $.NSFont.systemFontOfSize(size);
		}
		const attrs = $.NSDictionary.dictionaryWithObjectForKey(cache[key], $.NSFontAttributeName);
		return $(text).sizeWithAttributes(attrs).width;
	});
	return JSON.stringify({ resolved, widths });
}
`;

/** Measures every piece of `nodes` with the fonts installed on this Mac. */
export async function coreTextWidths(nodes: FigmaText[]): Promise<{ widthOf: WidthOf; warnings: string[] }> {
	if (process.platform !== 'darwin') throw new Error('Text measurement for snapshots needs macOS');
	const fontKey = (f: FontKey) => `${f.family}\0${f.weight}\0${f.italic}`;
	const fonts = new Map<string, number>();
	const items = new Map<string, [number, number, string]>();
	const key = (f: FontKey, text: string) => `${fontKey(f)}\0${f.size}\0${text}`;
	for (const node of nodes)
		for (const { style, text } of textPieces(node)) {
			if (!fonts.has(fontKey(style))) fonts.set(fontKey(style), fonts.size);
			items.set(key(style, text), [fonts.get(fontKey(style))!, style.size, text]);
		}
	const request = {
		fonts: [...fonts.keys()].map((k) => {
			const [family, weight, italic] = k.split('\0');
			return { family, weight: Number(weight), italic: italic === 'true' };
		}),
		items: [...items.values()]
	};
	const proc = Bun.spawn(['osascript', '-l', 'JavaScript', '-e', JXA], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
	proc.stdin.write(JSON.stringify(request));
	await proc.stdin.end();
	const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	if (code !== 0) throw new Error(`Text measurement failed: ${err.trim() || `osascript exited with ${code}`}`);
	const { resolved, widths } = JSON.parse(out) as { resolved: { family: string; postscript: string | null }[]; widths: number[] };
	const byKey = new Map([...items.keys()].map((k, i) => [k, widths[i]]));
	const warnings = [...new Set(resolved.filter((r) => !r.postscript).map((r) => `Font "${r.family}" is not installed; text was measured with the system font`))];
	return { widthOf: (f, text) => byKey.get(key(f, text)) ?? 0, warnings };
}
