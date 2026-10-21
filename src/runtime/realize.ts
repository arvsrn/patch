// Design-time evaluation: run a program once (no effects) with optional state
// overrides and evaluate its template into a concrete tree.

import type { Concrete, Font, Run } from '../schema/concrete';
import type { InlinePart, Program, ProgramNode } from '../schema/program';
import { TYPO, type Style } from '../schema/style';
import { createApi } from './api';
import { eachList, elementStyle, toText, withId } from './evaluate';
import { createReactive } from './reactive';

const DEFAULT_FONT: Font = {
	fontFamily: 'Inter',
	fontSize: 16,
	fontWeight: 400,
	fontStyle: 'normal',
	lineHeight: null,
	letterSpacing: 0,
	color: '#000000',
	textAlign: 'start'
};

const inheritFont = (font: Font, st: Style): Font => {
	const next: any = { ...font };
	for (const key of TYPO) if (st[key] !== undefined) next[key] = st[key];
	return next;
};

function inlineRuns(parts: InlinePart[], font: Font, runs: Run[], scope: string): Run[] {
	for (const part of parts) {
		if (typeof part === 'string') runs.push({ text: part, font });
		else if (typeof part === 'function') runs.push({ text: toText(withId(scope, part)), font });
		else inlineRuns(part.kids, inheritFont(font, elementStyle(part, 'inline')), runs, part.id);
	}
	return runs;
}

/** `suffix` makes ids unique per `{#each}` item: `[key]` for each enclosing list. */
function realizeNodes(nodes: ProgramNode[], suffix: string, font: Font): Concrete[] {
	const out: Concrete[] = [];
	for (const d of nodes) {
		const id = d.id + suffix;
		if (d.t === 'text') {
			out.push({ type: 'text', id, tag: null, style: {}, font, runs: inlineRuns(d.parts, font, [], d.id) });
		} else if (d.t === 'el') {
			const st = elementStyle(d, d.kind);
			const own = inheritFont(font, st);
			const attr = (name: string) => (d.attrs[name] ? toText(withId(d.id, d.attrs[name])) : '');
			if (d.kind === 'frame')
				out.push({ type: 'frame', id, tag: d.tag, style: st, font: own, children: realizeNodes(d.kids, suffix, own) });
			else if (d.kind === 'text')
				out.push({ type: 'text', id, tag: d.tag, style: st, font: own, runs: inlineRuns(d.kids, own, [], d.id) });
			else
				out.push({
					type: 'input',
					id,
					tag: d.kind,
					style: st,
					font: own,
					value: attr('value'),
					placeholder: attr('placeholder'),
					inputType: attr('type') || 'text'
				});
		} else if (d.t === 'if') {
			const branch = withId(d.id, () => d.b.find(([test]) => test()));
			out.push(...realizeNodes(branch ? branch[1] : (d.e ?? []), suffix, font));
		} else if (d.t === 'each') {
			const list = withId(d.id, () => eachList(d.list()));
			const seen = new Set();
			list.forEach((raw, i) => {
				const key = withId(d.id, () => d.key({ v: raw }, { v: i }));
				if (seen.has(key)) throw new Error(`Duplicate each key ${JSON.stringify(key)} (at ${d.id})`);
				seen.add(key);
				out.push(...realizeNodes(d.kids({ v: raw }, { v: i }), `${suffix}[${JSON.stringify(key)}]`, font));
			});
		}
	}
	return out;
}

/** Runs the program without effects and evaluates the template once. */
export function realize(program: Program, overrides: Record<string, unknown> = {}): Concrete[] {
	const api = createApi(createReactive(), { overrides, design: true });
	return realizeNodes(program(api), '', DEFAULT_FONT);
}
