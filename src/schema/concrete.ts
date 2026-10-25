// One evaluated state of a program: plain data with every style resolved and
// fonts inherited. `runtime/realize.ts` produces it; the Figma snapshot
// target consumes it.

import type { Font, Style } from './style';

export type { Font };

/**
 * An element's resolved style. Its anchor is not a style value here but
 * `anchor`: the concrete id of the element it is anchored to, or null when
 * that element is not rendered. Absent when it is not anchored.
 */
type Styled = { style: Omit<Style, 'anchor'>; anchor?: string | null };

export type Run = { text: string; font: Font };

/** Inline SVG as rendered: elements with their attributes, and text. */
export type SvgContent = string | { tag: string; attrs: Record<string, string>; children: SvgContent[] };

export type Concrete = Styled &
	(
		| { type: 'frame'; id: string; tag: string; font: Font; children: Concrete[] }
		| { type: 'text'; id: string; tag: string | null; font: Font; runs: Run[] }
		/** An <img>: its source as given (an asset's URL or path) and its alt text. */
		| { type: 'image'; id: string; tag: 'img'; font: Font; src: string; alt: string }
		/** An <svg>: its attributes, the size it hugs to, and its content. */
		| { type: 'svg'; id: string; tag: 'svg'; font: Font; attrs: Record<string, string>; size: { width: number; height: number }; children: SvgContent[] }
		| {
				type: 'input';
				id: string;
				tag: 'input' | 'textarea' | 'select';
				font: Font;
				value: string;
				placeholder: string;
				inputType: string;
		  }
	);
