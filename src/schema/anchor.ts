// Anchored positioning: where an absolute element with `anchor` goes, given
// its anchor's rendered box. Every renderer measures boxes its own way and
// places elements with this one function, so the geometry is the same in the
// browser and in snapshots.

export const ANCHOR_POSITIONS = [
	'top', 'top-start', 'top-end',
	'right', 'right-start', 'right-end',
	'bottom', 'bottom-start', 'bottom-end',
	'left', 'left-start', 'left-end'
];

export type Rect = { x: number; y: number; width: number; height: number };

const OPPOSITE: Record<string, string> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

/**
 * The top-left corner of a `box` placed at `position` around `anchor`
 * (`"bottom-start"`: below it, start edges aligned), `offset` away from it.
 * All coordinates are in one space, the viewport's included.
 *
 * Collisions with the viewport: when the box does not fit on its side, it
 * goes to the opposite side if there is more room there. Along the side, it
 * is aligned as asked, then shifted to stay inside the viewport; a box larger
 * than the viewport keeps its start edge visible.
 */
export function placeAnchored(anchor: Rect, box: { width: number; height: number }, viewport: Rect, position: string, offset: number): { x: number; y: number } {
	const [preferred, align = 'center'] = position.split('-');
	const vertical = preferred === 'top' || preferred === 'bottom';
	const room = (side: string) =>
		side === 'bottom' ? viewport.y + viewport.height - (anchor.y + anchor.height + offset)
		: side === 'top' ? anchor.y - offset - viewport.y
		: side === 'right' ? viewport.x + viewport.width - (anchor.x + anchor.width + offset)
		: anchor.x - offset - viewport.x;
	const need = vertical ? box.height : box.width;
	const opposite = OPPOSITE[preferred];
	const side = room(preferred) >= need || room(preferred) >= room(opposite) ? preferred : opposite;
	const main =
		side === 'bottom' ? anchor.y + anchor.height + offset
		: side === 'top' ? anchor.y - offset - box.height
		: side === 'right' ? anchor.x + anchor.width + offset
		: anchor.x - offset - box.width;

	const [start, size, length, min, extent] = vertical
		? [anchor.x, anchor.width, box.width, viewport.x, viewport.width]
		: [anchor.y, anchor.height, box.height, viewport.y, viewport.height];
	const aligned = align === 'start' ? start : align === 'end' ? start + size - length : start + (size - length) / 2;
	const cross = Math.max(min, Math.min(aligned, min + extent - length));
	return vertical ? { x: cross, y: main } : { x: main, y: cross };
}
