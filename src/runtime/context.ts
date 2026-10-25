// The `patch` module: what .ts/.js modules import from 'patch'. Context keys
// are plain objects, so a key made here and one made by a component's
// `createContext` work alike. Providing and reading a context, and the
// location (`page`, `goto`), need a component instance, which only a .pat
// script has (it gets them from `$$rt`).

/** An opaque context key. */
export const createContext = (): object => Object.freeze({});

const outside = (name: string) => () => {
	throw new Error(`${name} can only be used in the <script> of a .pat component`);
};
export const setContext = outside('setContext');
export const getContext = outside('getContext');
export const goto = outside('goto');
export const page = Object.freeze({
	get url() {
		return outside('page')();
	},
	get params() {
		return outside('page')();
	},
	get route() {
		return outside('page')();
	}
});
