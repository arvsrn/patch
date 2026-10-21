// Svelte AST → PAT IR.
//
// Lowering reports everything the IR cannot express: unsupported tags,
// blocks, directives and attributes, CSS strings, malformed rune
// declarations. It then drops the construct and carries on with its siblings
// (and, for an unsupported container, its children), so later phases only
// ever see valid PAT and one pass surfaces as many problems as possible.

import { literal, NOT_STATIC, unwrap, type Estree } from './ast';
import type { Reporter, Span } from './diagnostics';
import type { Attribute, AttributeValue, Component, Each, Element, If, Inline, Script, Tag, TemplateNode } from './ir';
import type { SvelteAst } from './parse';

type Svelte = any;

const KINDS: Record<Tag, Element['kind']> = {
	main: 'frame',
	div: 'frame',
	button: 'frame',
	p: 'text',
	span: 'text',
	input: 'input',
	textarea: 'textarea'
};
/** Attributes every element accepts (not an inline <span>). */
const UNIVERSAL_ATTRIBUTES = ['portal', 'anchorName'];
/** Attributes (other than style= and on*=) each tag accepts. */
const ATTRIBUTES: Partial<Record<Tag, string[]>> = {
	button: ['disabled'],
	input: ['value', 'placeholder', 'disabled', 'type'],
	textarea: ['value', 'placeholder', 'disabled']
};
const UNSUPPORTED_NODES: Record<string, string> = {
	Component: 'user-defined components are not supported in v0',
	HtmlTag: '{@html} is not supported',
	AwaitBlock: '{#await} is not supported in v0; use $state + $effect for async data',
	KeyBlock: '{#key} is not supported',
	SnippetBlock: '{#snippet} is not supported',
	RenderTag: '{@render} is not supported',
	ConstTag: '{@const} is not supported',
	DebugTag: '{@debug} is not supported',
	AttachTag: '{@attach} is not supported'
};
const UNSUPPORTED_DIRECTIVES: Record<string, string> = {
	SpreadAttribute: 'spread attributes are not supported',
	ClassDirective: 'class: is not supported; use style={[base, active && selected]}',
	StyleDirective: 'style: directives are not supported; use style={{ ... }}',
	OnDirective: 'on:event is not supported; use onevent={...}',
	UseDirective: 'use: actions are not supported',
	TransitionDirective: 'transitions are not supported in v0',
	AnimateDirective: 'animations are not supported in v0',
	AttachTag: '{@attach} is not supported'
};
const isTag = (name: string): name is Tag => name in KINDS;

/** A node's name when it has one (elements, attributes), else the node. */
const nameSpan = (node: Svelte): Span =>
	node.name_loc ? { start: node.name_loc.start.character, end: node.name_loc.end.character } : { start: node.start, end: node.end };
const spanOf = (node: Svelte): Span => ({ start: node.start, end: node.end });

export function lower(ast: SvelteAst, source: string, reporter: Reporter): Component {
	const a = ast as Svelte;
	if (a.css) reporter.report(a.css, '<style> is not supported; use style={...} with $style({...}) values');
	if (a.module) reporter.report(a.module, '<script module> is not supported in v0');
	if (a.options) reporter.report(a.options, '<svelte:options> is not supported');
	return {
		script: a.instance ? lowerScript(a.instance, source, reporter) : null,
		template: new TemplateLowering(reporter).children(a.fragment.nodes)
	};
}

// ------------------------------------------------------------------ script

/** `$state`, `$derived`, `$derived.by`, … for a rune callee, else null. */
const calleeName = (callee: Estree): string | null => {
	if (callee.type === 'Identifier') return callee.name;
	if (callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier')
		return `${callee.object.name}.${callee.property.name}`;
	return null;
};

function lowerScript(instance: Svelte, source: string, reporter: Reporter): Script {
	const program = instance.content;
	const lang = instance.attributes.find((a: Svelte) => a.name === 'lang')?.value?.[0]?.data === 'ts' ? 'ts' : 'js';
	const script: Script = {
		lang,
		span: { start: program.start, end: program.end },
		body: program.body,
		imports: [],
		state: [],
		derived: [],
		effects: [],
		styles: [],
		runes: new Set()
	};

	for (const statement of program.body) {
		if (statement.type === 'ImportDeclaration') {
			const from = statement.source.value;
			if (/\.(css|scss|sass|less|styl|stylus|pcss|postcss|sss)($|\?)/.test(from))
				reporter.report(statement.source, 'stylesheets are not supported; use style={...} with $style({...}) values');
			else if (/\.pat($|\?)/.test(from))
				reporter.report(statement.source, 'importing .pat files is not supported yet; a PAT app is a single .pat file (import .ts/.js modules instead)');
			// Vite only converts CommonJS for npm dependencies, not local files.
			else if (/^\.{0,2}\/.*\.c[jt]s$/.test(from))
				reporter.report(statement.source, 'local CommonJS modules are not supported; use an ES module (.ts, .js, .mjs). CommonJS npm packages are fine');
			script.imports.push(statement);
		} else if (statement.type === 'TSImportEqualsDeclaration') {
			reporter.report(statement, '`import x = require(...)` is not supported; use an ES import');
		} else if (/^(Export|TSExport)/.test(statement.type)) {
			reporter.report(statement, 'exports are not supported (a .pat file is a single app with no props)');
		} else if (statement.type === 'VariableDeclaration') {
			for (const d of statement.declarations) {
				const init = unwrap(d.init);
				const rune = init?.type === 'CallExpression' ? calleeName(init.callee) : null;
				if (rune === '$state' || rune === '$derived' || rune === '$derived.by') {
					script.runes.add(init);
					if (rune === '$state' && statement.kind !== 'let') reporter.report(statement, '$state must be declared with let');
					if (d.id.type !== 'Identifier') {
						reporter.report(d.id, `${rune} must be assigned to a plain identifier`);
						continue;
					}
					if (rune !== '$state') script.derived.push({ id: d.id, call: init, by: rune === '$derived.by' });
					else {
						const arg = init.arguments[0];
						const value = arg ? literal(arg) : undefined;
						script.state.push({
							id: d.id,
							call: init,
							info: {
								id: d.id.name,
								name: d.id.name,
								...reporter.position(d.start),
								defaultSource: arg ? source.slice(arg.start, arg.end) : 'undefined',
								...(value === NOT_STATIC ? {} : { defaultValue: value })
							}
						});
					}
				} else if (rune === '$style' && statement.kind === 'const' && d.id.type === 'Identifier' && unwrap(init.arguments[0])?.type === 'ObjectExpression') {
					script.styles.push({ id: d.id, object: unwrap(init.arguments[0]) });
				}
			}
		} else if (statement.type === 'ExpressionStatement') {
			const call = unwrap(statement.expression);
			if (call.type === 'CallExpression' && calleeName(call.callee) === '$effect') {
				script.runes.add(call);
				script.effects.push(call);
			}
		}
	}
	return script;
}

// ---------------------------------------------------------------- template

class TemplateLowering {
	constructor(private reporter: Reporter) {}

	private unsupported(node: Svelte) {
		this.reporter.report(nameSpan(node), UNSUPPORTED_NODES[node.type] ?? `<${node.name ?? node.type}> is not supported`);
	}

	/** The children of a container. Runs of text and `{expr}` become one Text node. */
	children(nodes: Svelte[]): TemplateNode[] {
		const out: TemplateNode[] = [];
		let group: Svelte[] = [];
		const flush = () => {
			const content = this.inline(group);
			if (content.length) out.push({ type: 'text', span: { start: group[0].start, end: group[group.length - 1].end }, content });
			group = [];
		};
		for (const node of nodes) {
			if (node.type === 'Text' || node.type === 'ExpressionTag') {
				group.push(node);
				continue;
			}
			if (node.type === 'Comment') continue;
			flush();
			if (node.type === 'RegularElement') out.push(...this.element(node));
			else if (node.type === 'IfBlock') out.push(this.ifBlock(node));
			else if (node.type === 'EachBlock') out.push(...this.eachBlock(node));
			else this.unsupported(node);
		}
		flush();
		return out;
	}

	private ifBlock(node: Svelte): If {
		const result: If = { type: 'if', span: spanOf(node), branches: [], otherwise: null };
		for (let current = node; current; ) {
			result.branches.push({ test: current.test, body: this.children(current.consequent.nodes) });
			const alternate = current.alternate?.nodes ?? [];
			const elseIf = alternate.find((n: Svelte) => n.type === 'IfBlock' && n.elseif);
			if (elseIf) current = elseIf;
			else {
				if (current.alternate) result.otherwise = this.children(alternate);
				current = null;
			}
		}
		return result;
	}

	private eachBlock(node: Svelte): Each[] {
		if (node.fallback) this.reporter.report(nameSpan(node.fallback.nodes[0] ?? node), '{:else} inside {#each} is not supported; use {#if list.length === 0}');
		const body = this.children(node.body.nodes);
		if (!node.context || node.context.type !== 'Identifier') {
			this.reporter.report(node, '{#each} needs `as item` with a plain identifier');
			return [];
		}
		return [{ type: 'each', span: spanOf(node), list: node.expression, item: node.context, index: node.index ?? null, key: node.key ?? null, body }];
	}

	/** One element, or (for an unsupported tag) its lowered children so their problems are reported too. */
	private element(node: Svelte): TemplateNode[] {
		const tag = node.name;
		if (tag === 'portal') return this.portal(node);
		if (!isTag(tag)) {
			this.reporter.report(nameSpan(node), `<${tag}> is not supported (use main, div, button, p, span, input, textarea)`);
			return this.children(node.fragment.nodes);
		}
		const kind = KINDS[tag];
		const { style, attributes } = this.attributes(node, kind);
		const base = { type: 'element' as const, tag, span: spanOf(node), nameSpan: nameSpan(node), style, attributes };
		const nodes = node.fragment.nodes;
		if (kind === 'frame') return [{ ...base, kind, children: this.children(nodes) }];
		if (kind === 'text') return [{ ...base, kind, content: this.inline(nodes) }];
		if (nodes.some((n: Svelte) => n.type !== 'Text' || n.data.trim()))
			this.reporter.report(nameSpan(node), `<${tag}> cannot have children; use value={...}`);
		return [{ ...base, kind }];
	}

	/** `<portal id="name" />`: only a static, non-empty id. */
	private portal(node: Svelte): TemplateNode[] {
		const needsId = '<portal> needs a static id: <portal id="name" />';
		let name: string | null = null;
		let id: Svelte = null;
		for (const a of node.attributes) {
			if (a.type === 'Attribute' && a.name === 'id') {
				id = a;
				const value = Array.isArray(a.value) && a.value.length === 1 && a.value[0].type === 'Text' ? a.value[0].data : '';
				if (value) name = value;
				else this.reporter.report(nameSpan(a), needsId);
			} else {
				const what = a.type === 'Attribute' ? `attribute "${a.name}"` : (UNSUPPORTED_DIRECTIVES[a.type] ?? a.type);
				this.reporter.report(nameSpan(a), `${what} is not supported on <portal>; it only takes id="..."`);
			}
		}
		if (!id) this.reporter.report(nameSpan(node), needsId);
		if (node.fragment.nodes.some((n: Svelte) => n.type !== 'Text' || n.data.trim()))
			this.reporter.report(nameSpan(node), '<portal> cannot have children; elements render into it with portal="..."');
		return name === null ? [] : [{ type: 'portal', span: spanOf(node), nameSpan: nameSpan(node), name }];
	}

	/** `kind` is null for a <span> nested in text, which only takes style=. */
	private attributes(node: Svelte, kind: Element['kind'] | null) {
		let style: Estree | null = null;
		const attributes: Attribute[] = [];
		const inText = kind === null;
		const where = `<${node.name}>${inText ? ' inside text' : ''}`;
		const expressionOf = (a: Svelte): Estree | null => {
			if (a.value !== true && !Array.isArray(a.value)) return a.value.expression;
			this.reporter.report(nameSpan(a), `${a.name} needs an expression: ${a.name}={...}`);
			return null;
		};
		for (const a of node.attributes) {
			const span = spanOf(a);
			if (a.type === 'BindDirective') {
				if (a.name === 'this' ? inText : a.name !== 'value' || (kind !== 'input' && kind !== 'textarea'))
					this.reporter.report(nameSpan(a), inText ? `bind:${a.name} is not supported on ${where}` : 'only bind:value on <input>/<textarea> and bind:this are supported');
				else attributes.push({ type: 'bind', name: a.name, span, nameSpan: nameSpan(a), expression: a.expression });
			} else if (a.type !== 'Attribute') {
				this.reporter.report(nameSpan(a), UNSUPPORTED_DIRECTIVES[a.type] ?? `${a.type} is not supported`);
			} else if (a.name === 'style') {
				if (Array.isArray(a.value) && a.value.some((part: Svelte) => part.type === 'Text'))
					this.reporter.report(nameSpan(a), 'CSS strings are not supported; use style={$style({...})} or style={{ ... }}');
				else style = expressionOf(a);
			} else if (a.name === 'class') {
				this.reporter.report(nameSpan(a), 'class= is not supported; use style={...}');
			} else if (/^on[a-z]+$/.test(a.name) && !inText) {
				const handler = expressionOf(a);
				if (handler) attributes.push({ type: 'event', name: a.name.slice(2), span, nameSpan: nameSpan(a), handler });
			} else if (!inText && (UNIVERSAL_ATTRIBUTES.includes(a.name) || ATTRIBUTES[node.name as Tag]?.includes(a.name))) {
				attributes.push({ type: 'attribute', name: a.name, span, nameSpan: nameSpan(a), value: attributeValue(a) });
			} else {
				this.reporter.report(nameSpan(a), `attribute "${a.name}" is not supported on ${where}`);
			}
		}
		return { style, attributes };
	}

	/**
	 * Text content. Static whitespace collapses to one space and is trimmed at
	 * the edges (across nested spans); expression values are kept verbatim.
	 */
	private inline(nodes: Svelte[]): Inline[] {
		const content = this.inlineParts(nodes, { space: true });
		const trimEnd = (list: Inline[]) => {
			const last = list[list.length - 1];
			if (last?.type === 'static') {
				const trimmed = last.value.trimEnd();
				if (trimmed) last.value = trimmed;
				else list.pop();
			} else if (last?.type === 'span') trimEnd(last.content);
		};
		trimEnd(content);
		return content;
	}

	private inlineParts(nodes: Svelte[], state: { space: boolean }): Inline[] {
		const out: Inline[] = [];
		for (const node of nodes) {
			if (node.type === 'Comment') continue;
			if (node.type === 'Text') {
				let text = node.data.replace(/\s+/g, ' ');
				if (state.space && text.startsWith(' ')) text = text.slice(1);
				if (!text) continue;
				out.push({ type: 'static', value: text });
				state.space = text.endsWith(' ');
			} else if (node.type === 'ExpressionTag') {
				out.push({ type: 'expression', expression: node.expression });
				state.space = false;
			} else if (node.type === 'RegularElement') {
				if (node.name !== 'span') {
					this.reporter.report(nameSpan(node), `<${node.name}> cannot appear inside text; only <span> can`);
					out.push(...this.inlineParts(node.fragment.nodes, state));
					continue;
				}
				const { style } = this.attributes(node, null);
				out.push({ type: 'span', span: spanOf(node), nameSpan: nameSpan(node), style, content: this.inlineParts(node.fragment.nodes, state) });
			} else if (node.type === 'IfBlock' || node.type === 'EachBlock') {
				this.reporter.report(node, 'blocks cannot appear inside text; use a ternary {cond ? "a" : "b"} or move the block into a <div>');
			} else this.unsupported(node);
		}
		return out;
	}
}

function attributeValue(a: Svelte): AttributeValue {
	if (a.value === true) return true;
	if (!Array.isArray(a.value)) return { expression: a.value.expression };
	return { parts: a.value.map((part: Svelte) => (part.type === 'Text' ? part.data : part.expression)) };
}
