// Name resolution: the one scope-aware walk over the script and template.
//
// It records what every identifier reference resolves to (and whether it is
// read or written), every assignment through a member (`a.b = c`), and every
// rune call. Checks and code generation read these lists; neither tracks
// scopes itself.

import { children, isTypeNode, patternNames, rootOf, unwrap, type Estree } from './ast';
import type { Component, Inline, TemplateNode } from './ir';

export type SymbolKind = 'state' | 'derived' | 'item' | 'local';

/** A declared name. `style` is the object of a top-level `const x = $style({...})`. */
export type Symbol = { name: string; kind: SymbolKind; style?: Estree };

/** Reactive symbols: reads become `.v`. */
export const isSignal = (symbol: Symbol | null | undefined) => !!symbol && symbol.kind !== 'local';

export type Reference = {
	node: Estree;
	/** null: a global (or an unknown name). */
	symbol: Symbol | null;
	access: 'read' | 'write';
	/** `{ x }` in an object literal: emitted as `{ x: x.v }`. */
	shorthand: boolean;
	/** The `{ x }` property when this is a shorthand target of a destructuring assignment. */
	destructured: Estree | null;
};

/** An assignment or update through a member: `a.b = c`, `a[i]++`, or `[a.b] = …` (`inPattern`). */
export type MemberWrite = { node: Estree; target: Estree; root: Reference | null; inPattern: boolean };

/** A call to a `$`-name that resolves to nothing: `$state(…)`, `$derived.by(…)`, `$foo(…)`. */
export type RuneCall = { node: Estree; name: string };

export type Bindings = {
	references: Reference[];
	memberWrites: MemberWrite[];
	runeCalls: RuneCall[];
	/** The reference an identifier node is, if it is one. */
	reference(node: Estree): Reference | undefined;
	runeCall(node: Estree): RuneCall | undefined;
};

class Scope {
	vars = new Map<string, Symbol>();
	constructor(readonly parent?: Scope) {}
	get(name: string): Symbol | null {
		for (let s: Scope | undefined = this; s; s = s.parent) {
			const symbol = s.vars.get(name);
			if (symbol) return symbol;
		}
		return null;
	}
	declare(name: string, kind: SymbolKind, extra: Partial<Symbol> = {}) {
		if (!this.vars.has(name)) this.vars.set(name, { name, kind, ...extra });
	}
}

export function bind(component: Component): Bindings {
	const binder = new Binder();
	const top = new Scope();
	const script = component.script;
	if (script) {
		for (const d of script.state) top.declare(d.id.name, 'state');
		for (const d of script.derived) top.declare(d.id.name, 'derived');
		for (const d of script.styles) top.declare(d.id.name, 'local', { style: d.object });
		binder.hoist(script.body, top);
		for (const statement of script.body) if (statement.type !== 'ImportDeclaration') binder.visit(statement, top);
	}
	binder.template(component.template, new Scope(top));

	const byNode = new Map(binder.references.map((r) => [r.node, r]));
	const calls = new Map(binder.runeCalls.map((c) => [c.node, c]));
	return {
		references: binder.references,
		memberWrites: binder.memberWrites,
		runeCalls: binder.runeCalls,
		reference: (node) => byNode.get(node),
		runeCall: (node) => calls.get(node)
	};
}

class Binder {
	references: Reference[] = [];
	memberWrites: MemberWrite[] = [];
	runeCalls: RuneCall[] = [];

	private reference(node: Estree, scope: Scope, access: Reference['access'], extra: Partial<Reference> = {}) {
		this.references.push({ node, symbol: scope.get(node.name), access, shorthand: false, destructured: null, ...extra });
	}

	/** Declares, as locals, the names `statements` introduce in their block. */
	hoist(statements: Estree[], scope: Scope) {
		for (const s of statements) {
			const names =
				s.type === 'VariableDeclaration'
					? s.declarations.flatMap((d: Estree) => patternNames(d.id))
					: (s.type === 'FunctionDeclaration' || s.type === 'ClassDeclaration') && s.id
						? [s.id.name]
						: s.type === 'ImportDeclaration'
							? s.specifiers.map((sp: Estree) => sp.local.name)
							: [];
			for (const name of names) scope.declare(name, 'local');
		}
	}

	private block(statements: Estree[], scope: Scope) {
		this.hoist(statements, scope);
		for (const s of statements) this.visit(s, scope);
	}

	visit(node: Estree, scope: Scope): void {
		if (!node || typeof node.type !== 'string') return;
		switch (node.type) {
			case 'Identifier':
				return this.reference(node, scope, 'read');
			case 'MemberExpression':
				this.visit(node.object, scope);
				if (node.computed) this.visit(node.property, scope);
				return;
			case 'Property':
				if (node.computed) this.visit(node.key, scope);
				if (node.shorthand && node.value.type === 'Identifier') return this.reference(node.value, scope, 'read', { shorthand: true });
				return this.visit(node.value, scope);
			case 'MethodDefinition':
			case 'PropertyDefinition':
				if (node.computed) this.visit(node.key, scope);
				return this.visit(node.value, scope);
			case 'FunctionDeclaration':
			case 'FunctionExpression':
			case 'ArrowFunctionExpression': {
				const inner = new Scope(scope);
				if (node.type === 'FunctionExpression' && node.id) inner.declare(node.id.name, 'local');
				for (const param of node.params) {
					for (const name of patternNames(param)) inner.declare(name, 'local');
					this.pattern(param, inner, false);
				}
				if (node.body.type === 'BlockStatement') this.block(node.body.body, inner);
				else this.visit(node.body, inner);
				return;
			}
			case 'ClassDeclaration':
			case 'ClassExpression':
				this.visit(node.superClass, scope);
				return this.visit(node.body, scope);
			case 'BlockStatement':
			case 'StaticBlock':
				return this.block(node.body, new Scope(scope));
			case 'ForStatement':
			case 'ForInStatement':
			case 'ForOfStatement': {
				const inner = new Scope(scope);
				const head = node.init ?? node.left;
				if (head?.type === 'VariableDeclaration') this.hoist([head], inner);
				else if (head && node.type !== 'ForStatement') this.pattern(head, scope, true);
				for (const key of ['init', 'test', 'update', 'right', 'body']) this.visit(node[key], inner);
				if (head?.type === 'VariableDeclaration' && node.type !== 'ForStatement') this.visit(head, inner);
				return;
			}
			case 'CatchClause': {
				const inner = new Scope(scope);
				for (const name of patternNames(node.param)) inner.declare(name, 'local');
				this.pattern(node.param, inner, false);
				return this.visit(node.body, inner);
			}
			case 'VariableDeclaration':
				for (const d of node.declarations) {
					this.pattern(d.id, scope, false);
					this.visit(d.init, scope);
				}
				return;
			case 'LabeledStatement':
				return this.visit(node.body, scope);
			case 'BreakStatement':
			case 'ContinueStatement':
			case 'MetaProperty':
				return;
			case 'AssignmentExpression':
			case 'UpdateExpression':
				return this.assignment(node, scope);
			case 'CallExpression':
				return this.call(node, scope);
		}
		if (isTypeNode(node)) return;
		for (const child of children(node)) this.visit(child, scope);
	}

	private call(node: Estree, scope: Scope) {
		const callee = node.callee;
		const name =
			callee.type === 'Identifier' && callee.name.startsWith('$') && !scope.get(callee.name)
				? callee.name
				: callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && callee.object.name.startsWith('$') && !scope.get(callee.object.name)
					? `${callee.object.name}.${callee.property.name}`
					: null;
		if (name) this.runeCalls.push({ node, name });
		else this.visit(callee, scope);
		for (const arg of node.arguments) this.visit(arg, scope);
	}

	private assignment(node: Estree, scope: Scope) {
		const target = unwrap(node.type === 'AssignmentExpression' ? node.left : node.argument);
		if (target.type === 'MemberExpression') {
			this.visit(target, scope);
			this.visit(node.right, scope);
			this.memberWrites.push({ node, target, root: this.rootReference(target), inPattern: false });
			return;
		}
		this.pattern(target, scope, true);
		this.visit(node.right, scope);
	}

	private rootReference(target: Estree): Reference | null {
		const root = rootOf(target);
		if (root?.type !== 'Identifier') return null;
		for (let i = this.references.length - 1; i >= 0; i--) if (this.references[i].node === root) return this.references[i];
		return null;
	}

	/**
	 * Patterns in declarations and parameters (`assign` false: names are
	 * declared, defaults and computed keys are read) and in destructuring
	 * assignments (`assign` true: names are written).
	 */
	private pattern(node: Estree, scope: Scope, assign: boolean, destructured: Estree | null = null): void {
		if (!node) return;
		switch (node.type) {
			case 'Identifier':
				if (assign) this.reference(node, scope, 'write', { destructured });
				return;
			case 'ObjectPattern':
				for (const p of node.properties) {
					if (p.type === 'RestElement') this.pattern(p.argument, scope, assign);
					else {
						if (p.computed) this.visit(p.key, scope);
						this.pattern(p.value, scope, assign, assign && p.shorthand ? p : null);
					}
				}
				return;
			case 'ArrayPattern':
				for (const element of node.elements) this.pattern(element, scope, assign);
				return;
			case 'AssignmentPattern':
				this.pattern(node.left, scope, assign, destructured);
				return this.visit(node.right, scope);
			case 'RestElement':
				return this.pattern(node.argument, scope, assign);
			case 'MemberExpression':
				this.visit(node, scope);
				this.memberWrites.push({ node, target: node, root: this.rootReference(node), inPattern: true });
				return;
			default:
				if (node.type.startsWith('TS')) return this.pattern(unwrap(node), scope, assign, destructured);
		}
	}

	template(nodes: TemplateNode[], scope: Scope) {
		for (const node of nodes) {
			if (node.type === 'text') this.inline(node.content, scope);
			else if (node.type === 'element') {
				this.visit(node.style, scope);
				for (const a of node.attributes) {
					if (a.type === 'event') this.visit(a.handler, scope);
					else if (a.type === 'bind') this.visit(a.expression, scope);
					else if (a.value !== true) {
						if ('expression' in a.value) this.visit(a.value.expression, scope);
						else for (const part of a.value.parts) if (typeof part !== 'string') this.visit(part, scope);
					}
				}
				if (node.kind === 'frame') this.template(node.children, scope);
				if (node.kind === 'text') this.inline(node.content, scope);
			} else if (node.type === 'if') {
				for (const branch of node.branches) {
					this.visit(branch.test, scope);
					this.template(branch.body, scope);
				}
				if (node.otherwise) this.template(node.otherwise, scope);
			} else {
				this.visit(node.list, scope);
				const inner = new Scope(scope);
				inner.declare(node.item.name, 'item');
				if (node.index) inner.declare(node.index, 'item');
				this.visit(node.key, inner);
				this.template(node.body, inner);
			}
		}
	}

	private inline(content: Inline[], scope: Scope) {
		for (const part of content) {
			if (part.type === 'expression') this.visit(part.expression, scope);
			else if (part.type === 'span') {
				this.visit(part.style, scope);
				this.inline(part.content, scope);
			}
		}
	}
}
