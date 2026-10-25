// Public compiler API.

export { analyze, analyzeModule, compile, compileModule, type Analysis, type Compiled, type CompiledModule } from './compile';
export { complete, type Completion } from './complete';
export { CompileError, formatDiagnostic, type Diagnostic } from './diagnostics';
export type { StateInfo } from './ir';
