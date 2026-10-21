// Validates every statically known style against the element kind it styles:
// property names always, values when they are literals. Dynamic values are
// validated by the runtime with the same schema.

import { literal, NOT_STATIC, propertyName } from '../ast';
import type { Reporter } from '../diagnostics';
import { checkKey, normalizeStyle } from '../schema/style';
import type { Styles } from '../styles';

export function checkStyles(styles: Styles, reporter: Reporter) {
	for (const node of styles.strings) reporter.report(node, 'CSS strings are not supported; use an object or $style({...})');
	for (const { object, kind } of styles.uses) {
		for (const p of object.properties) {
			if (p.type !== 'Property' || p.computed) continue;
			const key = propertyName(p);
			try {
				checkKey(kind, key);
			} catch (error: any) {
				reporter.report(p.key, error.message);
				continue;
			}
			const value = literal(p.value);
			try {
				if (value !== NOT_STATIC) normalizeStyle({ [key]: value });
			} catch (error: any) {
				reporter.report(p.value, error.message);
			}
		}
	}
}
