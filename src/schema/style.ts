// The style model: which properties exist, which values they accept, and
// which element kinds may use them. The compiler checks statically known
// styles against it, the runtime validates and resolves every style with it,
// and editor completion lists from it.

export type Style = Record<string, any>;

/** What an element is for styling purposes. `inline` is a <span> nested in text. */
export type ElementKind = 'frame' | 'text' | 'input' | 'textarea' | 'inline';

const isPx = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const isColor = (v: unknown) => typeof v === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v);

// Validators carry the string literals they accept, for editor completion.
const literals = <F extends (v: any) => boolean>(values: string[], check: F) => Object.assign(check, { values });
const oneOf = (...values: string[]) => literals(values, (v: unknown) => values.includes(v as string));
const isSize = literals(['hug', 'fill'], (v: unknown) => isPx(v) || v === 'hug' || v === 'fill');
const isMargin = literals(['auto'], (v: unknown) => isNum(v) || v === 'auto');
const isShadow = (v: any) =>
	!!v &&
	typeof v === 'object' &&
	Object.keys(v).every((k) => ['x', 'y', 'blur', 'spread', 'color'].includes(k)) &&
	['x', 'y', 'spread'].every((k) => v[k] === undefined || isNum(v[k])) &&
	(v.blur === undefined || isPx(v.blur)) &&
	(v.color === undefined || isColor(v.color));

const sizeHint = 'a pixel number, "hug" or "fill"';
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
	maxWidth: [isPx, 'a pixel number'],
	minHeight: [isPx, 'a pixel number'],
	maxHeight: [isPx, 'a pixel number'],
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
	background: [isColor, 'a hex color'],
	color: [isColor, 'a hex color'],
	opacity: [(v) => isNum(v) && v >= 0 && v <= 1, 'a number from 0 to 1'],
	borderWidth: [isPx, 'a pixel number'],
	borderColor: [isColor, 'a hex color'],
	borderRadius: [
		(v) => isPx(v) || (Array.isArray(v) && v.length === 4 && v.every(isPx)),
		'a pixel number or [topLeft, topRight, bottomRight, bottomLeft]'
	],
	overflow: [oneOf('visible', 'hidden'), '"visible" or "hidden"'],
	shadow: [(v) => (Array.isArray(v) ? v.every(isShadow) : isShadow(v)), '{ x, y, blur, spread, color } or an array of them'],
	fontFamily: [(v) => typeof v === 'string' && v.length > 0, 'a font family name'],
	fontSize: [(v) => isPx(v) && v > 0, 'a pixel number'],
	fontWeight: [(v) => Number.isInteger(v) && v >= 1 && v <= 1000, 'a number from 1 to 1000'],
	fontStyle: [oneOf('normal', 'italic'), '"normal" or "italic"'],
	lineHeight: [(v) => isPx(v) && v > 0, 'a pixel number'],
	letterSpacing: [isNum, 'a pixel number'],
	textAlign: [oneOf('start', 'center', 'end'), '"start", "center" or "end"']
};

export const SHORTHANDS: Record<string, string[]> = {
	padding: ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'],
	margin: ['marginTop', 'marginRight', 'marginBottom', 'marginLeft']
};
const SHORTHAND_HINT = 'a pixel number, [vertical, horizontal] or [top, right, bottom, left]';

const BOX = ['width', 'height', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight', ...SHORTHANDS.margin, 'alignSelf', 'position', 'left', 'top', 'opacity'];
/** Typography: inherited from parent to child. */
export const TYPO = ['color', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'textAlign'];
const PAINT = ['background', 'borderWidth', 'borderColor', 'borderRadius', 'shadow', ...SHORTHANDS.padding];
const FLEX = ['display', 'flexDirection', 'justifyContent', 'alignItems', 'flexWrap', 'gap', 'overflow'];
const ALLOWED: Record<ElementKind, string[]> = {
	frame: [...BOX, ...TYPO, ...PAINT, ...FLEX],
	input: [...BOX, ...TYPO, ...PAINT],
	textarea: [...BOX, ...TYPO, ...PAINT],
	text: [...BOX, ...TYPO],
	inline: TYPO.filter((k) => k !== 'textAlign')
};
const KIND_LABEL: Record<ElementKind, string> = {
	frame: 'containers (<main>, <div>, <button>)',
	input: '<input>',
	textarea: '<textarea>',
	text: 'text elements (<p>, <span>); wrap the text in a <div> for boxes, padding and backgrounds',
	inline: 'nested <span>s inside text; only typography is allowed there'
};

const sides = (v: unknown, allowAuto: boolean): unknown[] | null => {
	const ok = (x: unknown) => isPx(x) || (allowAuto && (isNum(x) || x === 'auto'));
	if (ok(v)) return [v, v, v, v];
	if (!Array.isArray(v) || !v.every(ok)) return null;
	if (v.length === 2) return [v[0], v[1], v[0], v[1]];
	if (v.length === 4) return [...v];
	return null;
};

/** Validates one style object and expands shorthands. Idempotent. Throws on invalid input. */
export function normalizeStyle(input: unknown): Style {
	if (!input || typeof input !== 'object' || Array.isArray(input))
		throw new Error(`A style must be an object, $style(...) value, or array of them; got ${JSON.stringify(input)}`);
	const out: Style = {};
	for (const [key, value] of Object.entries(input)) {
		if (value === undefined || value === null) continue;
		if (key in SHORTHANDS) {
			const expanded = sides(value, key === 'margin');
			if (!expanded) throw new Error(`Invalid ${key}: ${JSON.stringify(value)} (expected ${SHORTHAND_HINT})`);
			SHORTHANDS[key].forEach((longhand, i) => (out[longhand] = expanded[i]));
			continue;
		}
		const spec = SPEC[key];
		if (!spec) throw new Error(`Unsupported style property "${key}"`);
		if (!spec[0](value)) throw new Error(`Invalid ${key}: ${JSON.stringify(value)} (expected ${spec[1]})`);
		out[key] =
			key === 'borderRadius' && typeof value === 'number'
				? [value, value, value, value]
				: key === 'shadow'
					? (Array.isArray(value) ? value : [value]).map((s: any) => ({ x: 0, y: 0, blur: 0, spread: 0, color: '#00000040', ...s }))
					: value;
	}
	return Object.freeze(out);
}

/** `style={a}`, `style={[a, cond && b]}`: merges left to right, skipping falsy entries. */
export function resolveStyle(value: unknown): Style {
	const out: Style = {};
	const add = (v: unknown) => {
		if (!v) return;
		if (Array.isArray(v)) v.forEach(add);
		else Object.assign(out, normalizeStyle(v));
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

/** Validates a merged style for one element kind: allowed keys and combinations. */
export function checkStyle(kind: ElementKind, st: Style) {
	for (const key of Object.keys(st)) checkKey(kind, key);
	if (st.justifyContent === 'space-between' && st.gap) throw new Error('justifyContent "space-between" cannot be combined with gap');
	if (st.justifyContent === 'space-between' && st.flexWrap === 'wrap') throw new Error('justifyContent "space-between" cannot be combined with flexWrap "wrap"');
	const absolute = st.position === 'absolute';
	if (!absolute && (st.left !== undefined || st.top !== undefined)) throw new Error('left/top require position: "absolute"');
	if (absolute && (st.width === 'fill' || st.height === 'fill')) throw new Error('absolute elements cannot use "fill" sizing');
	if ((kind === 'input' || kind === 'textarea') && (st.width ?? 'hug') === 'hug') throw new Error(`<${kind}> needs width: <number> or "fill"`);
	if (kind === 'textarea' && (st.height ?? 'hug') === 'hug') throw new Error('<textarea> needs height: <number> or "fill"');
}

export type Sizing = 'fixed' | 'hug' | 'fill';

/** How a `width`/`height` style value sizes its element. */
export const sizingOf = (value: unknown): Sizing => (typeof value === 'number' ? 'fixed' : value === 'fill' ? 'fill' : 'hug');

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
			return { name: key, hint: key in SHORTHANDS ? SHORTHAND_HINT : spec[1], values: ((spec[0] as any).values ?? []) as string[] };
		});
}
