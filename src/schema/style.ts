// The style model: which properties exist, which values they accept, and
// which element kinds may use them. The compiler checks statically known
// styles against it, the runtime validates and resolves every style with it,
// and editor completion lists from it.

import { ANCHOR_POSITIONS, isDesignNode } from './anchor';

export type Style = Record<string, any>;

/** What an element is for styling purposes. `inline` is a <span> nested in text. */
export type ElementKind = 'frame' | 'text' | 'input' | 'textarea' | 'inline';

const isPx = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const isColor = (v: unknown) => typeof v === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v);

// Validators carry the string literals they accept, for editor completion.
const literals = <F extends (v: any) => boolean>(values: string[], check: F) => Object.assign(check, { values });
const oneOf = (...values: string[]) => literals(values, (v: unknown) => values.includes(v as string));
const isSize = literals(['hug', 'fill', 'anchor'], (v: unknown) => isPx(v) || v === 'hug' || v === 'fill' || v === 'anchor');
const isMaxSize = literals(['available'], (v: unknown) => isPx(v) || v === 'available');
const isPlacement = oneOf(...ANCHOR_POSITIONS);
const PLACEMENT_HINT = ANCHOR_POSITIONS.map((p) => `"${p}"`).join(', ');
/** An element from `bind:this` (a DOM element, or its design-time stand-in), or null: anchored to nothing yet. */
const isAnchorRef = (v: unknown) => v === null || v === undefined || isDesignNode(v) || (typeof Element !== 'undefined' && v instanceof Element);
const isMargin = literals(['auto'], (v: unknown) => isNum(v) || v === 'auto');
const isShadow = (v: any) =>
	!!v &&
	typeof v === 'object' &&
	Object.keys(v).every((k) => ['x', 'y', 'blur', 'spread', 'color', 'inset'].includes(k)) &&
	['x', 'y', 'spread'].every((k) => v[k] === undefined || isNum(v[k])) &&
	(v.blur === undefined || isPx(v.blur)) &&
	(v.color === undefined || isColor(v.color)) &&
	(v.inset === undefined || typeof v.inset === 'boolean');

const sizeHint = 'a pixel number, "hug", "fill" or "anchor"';
const isOverflow = oneOf('visible', 'hidden', 'auto', 'scroll');
const OVERFLOW_HINT = '"visible", "hidden", "auto" or "scroll"';
const CURSORS = [
	'auto', 'default', 'pointer', 'text', 'move', 'grab', 'grabbing', 'not-allowed', 'wait', 'progress', 'help', 'crosshair',
	'ew-resize', 'ns-resize', 'nesw-resize', 'nwse-resize', 'col-resize', 'row-resize', 'zoom-in', 'zoom-out', 'none'
];
/** `oneOf` with its hint: `"a", "b" or "c"`. */
const choice = (...values: string[]): [(v: any) => boolean, string] => {
	const quoted = values.map((v) => `"${v}"`);
	return [oneOf(...values), `${quoted.slice(0, -1).join(', ')} or ${quoted[quoted.length - 1]}`];
};
const SPEC: Record<string, [(v: any) => boolean, string]> = {
	display: [oneOf('flex'), '"flex" (every container is a flex container)'],
	flexDirection: [oneOf('row', 'column'), '"row" or "column"'],
	justifyContent: [oneOf('start', 'center', 'end', 'space-between'), '"start", "center", "end" or "space-between"'],
	alignItems: [oneOf('start', 'center', 'end'), '"start", "center" or "end" (use width/height "fill" to stretch)'],
	alignSelf: [oneOf('start', 'center', 'end'), '"start", "center" or "end"'],
	flexWrap: [oneOf('wrap', 'nowrap'), '"wrap" or "nowrap"'],
	gap: [isPx, 'a pixel number'],
	width: [isSize, sizeHint],
	height: [isSize, sizeHint],
	minWidth: [isPx, 'a pixel number'],
	maxWidth: [isMaxSize, 'a pixel number or "available"'],
	minHeight: [isPx, 'a pixel number'],
	maxHeight: [isMaxSize, 'a pixel number or "available"'],
	paddingTop: [isPx, 'a pixel number'],
	paddingRight: [isPx, 'a pixel number'],
	paddingBottom: [isPx, 'a pixel number'],
	paddingLeft: [isPx, 'a pixel number'],
	marginTop: [isMargin, 'a pixel number or "auto"'],
	marginRight: [isMargin, 'a pixel number or "auto"'],
	marginBottom: [isMargin, 'a pixel number or "auto"'],
	marginLeft: [isMargin, 'a pixel number or "auto"'],
	position: [oneOf('absolute', 'flow'), '"absolute" or "flow"'],
	left: [isNum, 'a pixel number'],
	top: [isNum, 'a pixel number'],
	anchor: [isAnchorRef, 'an element from bind:this'],
	anchorPosition: [isPlacement, PLACEMENT_HINT],
	anchorOffset: [isNum, 'a pixel number'],
	anchorCrossOffset: [isNum, 'a pixel number'],
	anchorPadding: [(v) => sides(v, false) !== null, 'a pixel number, [vertical, horizontal] or [top, right, bottom, left]'],
	anchorFallbacks: [(v) => Array.isArray(v) && v.every(isPlacement), `an array of placements: ${PLACEMENT_HINT}`],
	background: [isColor, 'a hex color'],
	color: [isColor, 'a hex color'],
	opacity: [(v) => isNum(v) && v >= 0 && v <= 1, 'a number from 0 to 1'],
	borderWidth: [isPx, 'a pixel number'],
	borderColor: [isColor, 'a hex color'],
	borderRadius: [
		(v) => isPx(v) || (Array.isArray(v) && v.length === 4 && v.every(isPx)),
		'a pixel number or [topLeft, topRight, bottomRight, bottomLeft]'
	],
	overflowX: [isOverflow, OVERFLOW_HINT],
	overflowY: [isOverflow, OVERFLOW_HINT],
	boxShadow: [(v) => (Array.isArray(v) ? v.every(isShadow) : isShadow(v)), '{ x, y, blur, spread, color, inset } or an array of them'],
	fontFamily: [(v) => typeof v === 'string' && v.length > 0, 'a font family name'],
	fontSize: [(v) => isPx(v) && v > 0, 'a pixel number'],
	fontWeight: [(v) => Number.isInteger(v) && v >= 1 && v <= 1000, 'a number from 1 to 1000'],
	fontStyle: [oneOf('normal', 'italic'), '"normal" or "italic"'],
	lineHeight: [(v) => isPx(v) && v > 0, 'a pixel number'],
	letterSpacing: [isNum, 'a pixel number'],
	textAlign: [oneOf('start', 'center', 'end'), '"start", "center" or "end"'],
	cursor: choice(...CURSORS),
	userSelect: choice('auto', 'none', 'text', 'all'),
	pointerEvents: choice('auto', 'none'),
	touchAction: choice('auto', 'none', 'pan-x', 'pan-y', 'manipulation'),
	overscrollBehavior: choice('auto', 'contain', 'none'),
	caretColor: [isColor, 'a hex color']
};

export const SHORTHANDS: Record<string, string[]> = {
	padding: ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'],
	margin: ['marginTop', 'marginRight', 'marginBottom', 'marginLeft'],
	overflow: ['overflowX', 'overflowY']
};

/** Anchored positioning (see schema/anchor.ts). */
const ANCHORING = ['anchor', 'anchorPosition', 'anchorOffset', 'anchorCrossOffset', 'anchorPadding', 'anchorFallbacks'];
/** Interaction: how an element responds to the pointer and selection. No effect on snapshots. */
const INTERACTION = ['cursor', 'userSelect', 'pointerEvents'];
const BOX = ['width', 'height', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight', ...SHORTHANDS.margin, 'alignSelf', 'position', 'left', 'top', ...ANCHORING, 'opacity', ...INTERACTION, 'touchAction'];
/** Typography: inherited from parent to child. */
export const TYPO = ['color', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'textAlign'];
const PAINT = ['background', 'borderWidth', 'borderColor', 'borderRadius', 'boxShadow', ...SHORTHANDS.padding];
const FLEX = ['display', 'flexDirection', 'justifyContent', 'alignItems', 'flexWrap', 'gap', ...SHORTHANDS.overflow, 'overscrollBehavior'];
const ALLOWED: Record<ElementKind, string[]> = {
	// Every property: a standalone `$style` is checked as a frame.
	frame: [...BOX, ...TYPO, ...PAINT, ...FLEX, 'caretColor'],
	input: [...BOX, ...TYPO, ...PAINT, 'caretColor'],
	textarea: [...BOX, ...TYPO, ...PAINT, 'caretColor'],
	text: [...BOX, ...TYPO],
	inline: [...TYPO.filter((k) => k !== 'textAlign'), ...INTERACTION]
};
const KIND_LABEL: Record<ElementKind, string> = {
	frame: 'containers (<main>, <div>, <button>)',
	input: '<input>',
	textarea: '<textarea>',
	text: 'text elements (<p>, <span>); wrap the text in a <div> for boxes, padding and backgrounds',
	inline: 'nested <span>s inside text; only typography, cursor, userSelect and pointerEvents are allowed there'
};

const sides = (v: unknown, allowAuto: boolean): unknown[] | null => {
	const ok = (x: unknown) => isPx(x) || (allowAuto && (isNum(x) || x === 'auto'));
	if (ok(v)) return [v, v, v, v];
	if (!Array.isArray(v) || !v.every(ok)) return null;
	if (v.length === 2) return [v[0], v[1], v[0], v[1]];
	if (v.length === 4) return [...v];
	return null;
};
const SIDES_HINT = 'a pixel number, [vertical, horizontal] or [top, right, bottom, left]';

/** How each shorthand expands to its longhands (null: invalid), and what it accepts. */
const EXPAND: Record<string, [(v: unknown) => unknown[] | null, string]> = {
	padding: [(v) => sides(v, false), SIDES_HINT],
	margin: [(v) => sides(v, true), SIDES_HINT],
	overflow: [(v) => (isOverflow(v) ? [v, v] : null), OVERFLOW_HINT]
};

/** Validates one style object and expands shorthands. Idempotent. Throws on invalid input. */
export function normalizeStyle(input: unknown): Style {
	if (!input || typeof input !== 'object' || Array.isArray(input))
		throw new Error(`A style must be an object, $style(...) value, or array of them; got ${JSON.stringify(input)}`);
	const out: Style = {};
	for (const [key, value] of Object.entries(input)) {
		// A nullish anchor is kept: the element is anchored, to nothing yet.
		if ((value === undefined || value === null) && key !== 'anchor') continue;
		if (key in SHORTHANDS) {
			const [expand, hint] = EXPAND[key];
			const expanded = expand(value);
			if (!expanded) throw new Error(`Invalid ${key}: ${JSON.stringify(value)} (expected ${hint})`);
			SHORTHANDS[key].forEach((longhand, i) => (out[longhand] = expanded[i]));
			continue;
		}
		const spec = SPEC[key];
		if (!spec) throw new Error(`Unsupported style property "${key}"`);
		if (!spec[0](value)) throw new Error(`Invalid ${key}: ${JSON.stringify(value)} (expected ${spec[1]})`);
		out[key] =
			key === 'anchor'
				? (value ?? null)
				: key === 'anchorPadding'
					? sides(value, false)
					: key === 'borderRadius' && typeof value === 'number'
				? [value, value, value, value]
				: key === 'boxShadow'
					? (Array.isArray(value) ? value : [value]).map((s: any) => ({ x: 0, y: 0, blur: 0, spread: 0, color: '#00000040', inset: false, ...s }))
					: value;
	}
	return Object.freeze(out);
}

/** Fields of absolute positioning: an entry switching to `position: 'flow'` discards earlier ones. */
export const OFFSETS = ['left', 'top', ...ANCHORING];

/**
 * `style={a}`, `style={[a, cond && b]}`: merges left to right, skipping falsy
 * entries. A null or undefined property does not override; `position:
 * 'flow'` leaves absolute positioning, discarding offsets set before it.
 */
export function resolveStyle(value: unknown): Style {
	const out: Style = {};
	const add = (v: unknown) => {
		if (!v) return;
		if (Array.isArray(v)) return v.forEach(add);
		const st = normalizeStyle(v);
		if (st.position === 'flow') for (const key of OFFSETS) delete out[key];
		Object.assign(out, st);
	};
	add(value);
	return out;
}

/** Throws when `key` (a property or shorthand) is unknown or not allowed on `kind`. */
export function checkKey(kind: ElementKind, key: string) {
	for (const k of SHORTHANDS[key] ?? [key]) {
		if (!SPEC[k]) throw new Error(`Unsupported style property "${key}"`);
		if (!ALLOWED[kind].includes(k)) throw new Error(`"${key}" is not supported on ${KIND_LABEL[kind]}`);
	}
}

/**
 * A rule about how properties of one merged style combine. `fails` reads
 * only `keys` (normalized longhands) and returns the problem, if any.
 * `kinds`: the element kinds it applies to (all when absent).
 */
export type StyleRule = { keys: string[]; kinds?: ElementKind[]; fails: (st: Style, kind: ElementKind) => string | null };

export const STYLE_RULES: StyleRule[] = [
	{
		keys: ['justifyContent', 'gap'],
		fails: (st) => (st.justifyContent === 'space-between' && st.gap ? 'justifyContent "space-between" cannot be combined with gap' : null)
	},
	{
		keys: ['justifyContent', 'flexWrap'],
		fails: (st) => (st.justifyContent === 'space-between' && st.flexWrap === 'wrap' ? 'justifyContent "space-between" cannot be combined with flexWrap "wrap"' : null)
	},
	{
		keys: ['position', 'left', 'top'],
		fails: (st) => (st.position !== 'absolute' && (st.left !== undefined || st.top !== undefined) ? 'left/top require position: "absolute"' : null)
	},
	{
		keys: ['position', 'anchor'],
		fails: (st) => (st.anchor !== undefined && st.position !== 'absolute' ? 'anchor requires position: "absolute"' : null)
	},
	{
		keys: ANCHORING,
		fails: (st) => (st.anchor === undefined && ANCHORING.slice(1).some((k) => st[k] !== undefined) ? 'anchorPosition, anchorOffset, anchorCrossOffset, anchorPadding and anchorFallbacks require anchor' : null)
	},
	{
		keys: ['anchor', 'width', 'height', 'maxWidth', 'maxHeight'],
		fails: (st) =>
			st.anchor === undefined && (st.width === 'anchor' || st.height === 'anchor' || st.maxWidth === 'available' || st.maxHeight === 'available')
				? 'width/height "anchor" and maxWidth/maxHeight "available" require anchor'
				: null
	},
	{
		keys: ['anchor', 'left', 'top'],
		fails: (st) => (st.anchor !== undefined && (st.left !== undefined || st.top !== undefined) ? 'anchor cannot be combined with left/top; use anchorOffset' : null)
	},
	{
		keys: ['anchor', ...SHORTHANDS.margin],
		fails: (st) => (st.anchor !== undefined && SHORTHANDS.margin.some((k) => st[k] !== undefined && st[k] !== 0) ? 'anchor cannot be combined with margin; use anchorOffset' : null)
	},
	{
		keys: ['overflowX', 'overflowY'],
		fails: (st) => {
			const clips = (v: unknown) => v !== undefined && v !== 'visible';
			return (st.overflowX === 'visible' && clips(st.overflowY)) || (st.overflowY === 'visible' && clips(st.overflowX))
				? 'overflow "visible" on one axis cannot be combined with "hidden", "auto" or "scroll" on the other'
				: null;
		}
	},
	{
		keys: ['position', 'width', 'height'],
		fails: (st) => (st.position === 'absolute' && (st.width === 'fill' || st.height === 'fill') ? 'absolute elements cannot use "fill" sizing' : null)
	},
	{
		keys: ['width'],
		kinds: ['input', 'textarea'],
		fails: (st, kind) => ((st.width ?? 'hug') === 'hug' ? `<${kind}> needs width: <number> or "fill"` : null)
	},
	{
		keys: ['height'],
		kinds: ['textarea'],
		fails: (st) => ((st.height ?? 'hug') === 'hug' ? '<textarea> needs height: <number> or "fill"' : null)
	}
];

export const rulesFor = (kind: ElementKind) => STYLE_RULES.filter((rule) => !rule.kinds || rule.kinds.includes(kind));

/** Validates a merged style for one element kind: allowed keys and combinations. */
export function checkStyle(kind: ElementKind, st: Style) {
	for (const key of Object.keys(st)) checkKey(kind, key);
	for (const rule of rulesFor(kind)) {
		const problem = rule.fails(st, kind);
		if (problem) throw new Error(problem);
	}
}

/** The string literals a longhand property accepts. */
export const styleLiterals = (key: string): string[] => ((SPEC[key]?.[0] as any)?.values ?? []) as string[];

export type Sizing = 'fixed' | 'hug' | 'fill';

/** How a `width`/`height` style value sizes its element. An anchor-matched size is a fixed size set by the renderer. */
export const sizingOf = (value: unknown): Sizing => (typeof value === 'number' || value === 'anchor' ? 'fixed' : value === 'fill' ? 'fill' : 'hug');

/**
 * How a flow child is actually sized along one axis. Fill takes space its
 * parent has; a parent that hugs that axis has none to give, so the child is
 * sized by its content: along the parent's main axis always, and across it
 * when it is the only flow child (it would stretch to itself). The result is
 * what the child's own children see as their parent's sizing.
 */
export function effectiveSizing(own: Sizing, parent: Sizing, mainAxis: boolean, onlyFlowChild: boolean): Sizing {
	return own === 'fill' && parent === 'hug' && (mainAxis || onlyFlowChild) ? 'hug' : own;
}

export type StyleProperty = { name: string; hint: string; values: string[] };

/** The keys `checkKey` accepts for one element kind (shorthands included), with hints and accepted string literals. */
export function styleProperties(kind: ElementKind): StyleProperty[] {
	return [...Object.keys(SHORTHANDS), ...Object.keys(SPEC)]
		.filter((key) => (SHORTHANDS[key] ?? [key]).every((k) => ALLOWED[kind].includes(k)))
		.map((key) => {
			const spec = SPEC[SHORTHANDS[key]?.[0] ?? key];
			return { name: key, hint: key in SHORTHANDS ? EXPAND[key][1] : spec[1], values: ((spec[0] as any).values ?? []) as string[] };
		});
}
