// Runtime shared by the browser bundle (imported by the Vite entry) and
// design-time evaluation.

export type Style = Record<string, any>;
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

export type Runtime = ReturnType<typeof createRuntime>;

export function createRuntime(overrides: Record<string, unknown> = {}, design = false) {
	// ---------------------------------------------------------------- reactivity
	type Owner = {
		children: Set<Owner>;
		cleanups: (() => void)[];
		parent: Owner | null;
		disposed: boolean;
		id?: number;
		fn?: () => void;
		deps?: Set<Set<Owner>>;
		derived?: () => void;
	};
	let owner: Owner | null = null;
	let observer: Owner | null = null;
	let nextId = 0;
	let batchDepth = 0;
	let flushing = false;
	const queue = new Set<Owner>();

	const newOwner = (extra: Partial<Owner> = {}): Owner => {
		const o: Owner = { children: new Set(), cleanups: [], parent: owner, disposed: false, ...extra };
		owner?.children.add(o);
		return o;
	};
	const reset = (o: Owner) => {
		for (const child of [...o.children]) dispose(child);
		for (const cleanup of o.cleanups.splice(0)) cleanup();
		if (o.deps) {
			for (const subs of o.deps) subs.delete(o);
			o.deps.clear();
		}
	};
	const dispose = (o: Owner) => {
		if (o.disposed) return;
		reset(o);
		o.disposed = true;
		o.parent?.children.delete(o);
	};
	const within = <T>(o: Owner | null, obs: Owner | null, fn: () => T): T => {
		const prevOwner = owner;
		const prevObserver = observer;
		owner = o;
		observer = obs;
		try {
			return fn();
		} finally {
			owner = prevOwner;
			observer = prevObserver;
		}
	};
	const track = (subs: Set<Owner>) => {
		if (!observer) return;
		subs.add(observer);
		observer.deps!.add(subs);
	};
	const trigger = (subs: Set<Owner>) => {
		batchDepth++;
		try {
			for (const c of [...subs]) c.derived ? c.derived() : queue.add(c);
		} finally {
			batchDepth--;
		}
		if (!batchDepth) flush();
	};
	const run = (c: Owner) => {
		reset(c);
		within(c, c, c.fn!);
	};
	const flush = () => {
		if (flushing) return;
		flushing = true;
		let rounds = 0;
		try {
			while (queue.size) {
				if (++rounds > 1000) throw new Error('Reactive loop: effects keep invalidating each other');
				const pending = [...queue].sort((a, b) => a.id! - b.id!);
				queue.clear();
				for (const c of pending) {
					if (c.disposed) continue;
					try {
						run(c);
					} catch (error) {
						console.error(error);
					}
				}
			}
		} finally {
			queue.clear();
			flushing = false;
		}
	};
	const batch = <T>(fn: () => T): T => {
		batchDepth++;
		try {
			return fn();
		} finally {
			batchDepth--;
			if (!batchDepth) flush();
		}
	};
	const untrack = <T>(fn: () => T): T => within(owner, null, fn);

	const cell = <T>(initial: T) => {
		const subs = new Set<Owner>();
		let value = initial;
		return {
			get v(): T {
				track(subs);
				return value;
			},
			set v(next: T) {
				if (Object.is(next, value)) return;
				value = next;
				trigger(subs);
			},
			notify: () => trigger(subs)
		};
	};
	type Cell = ReturnType<typeof cell<any>>;

	// `$state(init)`. Overrides replace the initial value (design-time states).
	const state = (id: string, initial?: unknown) =>
		cell(Object.prototype.hasOwnProperty.call(overrides, id) ? overrides[id] : initial);

	// `$derived(expr)`: lazy, cached, invalidated by its dependencies.
	const derived = <T>(fn: () => T) => {
		const subs = new Set<Owner>();
		let value: T;
		let dirty = true;
		const c: Owner = {
			children: new Set(),
			cleanups: [],
			parent: null,
			disposed: false,
			id: nextId++,
			deps: new Set(),
			derived: () => {
				if (dirty) return;
				dirty = true;
				trigger(subs);
			}
		};
		return {
			get v(): T {
				if (dirty) {
					reset(c);
					value = within(c, c, fn);
					dirty = false;
				}
				track(subs);
				return value;
			}
		};
	};

	// Internal effect: runs now, reruns when dependencies change.
	const effect = (fn: () => void) => {
		const c = newOwner({ id: nextId++, fn, deps: new Set() });
		run(c);
		return c;
	};

	// `$effect(fn)`: browser only, first run after mount. Never runs at design time.
	const userEffect = (fn: () => unknown) => {
		if (design) return;
		const c = newOwner({
			id: nextId++,
			deps: new Set(),
			fn: () => {
				const cleanup = fn();
				if (typeof cleanup === 'function') owner!.cleanups.push(cleanup as () => void);
			}
		});
		queue.add(c);
		if (!batchDepth) flush();
	};

	// Member assignment rooted at a state variable (`todos[0].done = true`).
	const mutate = <T>(target: Cell, result: T): T => {
		target.notify();
		return result;
	};

	// -------------------------------------------------------------------- styles
	const isPx = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
	const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
	const isColor = (v: unknown) =>
		typeof v === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v);
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
	const SHORTHANDS: Record<string, string[]> = {
		padding: ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'],
		margin: ['marginTop', 'marginRight', 'marginBottom', 'marginLeft']
	};
	const SHORTHAND_HINT = 'a pixel number, [vertical, horizontal] or [top, right, bottom, left]';
	const BOX = ['width', 'height', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight', ...SHORTHANDS.margin, 'alignSelf', 'position', 'left', 'top', 'opacity'];
	const TYPO = ['color', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'textAlign'];
	const PAINT = ['background', 'borderWidth', 'borderColor', 'borderRadius', 'shadow', ...SHORTHANDS.padding];
	const FLEX = ['display', 'flexDirection', 'justifyContent', 'alignItems', 'flexWrap', 'gap', 'overflow'];
	const ALLOWED: Record<string, string[]> = {
		frame: [...BOX, ...TYPO, ...PAINT, ...FLEX],
		input: [...BOX, ...TYPO, ...PAINT],
		textarea: [...BOX, ...TYPO, ...PAINT],
		text: [...BOX, ...TYPO],
		inline: TYPO.filter((k) => k !== 'textAlign')
	};
	const KIND_LABEL: Record<string, string> = {
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

	// Validates one style object and expands shorthands. Idempotent.
	const normalizeStyle = (input: unknown): Style => {
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
	};

	// `$style({...})`
	const style = (input: unknown) => normalizeStyle(input);

	// `style={a}`, `style={[a, cond && b]}`: merge left to right, skip falsy entries.
	const resolveStyle = (value: unknown): Style => {
		const out: Style = {};
		const add = (v: unknown) => {
			if (!v) return;
			if (Array.isArray(v)) v.forEach(add);
			else Object.assign(out, normalizeStyle(v));
		};
		add(value);
		return out;
	};

	const checkKey = (kind: string, key: string) => {
		const keys = SHORTHANDS[key] ?? [key];
		for (const k of keys) {
			if (!SPEC[k]) throw new Error(`Unsupported style property "${key}"`);
			if (!ALLOWED[kind].includes(k)) throw new Error(`"${key}" is not supported on ${KIND_LABEL[kind]}`);
		}
	};

	// The keys `checkKey` accepts for one element kind (shorthands included),
	// with the hint and string literals `normalizeStyle` accepts for each.
	const styleProperties = (kind: string) =>
		[...Object.keys(SHORTHANDS), ...Object.keys(SPEC)]
			.filter((key) => (SHORTHANDS[key] ?? [key]).every((k) => ALLOWED[kind].includes(k)))
			.map((key) => {
				const spec = SPEC[SHORTHANDS[key]?.[0] ?? key];
				return { name: key, hint: key in SHORTHANDS ? SHORTHAND_HINT : spec[1], values: ((spec[0] as any).values ?? []) as string[] };
			});

	// Validates a merged style for one element kind.
	const checkStyle = (kind: string, st: Style) => {
		for (const key of Object.keys(st)) checkKey(kind, key);
		if (st.justifyContent === 'space-between' && st.gap) throw new Error('justifyContent "space-between" cannot be combined with gap');
		if (st.justifyContent === 'space-between' && st.flexWrap === 'wrap') throw new Error('justifyContent "space-between" cannot be combined with flexWrap "wrap"');
		const absolute = st.position === 'absolute';
		if (!absolute && (st.left !== undefined || st.top !== undefined)) throw new Error('left/top require position: "absolute"');
		if (absolute && (st.width === 'fill' || st.height === 'fill')) throw new Error('absolute elements cannot use "fill" sizing');
		if ((kind === 'input' || kind === 'textarea') && (st.width ?? 'hug') === 'hug') throw new Error(`<${kind}> needs width: <number> or "fill"`);
		if (kind === 'textarea' && (st.height ?? 'hug') === 'hug') throw new Error('<textarea> needs height: <number> or "fill"');
	};

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

	const toString = (v: unknown) => (v === null || v === undefined || v === false ? '' : String(v));

	// ------------------------------------------------------- design evaluation
	type Desc = any;
	const withId = (id: string, fn: () => any) => {
		try {
			return fn();
		} catch (error: any) {
			if (!error.at) {
				error.message = `${error.message} (at ${id})`;
				error.at = id;
			}
			throw error;
		}
	};
	const elementStyle = (d: Desc, kind: string) =>
		withId(d.id, () => {
			const st = d.style ? resolveStyle(d.style()) : {};
			checkStyle(kind, st);
			return st;
		});
	const inlineRuns = (kids: Desc[], font: Font, runs: Run[], scope: string) => {
		for (const k of kids) {
			if (typeof k === 'string') runs.push({ text: k, font });
			else if (typeof k === 'function') runs.push({ text: toString(withId(scope, k)), font });
			else inlineRuns(k.kids, inheritFont(font, elementStyle(k, 'inline')), runs, k.id);
		}
		return runs;
	};
	const realizeNodes = (descs: Desc[], suffix: string, font: Font): Concrete[] => {
		const out: Concrete[] = [];
		for (const d of descs) {
			const id = d.id + suffix;
			if (d.t === 'text') {
				out.push({ type: 'text', id, tag: null, style: {}, font, runs: inlineRuns(d.parts, font, [], d.id) });
			} else if (d.t === 'el') {
				const st = elementStyle(d, d.kind);
				const own = inheritFont(font, st);
				const attr = (name: string) => (d.attrs[name] ? toString(withId(d.id, d.attrs[name])) : '');
				if (d.kind === 'frame')
					out.push({ type: 'frame', id, tag: d.tag, style: st, font: own, children: realizeNodes(d.kids, suffix, own) });
				else if (d.kind === 'text')
					out.push({ type: 'text', id, tag: d.tag, style: st, font: own, runs: inlineRuns(d.kids, own, [], d.id) });
				else
					out.push({
						type: 'input',
						id,
						tag: d.tag,
						style: st,
						font: own,
						value: attr('value'),
						placeholder: attr('placeholder'),
						inputType: attr('type') || 'text'
					});
			} else if (d.t === 'if') {
				const branch = withId(d.id, () => d.b.find((b: Desc) => b[0]()));
				out.push(...realizeNodes(branch ? branch[1] : d.e ?? [], suffix, font));
			} else if (d.t === 'each') {
				const list: unknown[] = withId(d.id, () => eachList(d.list()));
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
	};
	const eachList = (v: unknown): unknown[] => {
		if (v === null || v === undefined) return [];
		if (!Array.isArray(v)) throw new Error(`{#each} expects an array, got ${typeof v}`);
		return v;
	};

	// Runs the program without effects and evaluates the template once.
	const realize = (program: (rt: any) => Desc[]): Concrete[] => realizeNodes(program(api), '', DEFAULT_FONT);

	// ---------------------------------------------------------- browser output
	const BASE_CSS = `
html,body{margin:0;padding:0}
[data-p]{box-sizing:border-box;margin:0;padding:0;border:0;outline:0;min-width:0;min-height:0;flex:0 0 auto;font:inherit;color:inherit;letter-spacing:inherit;text-align:inherit;background:none;border-radius:0;appearance:none;-webkit-appearance:none;position:relative}
[data-p=frame]{display:flex;flex-direction:column;align-items:flex-start;align-content:flex-start}
[data-dir=row]{flex-direction:row}
[data-p=input],[data-p=textarea]{display:block;resize:none;overflow:hidden}
[data-p=input]::placeholder,[data-p=textarea]::placeholder{color:currentColor;opacity:.5}
[data-p=text]{display:block;white-space:pre}
[data-p=text][data-w=fixed],[data-p=text][data-w=fill]{white-space:pre-wrap}
[data-p=inline]{display:inline}
[data-dir=row]>[data-w=fill],[data-dir=column]>[data-h=fill]{flex:1 1 0}
[data-dir=row]>[data-h=fill],[data-dir=column]>[data-w=fill]{align-self:stretch!important}
[data-dir=row]>[data-p=frame][data-w=hug]{flex-shrink:1}
button[data-p]{cursor:pointer}
[data-host]{width:100vw;height:100vh;overflow:auto;background:#fff;font-family:"Inter";font-size:16px;font-weight:400;font-style:normal;line-height:1.2;letter-spacing:0;color:#000;text-align:start}
`;
	const FLEX_VALUE: Record<string, string> = { start: 'flex-start', center: 'center', end: 'flex-end', 'space-between': 'space-between' };
	const px = (v: unknown) => (v === 'auto' ? 'auto' : `${v}px`);

	// Translates a validated style into inline CSS plus the data-* attributes
	// that the fixed stylesheet above keys sizing semantics on.
	const toCss = (kind: string, st: Style) => {
		const css: Record<string, string> = {};
		const data: Record<string, string> = {
			w: typeof st.width === 'number' ? 'fixed' : st.width ?? 'hug',
			h: typeof st.height === 'number' ? 'fixed' : st.height ?? 'hug'
		};
		if (kind === 'frame') data.dir = st.flexDirection ?? 'column';
		if (typeof st.width === 'number') css.width = px(st.width);
		if (typeof st.height === 'number') css.height = px(st.height);
		for (const k of ['minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'left', 'top', 'gap', 'fontSize', 'lineHeight', 'letterSpacing'])
			if (st[k] !== undefined) css[k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())] = px(st[k]);
		const box = (prefix: string) => {
			const keys = SHORTHANDS[prefix];
			if (keys.some((k) => st[k] !== undefined)) css[prefix] = keys.map((k) => px(st[k] ?? 0)).join(' ');
		};
		box('padding');
		box('margin');
		if (st.justifyContent) css['justify-content'] = FLEX_VALUE[st.justifyContent];
		if (st.alignItems) css['align-items'] = FLEX_VALUE[st.alignItems];
		if (st.alignSelf) css['align-self'] = FLEX_VALUE[st.alignSelf];
		if (st.flexWrap) css['flex-wrap'] = st.flexWrap;
		if (st.position === 'absolute') css.position = 'absolute';
		if (st.background) css['background-color'] = st.background;
		if (st.color) css.color = st.color;
		if (st.opacity !== undefined) css.opacity = String(st.opacity);
		if (st.borderWidth) {
			// Borders are drawn inside the box and never affect layout.
			css.outline = `${st.borderWidth}px solid ${st.borderColor ?? '#000000'}`;
			css['outline-offset'] = `-${st.borderWidth}px`;
		}
		if (st.borderRadius) css['border-radius'] = st.borderRadius.map(px).join(' ');
		if (st.overflow) css.overflow = st.overflow;
		if (st.shadow) css['box-shadow'] = st.shadow.map((s: any) => `${s.x}px ${s.y}px ${s.blur}px ${s.spread}px ${s.color}`).join(', ');
		if (st.fontFamily) css['font-family'] = JSON.stringify(st.fontFamily);
		if (st.fontWeight) css['font-weight'] = String(st.fontWeight);
		if (st.fontStyle) css['font-style'] = st.fontStyle;
		if (st.textAlign) css['text-align'] = st.textAlign;
		return { css, data };
	};

	const bindStyle = (el: HTMLElement, d: Desc, kind: string) => {
		let prev: Record<string, string> = {};
		effect(() => {
			const { css, data } = toCss(kind, elementStyle(d, kind));
			for (const k of Object.keys(prev)) if (!(k in css)) el.style.removeProperty(k);
			for (const [k, v] of Object.entries(css)) if (prev[k] !== v) el.style.setProperty(k, v);
			for (const [k, v] of Object.entries(data)) el.setAttribute(`data-${k}`, v);
			prev = css;
		});
	};

	const setAttribute = (el: any, name: string, value: unknown) => {
		if (name === 'value') {
			const next = toString(value);
			if (el.value !== next) el.value = next;
		} else if (name === 'disabled') el.disabled = !!value;
		else el.setAttribute(name, toString(value));
	};

	const element = (d: Desc, kind: string) => {
		const el = document.createElement(d.tag);
		el.setAttribute('data-p', kind);
		if (d.style || kind !== 'inline') bindStyle(el, d, kind);
		for (const [name, value] of Object.entries(d.attrs ?? {}))
			effect(() => setAttribute(el, name, withId(d.id, value as () => unknown)));
		for (const [name, handler] of Object.entries(d.on ?? {}))
			el.addEventListener(name, (event: Event) =>
				batch(() => {
					const fn = untrack(handler as () => unknown);
					if (typeof fn === 'function') fn(event);
					else if (fn != null) throw new Error(`on${name} must be a function (at ${d.id})`);
				})
			);
		return el;
	};

	const mountInline = (kids: Desc[], parent: Node) => {
		for (const k of kids) {
			if (typeof k === 'string') parent.appendChild(document.createTextNode(k));
			else if (typeof k === 'function') {
				const node = document.createTextNode('');
				effect(() => (node.data = toString(k())));
				parent.appendChild(node);
			} else {
				const span = element({ ...k, tag: 'span' }, 'inline');
				mountInline(k.kids, span);
				parent.appendChild(span);
			}
		}
	};

	const removeRange = (start: Node, end: Node) => {
		let node: Node | null = start;
		while (node) {
			const next: Node | null = node === end ? null : node.nextSibling;
			node.parentNode?.removeChild(node);
			node = next;
		}
	};
	const moveRange = (start: Node, end: Node, before: Node) => {
		let node: Node | null = start;
		while (node) {
			const next: Node | null = node === end ? null : node.nextSibling;
			before.parentNode!.insertBefore(node, before);
			node = next;
		}
	};

	const mountNodes = (descs: Desc[], parent: Node, before: Node | null) => {
		for (const d of descs) {
			if (d.t === 'text') {
				const span = document.createElement('span');
				span.setAttribute('data-p', 'text');
				span.setAttribute('data-w', 'hug');
				span.setAttribute('data-h', 'hug');
				mountInline(d.parts, span);
				parent.insertBefore(span, before);
			} else if (d.t === 'el') {
				const el = element(d, d.kind);
				if (d.kind === 'frame') mountNodes(d.kids, el, null);
				else if (d.kind === 'text') mountInline(d.kids, el);
				parent.insertBefore(el, before);
			} else if (d.t === 'if') mountIf(d, parent, before);
			else if (d.t === 'each') mountEach(d, parent, before);
		}
	};

	// A false branch is unmounted; re-entering it creates it again.
	const mountIf = (d: Desc, parent: Node, before: Node | null) => {
		const end = parent.insertBefore(document.createComment('/if'), before);
		const container = newOwner();
		let active = -2;
		let branch: { start: Node; owner: Owner } | null = null;
		within(container, null, () =>
			effect(() => {
				const index = withId(d.id, () => d.b.findIndex((b: Desc) => b[0]()));
				if (index === active) return;
				active = index;
				untrack(() => {
					if (branch) {
						dispose(branch.owner);
						removeRange(branch.start, end.previousSibling!);
					}
					const kids = index >= 0 ? d.b[index][1] : d.e;
					if (!kids) return (branch = null);
					const start = parent.insertBefore(document.createComment('if'), end);
					const o = within(container, null, () => newOwner());
					within(o, null, () => mountNodes(kids, parent, end));
					branch = { start, owner: o };
				});
			})
		);
	};

	// Keyed list: existing keys keep their DOM and state, removed keys are
	// destroyed, new keys are created. Items are moved to match list order.
	const mountEach = (d: Desc, parent: Node, before: Node | null) => {
		const end = parent.insertBefore(document.createComment('/each'), before);
		const container = newOwner();
		type Item = { item: Cell; index: Cell; start: Node; end: Node; owner: Owner };
		let items = new Map<unknown, Item>();
		within(container, null, () =>
			effect(() => {
				const list: unknown[] = withId(d.id, () => eachList(d.list()));
				untrack(() => {
					const next = new Map<unknown, Item>();
					const order: Item[] = [];
					list.forEach((raw, i) => {
						const key = withId(d.id, () => d.key({ v: raw }, { v: i }));
						if (next.has(key)) throw new Error(`Duplicate each key ${JSON.stringify(key)} (at ${d.id})`);
						let entry = items.get(key);
						if (entry) {
							entry.item.v = raw;
							entry.index.v = i;
						} else {
							const o = within(container, null, () => newOwner());
							const item = cell(raw);
							const index = cell(i);
							const start = parent.insertBefore(document.createComment('item'), end);
							const stop = parent.insertBefore(document.createComment('/item'), end);
							within(o, null, () => mountNodes(d.kids(item, index), parent, stop));
							entry = { item, index, start, end: stop, owner: o };
						}
						next.set(key, entry);
						order.push(entry);
					});
					for (const [key, entry] of items)
						if (!next.has(key)) {
							dispose(entry.owner);
							removeRange(entry.start, entry.end);
						}
					let cursor: Node = end;
					for (let i = order.length - 1; i >= 0; i--) {
						const entry = order[i];
						if (entry.end.nextSibling !== cursor) moveRange(entry.start, entry.end, cursor);
						cursor = entry.start;
					}
					items = next;
				});
			})
		);
	};

	const mount = (program: (rt: any) => Desc[], target: HTMLElement) => {
		const sheet = document.createElement('style');
		sheet.textContent = BASE_CSS;
		document.head.appendChild(sheet);
		target.setAttribute('data-p', 'frame');
		target.setAttribute('data-dir', 'column');
		target.setAttribute('data-host', '');
		const root = newOwner();
		batch(() => within(root, null, () => mountNodes(program(api), target, null)));
		return () => dispose(root);
	};

	const api = { state, derived, effect: userEffect, style, mutate };

	return { ...api, batch, untrack, resolveStyle, normalizeStyle, checkKey, checkStyle, styleProperties, realize, mount };
}
