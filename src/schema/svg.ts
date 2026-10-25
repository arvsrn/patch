// Inline SVG: which elements may appear in an <svg>, and the size an <svg>
// hugs to. Shared by the compiler, the DOM renderer and design-time
// evaluation, so the browser and snapshots size an <svg> alike.

export const SVG_NS = 'http://www.w3.org/2000/svg';

/** The SVG elements an <svg> may hold (SVG 2, without <script>, <style> and <foreignObject>). */
export const SVG_TAGS = new Set(
	`a animate animateMotion animateTransform circle clipPath defs desc ellipse feBlend feColorMatrix feComponentTransfer
	feComposite feConvolveMatrix feDiffuseLighting feDisplacementMap feDistantLight feDropShadow feFlood feFuncA feFuncB feFuncG
	feFuncR feGaussianBlur feImage feMerge feMergeNode feMorphology feOffset fePointLight feSpecularLighting feSpotLight feTile
	feTurbulence filter g image line linearGradient marker mask metadata mpath path pattern polygon polyline radialGradient rect
	set stop svg switch symbol text textPath title tspan use view`.split(/\s+/)
);

/** SVG elements that are never HTML: outside an <svg> (at the top of a component rendered in one) they are still SVG. */
export const isSvgOnly = (tag: string) => SVG_TAGS.has(tag) && tag !== 'a' && tag !== 'svg';

/** Elements whose text content is rendered or read. Text anywhere else in an <svg> is an error. */
export const SVG_TEXT = new Set(['text', 'tspan', 'textPath', 'title', 'desc']);

/** Excluded from inline SVG, with why. */
export const SVG_EXCLUDED: Record<string, string> = {
	script: 'scripts belong in the component script',
	style: 'style SVG with presentation attributes (fill, stroke, …)',
	foreignObject: 'HTML inside SVG is not supported'
};

/** A length attribute in user units (`24`, `24px`), else null (`100%`, `2em`, absent). */
const userUnits = (value: string | null | undefined): number | null => {
	const m = /^\s*([0-9]*\.?[0-9]+)(px)?\s*$/.exec(value ?? '');
	return m ? Number(m[1]) : null;
};

/**
 * The size an <svg> hugs to: its `width` and `height`, the missing one from
 * the other and the `viewBox`'s proportions, else the `viewBox`'s size, else
 * 300 × 150 (the browser's default for an object without a size).
 */
export function svgSize(attrs: { width?: string | null; height?: string | null; viewBox?: string | null }): { width: number; height: number } {
	const box = (attrs.viewBox ?? '').trim().split(/[\s,]+/).map(Number);
	const view = box.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0 ? { width: box[2], height: box[3] } : null;
	let width = userUnits(attrs.width);
	let height = userUnits(attrs.height);
	if (width === null && height !== null) width = view ? (height * view.width) / view.height : 300;
	if (height === null && width !== null) height = view ? (width * view.height) / view.width : 150;
	return { width: width ?? view?.width ?? 300, height: height ?? view?.height ?? 150 };
}
