// The Runic target: a compiled app, evaluated at one state, as Runic nodes.

import type { Compiled } from '../../compile';
import { toRunic, type RunicResult, type Viewport } from './adapter';
import { evaluate } from './load';

export { copyText, toRunicClipboard, toRunicHtml } from './clipboard';
export { evaluate } from './load';
export type { RunicResult, Viewport } from './adapter';

export type RunicOptions = {
	/** Overrides keyed by state id (see `compiled.state`). */
	state?: Record<string, unknown>;
	viewport?: Viewport;
};

/** Renders one concrete state of a compiled app as a validated Runic node graph. */
export async function renderRunic(compiled: Compiled, options: RunicOptions = {}): Promise<RunicResult> {
	return toRunic(await evaluate(compiled, { state: options.state }), compiled.filename, options.viewport);
}
