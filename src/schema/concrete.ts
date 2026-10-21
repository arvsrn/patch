// One evaluated state of a program: plain data with every style resolved and
// fonts inherited. `runtime/realize.ts` produces it; the Figma snapshot
// target consumes it. An anchored element's `style.anchor` is the concrete id
// of its anchor, or null when its anchor is not rendered.

import type { Style } from './style';

export type Font = {
	fontFamily: string;
	fontSize: number;
	fontWeight: number;
	fontStyle: 'normal' | 'italic';
	lineHeight: number | null;
	letterSpacing: number;
	color: string;
	textAlign: 'start' | 'center' | 'end';
};

export type Run = { text: string; font: Font };

export type Concrete =
	| { type: 'frame'; id: string; tag: string; style: Style; font: Font; children: Concrete[] }
	| { type: 'text'; id: string; tag: string | null; style: Style; font: Font; runs: Run[] }
	| {
			type: 'input';
			id: string;
			tag: 'input' | 'textarea';
			style: Style;
			font: Font;
			value: string;
			placeholder: string;
			inputType: string;
	  };
