// The Figma target: an evaluated state as editable Figma layers on the clipboard.

import type { Concrete } from '../../schema/concrete';
import { toFigma, type FigmaFrame, type FigmaNode, type FigmaText } from './adapter';
import { encodeFigmaClipboard } from './encode';
import { layout } from './layout';
import { coreTextWidths, measureWith, type WidthOf } from './text';

export { copyFigmaClipboard } from './clipboard';
export { decodeFigmaClipboard } from './encode';

const texts = (n: FigmaNode): FigmaText[] => (n.type === 'TEXT' ? [n] : n.children.flatMap(texts));

/** Concrete tree → laid-out Figma layers. `widthOf` defaults to CoreText measurement. */
export async function toFigmaLayers(tree: Concrete[], name: string, widthOf?: WidthOf): Promise<{ root: FigmaFrame; warnings: string[] }> {
	const { root, warnings } = toFigma(tree, name);
	if (!widthOf) {
		const measured = await coreTextWidths(texts(root));
		widthOf = measured.widthOf;
		warnings.push(...measured.warnings);
	}
	layout(root, measureWith(widthOf));
	return { root, warnings };
}

/** Concrete tree → the HTML Figma pastes as layers. */
export async function snapshotToFigma(tree: Concrete[], name: string, widthOf?: WidthOf) {
	const { root, warnings } = await toFigmaLayers(tree, name, widthOf);
	return { html: encodeFigmaClipboard(root), root, warnings };
}
