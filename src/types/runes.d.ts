// What a .pat script, and any TypeScript in a Patch app, can use without
// importing it: the runes, and the types of `.pat` files and the 'patch'
// module. Read by Patch's type checker (typecheck.ts) and by the editor's
// TypeScript plugin (editors/vscode/ts-plugin), so both see the same thing.

declare function $state<T>(initial: T): T;
declare function $state<T>(): T | undefined;
declare function $derived<T>(value: T): T;
declare namespace $derived {
	function by<T>(fn: () => T): T;
}
declare function $effect(fn: () => void | (() => void)): void;
/** A validated style. Which properties are legal where is checked by the PAT compiler. */
interface PatStyle {
	readonly [property: string]: unknown;
}
declare function $style(style: { readonly [property: string]: unknown }): PatStyle;
/** A value of module state: read-only all the way down, so it is replaced rather than changed in place. */
type PatReadonly<T> = T extends (...args: any[]) => unknown
	? T
	: T extends ReadonlyMap<infer K, infer V>
		? ReadonlyMap<PatReadonly<K>, PatReadonly<V>>
		: T extends ReadonlySet<infer V>
			? ReadonlySet<PatReadonly<V>>
			: T extends object
				? { readonly [K in keyof T]: PatReadonly<T[K]> }
				: T;
/** Module state: its properties are assigned; their values are read-only. */
type PatModuleState<T> = { -readonly [K in keyof T]: PatReadonly<T[K]> };
/** The component's props: destructure them, with types: let { a, b = 1 }: Props = $props(). */
declare function $props(): any;
/** A .pat file: a component. */
interface PatComponent {
	readonly __patComponent: true;
}
/** An image imported from a script, as Vite serves it: its URL. */
declare module '*.png' { const src: string; export default src; }
declare module '*.jpg' { const src: string; export default src; }
declare module '*.jpeg' { const src: string; export default src; }
declare module '*.gif' { const src: string; export default src; }
declare module '*.webp' { const src: string; export default src; }
declare module '*.avif' { const src: string; export default src; }
declare module '*.svg' { const src: string; export default src; }
declare module '*.ico' { const src: string; export default src; }
declare module '*.pat' {
	const component: PatComponent;
	export default component;
}
declare module 'patch' {
	/** An opaque context key, made by createContext. */
	export interface Context<T> {
		readonly __patContext: T;
	}
	export function createContext<T>(): Context<T>;
	/** Provides value to this component instance and everything it renders. Top-level statements only. */
	export function setContext<T>(context: Context<T>, value: T): void;
	/** The value of the nearest ancestor (or this instance) that set this context. Throws when none did. */
	export function getContext<T>(context: Context<T>): T;
	/** The current location of an app with pages. Read-only and reactive. */
	export interface Page {
		/** The current URL, query and hash included. */
		readonly url: URL;
		/** The decoded [param] segments of the current route. */
		readonly params: Readonly<Record<string, string>>;
		/** The route: its id, as the directories under src/pages (/issues/[id]), or null on the not-found page. */
		readonly route: { readonly id: string | null };
	}
	export const page: Page;
	/** Navigates to a URL of this app without reloading, adding a history entry. */
	export function goto(url: string | URL): void;
}
