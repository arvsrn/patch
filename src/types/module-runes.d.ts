// Appended to every .pat.ts module wherever TypeScript reads one (checking
// it, or a file importing it): module state, shadowing the component rune for
// the whole file (function declarations hoist). Its result is assignable at
// the first level and read-only below it (PatModuleState in runes.d.ts).
// Not a declaration file on its own: as a global it would merge with $state.
declare function $state<T extends object>(initial: T): PatModuleState<T>;
