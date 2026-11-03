// Fine-grained reactivity: cells, lazy derived values, effects, batching.
//
// Effects and derived values are "owners": they track the cells they read and
// re-run when one changes. Owners form a tree; disposing one disposes its
// children and runs their cleanups.
//
// There is one core per realm (`reactive`): every mounted app, design-time
// evaluation and module's `$state` uses it, so an effect of a page tracks a
// cell a module created. What belongs to one app (its owner tree, portals,
// held effects) lives with the app, not here.

type OwnerBase = {
	children: Set<Owner>;
	cleanups: (() => void)[];
	parent: Owner | null;
	disposed: boolean;
};
/** An owner that tracks the cells it reads: `deps` holds the subscriber set of each. */
type Tracking = OwnerBase & { deps: Set<Set<Observer>> };
/** An effect: runs `fn`, in creation order (`id`) with other queued effects. */
type Effect = Tracking & { kind: 'effect'; id: number; fn: () => void };
/** A derived value's computation: `invalidate` marks it dirty when a dependency changes. */
type Computation = Tracking & { kind: 'derived'; invalidate: () => void };
type Observer = Effect | Computation;
/** Owns what is created inside it (a component instance, a block). */
export type Owner = (OwnerBase & { kind: 'owner' }) | Observer;

export type Cell<T = any> = { v: T; notify: () => void };

export type Reactive = ReturnType<typeof createReactive>;

export function createReactive() {
	let owner: Owner | null = null;
	let observer: Observer | null = null;
	let nextId = 0;
	let batchDepth = 0;
	let flushing = false;
	const queue = new Set<Effect>();

	/** An owner below the current one. */
	const adopt = <O extends Owner>(o: O): O => {
		owner?.children.add(o);
		return o;
	};
	const newOwner = (): Owner => adopt({ kind: 'owner', children: new Set(), cleanups: [], parent: owner, disposed: false });
	const newEffect = (fn: () => void): Effect => adopt({ kind: 'effect', id: nextId++, fn, deps: new Set(), children: new Set(), cleanups: [], parent: owner, disposed: false });
	const reset = (o: Owner) => {
		for (const child of [...o.children]) dispose(child);
		for (const cleanup of o.cleanups.splice(0)) cleanup();
		if (o.kind !== 'owner') {
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
	/** Runs `fn` with `o` as the owner of anything it creates and `obs` tracking its reads. */
	const within = <T>(o: Owner | null, obs: Observer | null, fn: () => T): T => {
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
	const track = (subs: Set<Observer>) => {
		if (!observer) return;
		subs.add(observer);
		observer.deps.add(subs);
	};
	const trigger = (subs: Set<Observer>) => {
		batchDepth++;
		try {
			for (const c of [...subs]) c.kind === 'derived' ? c.invalidate() : queue.add(c);
		} finally {
			batchDepth--;
		}
		if (!batchDepth) flush();
	};
	/** One run of an effect. An error is logged and leaves the effect subscribed to what it read, on the first run as on later ones. */
	const run = (c: Effect) => {
		reset(c);
		try {
			within(c, c, c.fn);
		} catch (error) {
			console.error(error);
		}
	};
	const flush = () => {
		if (flushing) return;
		flushing = true;
		let rounds = 0;
		try {
			while (queue.size) {
				if (++rounds > 1000) throw new Error('Reactive loop: effects keep invalidating each other');
				const pending = [...queue].sort((a, b) => a.id - b.id);
				queue.clear();
				for (const c of pending) if (!c.disposed) run(c);
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
	/** Runs `fn` when the current owner is reset or disposed. */
	const onCleanup = (fn: () => void) => owner?.cleanups.push(fn);

	const cell = <T>(initial: T): Cell<T> => {
		const subs = new Set<Observer>();
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

	/**
	 * Lazy and cached; invalidated by its dependencies. Created under an owner
	 * (a component instance, a block), it stops listening when that owner is
	 * reset or disposed, and recomputes if it is read again.
	 */
	const derived = <T>(fn: () => T) => {
		const subs = new Set<Observer>();
		let value: T;
		let dirty = true;
		const c: Computation = {
			kind: 'derived',
			children: new Set(),
			cleanups: [],
			parent: null,
			disposed: false,
			deps: new Set(),
			invalidate: () => {
				if (dirty) return;
				dirty = true;
				trigger(subs);
			}
		};
		onCleanup(() => {
			reset(c);
			dirty = true;
		});
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

	/** Runs now, re-runs when its dependencies change. */
	const effect = (fn: () => void) => {
		const c = newEffect(fn);
		run(c);
		return c;
	};

	/** Like `effect`, but the first run is queued until the current batch ends. A returned function is a cleanup. */
	const deferredEffect = (fn: () => unknown) => {
		const c = newEffect(() => {
			const cleanup = fn();
			if (typeof cleanup === 'function') owner!.cleanups.push(cleanup as () => void);
		});
		queue.add(c);
		if (!batchDepth) flush();
	};

	const currentOwner = () => owner;

	return { newOwner, dispose, within, batch, untrack, onCleanup, currentOwner, cell, derived, effect, deferredEffect };
}

/** The realm's reactive core. */
export const reactive = createReactive();
