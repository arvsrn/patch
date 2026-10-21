// Getting Runic nodes out: Runic's clipboard payload, write_html HTML, and
// the system clipboard.

import type { Node } from '@runic/types/nodes';
import type { RunicResult } from './adapter';

/**
 * Runic's native clipboard payload: what copying nodes in Runic writes as
 * `text/plain` (`serialise` in runic.design/packages/core/clipboard.ts), a
 * JSON array of every node in each copied subtree, pre-order. Paste parses it
 * with `NodesSchema`, treats nodes no other node lists as a child as roots, and
 * regenerates every id.
 */
export function toRunicClipboard(result: RunicResult): string {
	const out: Node[] = [];
	const visit = (id: string) => {
		const node = result.nodes[id];
		out.push(node);
		if ('children' in node) node.children.forEach(visit);
	};
	result.rootNodeIds.forEach(visit);
	return JSON.stringify(out);
}

/**
 * The same node graph as HTML for Runic's `write_html` import. Every field
 * travels verbatim in `data-runic`, so nothing is reinterpreted as CSS.
 */
export function toRunicHtml(result: RunicResult): string {
	const attr = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
	const render = (id: string): string => {
		const { id: _id, kind, children, ...fields } = result.nodes[id] as Node & { children?: string[] };
		const inner = (children ?? []).map(render).join('');
		return `<div data-runic-kind="${kind}" data-name="${attr(fields.name)}" data-runic="${attr(JSON.stringify(fields))}">${inner}</div>`;
	};
	return result.rootNodeIds.map(render).join('\n');
}

/** Writes plain text (Runic's only clipboard format) to the system clipboard. */
export async function copyText(text: string) {
	const commands: Record<string, string[][]> = {
		darwin: [['pbcopy']],
		linux: [['wl-copy'], ['xclip', '-selection', 'clipboard']]
	};
	for (const cmd of commands[process.platform] ?? []) {
		if (!Bun.which(cmd[0])) continue;
		// pbcopy decodes its input with the locale's encoding.
		const proc = Bun.spawn(cmd, { stdin: 'pipe', env: { ...process.env, LANG: 'en_US.UTF-8' } });
		proc.stdin.write(text);
		await proc.stdin.end();
		if ((await proc.exited) !== 0) throw new Error(`${cmd[0]} exited with ${proc.exitCode}`);
		return;
	}
	throw new Error(`No clipboard command found for ${process.platform}; use --stdout or --output`);
}
