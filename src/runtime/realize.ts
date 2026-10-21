// Design-time evaluation: run a program once (no effects) with optional state
// overrides and evaluate its template into a concrete tree.
//
// The tree is the rendered tree: an element with `portal="name"` appears
// where `<portal id="name" />` is, and inherits typography from there, as in
// the browser. Its getters still run in the scope of where it is declared.

import type { Concrete, Font, Run } from '../schema/concrete';
import type { ElementNode, InlinePart, Program, ProgramNode } from '../schema/program';
import { TYPO, type Style } from '../schema/style';
import { createApi } from './api';
import { eachList, elementStyle, portalName, toText, withId } from './evaluate';
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

/** Where a `<portal>`'s content goes in the tree until it is filled in. */
type Slot = { type: 'slot'; name: string };
/** An element rendered into a portal: realized once its portal's font is known. */
type Portaled = { name: string; at: string; render: (font: Font) => Concrete; done?: Concrete };

class Realizer {
	private portals = new Map<string, { at: string; font: Font }>();
	private portaled: Portaled[] = [];

	/** `suffix` makes ids unique per `{#each}` item: `[key]` for each enclosing list. */
	nodes(nodes: ProgramNode[], suffix: string, font: Font): Concrete[] {
		const out: Concrete[] = [];
		for (const d of nodes) {
			const id = d.id + suffix;
			if (d.t === 'text') {
				out.push({ type: 'text', id, tag: null, style: {}, font, runs: inlineRuns(d.parts, font, [], d.id) });
			} else if (d.t === 'el') {
				const name = d.portal ? withId(d.id, () => portalName(d.portal!())) : null;
				if (name === null) out.push(this.element(d, id, suffix, font));
				else this.portaled.push({ name, at: d.id, render: (font) => this.element(d, id, suffix, font) });
			} else if (d.t === 'portal') {
				const existing = this.portals.get(d.name);
				if (existing) throw new Error(`Duplicate <portal id="${d.name}"> (at ${existing.at} and ${d.id})`);
				this.portals.set(d.name, { at: d.id, font });
				const slot: Slot = { type: 'slot', name: d.name };
				out.push(slot as unknown as Concrete);
			} else if (d.t === 'if') {
				const branch = withId(d.id, () => d.b.find(([test]) => test()));
				out.push(...this.nodes(branch ? branch[1] : (d.e ?? []), suffix, font));
			} else if (d.t === 'each') {
				const list = withId(d.id, () => eachList(d.list()));
				const seen = new Set();
				list.forEach((raw, i) => {
					const key = withId(d.id, () => d.key({ v: raw }, { v: i }));
					if (seen.has(key)) throw new Error(`Duplicate each key ${JSON.stringify(key)} (at ${d.id})`);
					seen.add(key);
					out.push(...this.nodes(d.kids({ v: raw }, { v: i }), `${suffix}[${JSON.stringify(key)}]`, font));
				});
			}
		}
		return out;
	}

	private element(d: ElementNode, id: string, suffix: string, font: Font): Concrete {
		const st = elementStyle(d, d.kind);
		const own = inheritFont(font, st);
		const attr = (name: string) => (d.attrs[name] ? toText(withId(d.id, d.attrs[name])) : '');
		if (d.kind === 'frame') return { type: 'frame', id, tag: d.tag, style: st, font: own, children: this.nodes(d.kids, suffix, own) };
		if (d.kind === 'text') return { type: 'text', id, tag: d.tag, style: st, font: own, runs: inlineRuns(d.kids, own, [], d.id) };
		return {
			type: 'input',
			id,
			tag: d.kind,
			style: st,
			font: own,
			value: attr('value'),
			placeholder: attr('placeholder'),
			inputType: attr('type') || 'text'
		};
	}

	/**
	 * Realizes portaled elements with their portal's font (a portal may itself
	 * be inside portaled content), then puts them in place of their portal,
	 * in the order they were declared.
	 */
	finish(tree: Concrete[]): Concrete[] {
		for (let progress = true; progress; ) {
			progress = false;
			for (const p of this.portaled) {
				const portal = this.portals.get(p.name);
				if (p.done || !portal) continue;
				p.done = p.render(portal.font);
				progress = true;
			}
		}
		const missing = this.portaled.find((p) => !p.done);
		if (missing) throw new Error(`No <portal id="${missing.name}"> is rendered (portal="${missing.name}" at ${missing.at})`);
		const fill = (nodes: Concrete[], within: string[]): Concrete[] =>
			nodes.flatMap((n) => {
				const slot = n as unknown as Slot | Concrete;
				if (slot.type === 'slot') {
					if (within.includes(slot.name)) throw new Error(`<portal id="${slot.name}"> is inside an element rendered into it (at ${this.portals.get(slot.name)!.at})`);
					return fill(this.portaled.filter((p) => p.name === slot.name).map((p) => p.done!), [...within, slot.name]);
				}
				if (slot.type === 'frame') slot.children = fill(slot.children, within);
				return [slot];
			});
		return fill(tree, []);
	}
}

/** Runs the program without effects and evaluates the template once. */
export function realize(program: Program, overrides: Record<string, unknown> = {}): Concrete[] {
	const { api } = createApi(createReactive(), { overrides, design: true });
	const realizer = new Realizer();
	return realizer.finish(realizer.nodes(program(api), '', DEFAULT_FONT));
}
