// Design-time evaluation: run a program once (no effects) with optional state
// overrides and evaluate its template into a concrete tree.
//
// The tree is the rendered tree: an element with `portal="name"` appears
// where `<portal id="name" />` is, and inherits typography from there, as in
// the browser. Its getters still run in the scope of where it is declared.
//
// `bind:this` variables hold a design-time stand-in for their element (there
// is no DOM). The template is evaluated twice, so an expression reading one
// sees the element it ends up holding even when that element comes later in
// the document, as it does in the browser once everything is mounted. Both
// evaluations share the component instances (by path), so their scripts run
// once and their state is the one the stand-ins were written into.
//
// Concrete ids are node ids (see schema/path.ts): `Row@12:3["a"]/4:5[0]`, or
// `4:5[0]` in the app itself.

import { DESIGN_NODE, isDesignNode, type DesignNode } from '../schema/anchor';
import type { Concrete, Font, Run, SvgContent } from '../schema/concrete';
import type { ElementNode, Getter, InlinePart, Program, ProgramNode } from '../schema/program';
import { inheritFont, ROOT_FONT } from '../schema/style';
import { createApi, type Instance } from './api';
import { eachPlace, instancePlace, nodeId, renderPlace, ROOT_PLACE, type Place } from '../schema/path';
import type { Location } from '../schema/route';
import { svgSize } from '../schema/svg';
import { componentOf, eachList, elementStyle, portalName, renderable, toText, withId } from './evaluate';
import { reactive } from './reactive';
import { pageOf } from './router';

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

/** What evaluated content belongs to: the component instance rendering it, and where it is. */
type Scope = { instance: Instance; place: Place };
type Instances = Map<string, { component: unknown; instance: Instance; nodes: ProgramNode[] }>;
type MakeInstance = (parent: Instance, path: string, props: Record<string, Getter>) => Instance;

class Realizer {
	/** Stand-ins per element and instances per path, by concrete id, shared by both evaluations. */
	constructor(
		private handles: Map<string, DesignNode>,
		private instances: Instances,
		private makeInstance: MakeInstance
	) {}

	private portals = new Map<string, { at: string; font: Font }>();
	private portaled: Portaled[] = [];

	nodes(nodes: ProgramNode[], scope: Scope, font: Font): Concrete[] {
		const out: Concrete[] = [];
		for (const d of nodes) {
			const id = nodeId(scope.place, d.id);
			if (d.t === 'text') {
				out.push({ type: 'text', id, tag: null, style: {}, font, runs: inlineRuns(d.parts, font, [], d.id) });
			} else if (d.t === 'el') {
				const name = d.portal ? withId(d.id, () => portalName(d.portal!())) : null;
				if (name === null) out.push(this.element(d, id, scope, font));
				else this.portaled.push({ name, at: d.id, render: (font) => this.element(d, id, scope, font) });
			} else if (d.t === 'portal') {
				const existing = this.portals.get(d.name);
				if (existing) throw new Error(`Duplicate <portal id="${d.name}"> (at ${existing.at} and ${d.id})`);
				this.portals.set(d.name, { at: d.id, font });
				const slot: Slot = { type: 'slot', name: d.name };
				out.push(slot as unknown as Concrete);
			} else for (const part of this.expand(d, scope)) out.push(...this.nodes(part.nodes, part.scope, font));
		}
		return out;
	}

	/** What an `{#if}`, `{#each}`, component or `{@render}` renders, and the scope each part renders in. */
	private expand(d: ProgramNode, scope: Scope): { nodes: ProgramNode[]; scope: Scope }[] {
		if (d.t === 'if') {
			const branch = withId(d.id, () => d.b.find(([test]) => test()));
			return [{ nodes: branch ? branch[1] : (d.e ?? []), scope }];
		}
		if (d.t === 'each') {
			const seen = new Set();
			return withId(d.id, () => eachList(d.list())).map((raw, i) => {
				const key = withId(d.id, () => d.key({ v: raw }, { v: i }));
				if (seen.has(key)) throw new Error(`Duplicate each key ${JSON.stringify(key)} (at ${d.id})`);
				seen.add(key);
				return { nodes: d.kids({ v: raw }, { v: i }), scope: { ...scope, place: eachPlace(scope.place, key) } };
			});
		}
		if (d.t === 'component') {
			const component = withId(d.id, () => componentOf(d.component(), d.tag, d.id)) as Program;
			const place = instancePlace(scope.place, d.tag, d.id);
			let entry = this.instances.get(place.path);
			if (entry?.component !== component) {
				const props = Object.fromEntries(Object.entries(d.props).map(([name, get]) => [name, () => withId(d.id, get)]));
				const instance = this.makeInstance(scope.instance, place.path, props);
				this.instances.set(place.path, (entry = { component, instance, nodes: withId(d.id, () => component(instance.api)) }));
			}
			return [{ nodes: entry.nodes, scope: { instance: entry.instance, place } }];
		}
		if (d.t === 'render') {
			const fn = withId(d.id, () => renderable(d.snippet(), d.optional, d.id));
			if (!fn) return [];
			const args = d.args.map((arg) => ({ get v() { return withId(d.id, arg); } }));
			return [{ nodes: fn(...args), scope: { instance: scope.instance, place: renderPlace(scope.place, d.id) } }];
		}
		return [];
	}

	/** The SVG an <svg> holds: its elements' tags and attributes, and text, as rendered. */
	private graphics(nodes: ProgramNode[], scope: Scope): SvgContent[] {
		const out: SvgContent[] = [];
		for (const d of nodes) {
			if (d.t === 'text') out.push(d.parts.map((p) => (typeof p === 'string' ? p : typeof p === 'function' ? toText(withId(d.id, p)) : '')).join(''));
			else if (d.t === 'el' && d.kind === 'graphic') {
				this.bind(d, nodeId(scope.place, d.id));
				out.push({ tag: d.tag, attrs: this.attrs(d), children: this.graphics(d.kids, scope) });
			} else if (d.t === 'el') throw new Error(`<${d.tag}> cannot be inside <svg> (at ${d.id})`);
			else for (const part of this.expand(d, scope)) out.push(...this.graphics(part.nodes, part.scope));
		}
		return out;
	}

	/** An element's attributes as rendered: a boolean is the attribute's presence, null and undefined none. */
	private attrs(d: ElementNode): Record<string, string> {
		const out: Record<string, string> = {};
		for (const [name, get] of Object.entries(d.attrs)) {
			const v = withId(d.id, get);
			if (v === null || v === undefined || v === false) continue;
			out[name] = v === true ? '' : toText(v);
		}
		return out;
	}

	/** `bind:this` holds a stand-in for the element: its concrete id. */
	private bind(d: ElementNode, id: string) {
		if (!d.ref) return;
		let handle = this.handles.get(id);
		if (!handle) this.handles.set(id, (handle = Object.freeze({ [DESIGN_NODE]: id })));
		d.ref.set(handle);
	}

	private element(d: ElementNode, id: string, scope: Scope, font: Font): Concrete {
		// Lowering keeps options inside a select, which reads them (`options`); SVG elements are inside an <svg>.
		if (d.kind === 'option' || d.kind === 'optgroup' || d.kind === 'graphic') throw new Error(`<${d.tag}> outside its <${d.kind === 'graphic' ? 'svg' : 'select'}> (at ${d.id})`);
		const st = elementStyle(d, d.kind);
		const own = inheritFont(font, st);
		// A stand-in for an element holds its concrete id; anything else anchors to nothing.
		const { anchor, ...style } = st;
		const styled = { style, ...(anchor === undefined ? {} : { anchor: isDesignNode(anchor) ? anchor[DESIGN_NODE] : null }) };
		const attr = (name: string) => (d.attrs[name] ? toText(withId(d.id, d.attrs[name])) : '');
		this.bind(d, id);
		if (d.kind === 'frame') return { type: 'frame', id, tag: d.tag, ...styled, font: own, children: this.nodes(d.kids, scope, own) };
		if (d.kind === 'text') return { type: 'text', id, tag: d.tag, ...styled, font: own, runs: inlineRuns(d.kids, own, [], d.id) };
		if (d.kind === 'svg') {
			const attrs = this.attrs(d);
			return { type: 'svg', id, tag: 'svg', ...styled, font: own, attrs, size: svgSize(attrs), children: this.graphics(d.kids, scope) };
		}
		if (d.kind === 'image') return { type: 'image', id, tag: 'img', ...styled, font: own, src: attr('src'), alt: attr('alt') };
		if (d.kind === 'select') {
			// It shows the label of the option whose value is its value, else the first, as the browser does.
			const options = this.options(d.kids, scope, []);
			const value = attr('value');
			const shown = options.find((o) => o.value === value) ?? options[0];
			return { type: 'input', id, tag: 'select', ...styled, font: own, value: shown?.label ?? '', placeholder: '', inputType: 'select' };
		}
		return {
			type: 'input',
			id,
			tag: d.kind,
			...styled,
			font: own,
			value: attr('value'),
			placeholder: attr('placeholder'),
			inputType: attr('type') || 'text'
		};
	}

	/** The options a select holds, in order: directly, in optgroups, and in `{#if}` and `{#each}`. */
	private options(nodes: ProgramNode[], scope: Scope, out: { value: string; label: string }[]) {
		for (const d of nodes) {
			if (d.t === 'el' && d.kind === 'option') {
				const label = d.kids.map((p) => (typeof p === 'string' ? p : typeof p === 'function' ? toText(withId(d.id, p)) : '')).join('');
				out.push({ value: d.attrs.value ? toText(withId(d.id, d.attrs.value)) : label, label });
			} else if (d.t === 'el' && d.kind === 'optgroup') this.options(d.kids, scope, out);
			else for (const part of this.expand(d, scope)) this.options(part.nodes, part.scope, out);
		}
		return out;
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

/** An anchor that is not rendered is no anchor: null. */
function resolveAnchors(tree: Concrete[]) {
	const ids = new Set<string>();
	const anchored: Concrete[] = [];
	const walk = (nodes: Concrete[]) => {
		for (const n of nodes) {
			ids.add(n.id);
			if (n.anchor) anchored.push(n);
			if (n.type === 'frame') walk(n.children);
		}
	};
	walk(tree);
	for (const n of anchored) if (!ids.has(n.anchor!)) n.anchor = null;
}

const designGoto = (url: string | URL) => {
	throw new Error(`goto(${JSON.stringify(String(url))}) cannot navigate at design time; evaluate the page at that URL instead`);
};

/**
 * Runs the program without effects and evaluates its template (twice, for
 * `bind:this`; see above). A page is evaluated at `location`, which its
 * `page` reads.
 */
export function realize(program: Program, overrides: Record<string, unknown> = {}, location?: Location): Concrete[] {
	const routing = location && { page: pageOf(() => location), goto: designGoto };
	const { root: makeRoot, instance } = createApi(reactive, { overrides, design: true }, routing);
	const root = makeRoot();
	const nodes = program(root.api);
	const handles = new Map<string, DesignNode>();
	const instances: Instances = new Map();
	const evaluate = () => {
		const realizer = new Realizer(handles, instances, instance);
		return realizer.finish(realizer.nodes(nodes, { instance: root, place: ROOT_PLACE }, ROOT_FONT));
	};
	evaluate();
	const tree = evaluate();
	resolveAnchors(tree);
	return tree;
}
