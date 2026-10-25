// Packages the extension as pat.vsix, from a staging directory (dist/) that
// holds exactly what the extension runs: extension.js bundled with its
// dependencies, the manifest and grammars, and the TypeScript plugin, which
// VS Code's TypeScript loads by name from node_modules. vsce collects
// node_modules through npm, which only accepts a `file:` dependency as a
// symlink (which vsce cannot pack), so the staged manifest depends on the
// plugin by version; everything else is in the bundle.

import { $ } from 'bun';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const here = import.meta.dir;
const dist = join(here, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, 'node_modules'), { recursive: true });

const bundle = await Bun.build({ entrypoints: [join(here, 'extension.js')], target: 'node', format: 'cjs', external: ['vscode'] });
if (!bundle.success) throw new AggregateError(bundle.logs, 'Could not bundle extension.js');
writeFileSync(join(dist, 'extension.js'), await bundle.outputs[0].text());
for (const file of ['language-configuration.json', 'syntaxes']) cpSync(join(here, file), join(dist, file), { recursive: true });
cpSync(join(here, 'ts-plugin'), join(dist, 'node_modules', 'patch-typescript-plugin'), { recursive: true });

const { scripts, devDependencies, dependencies, ...manifest } = await Bun.file(join(here, 'package.json')).json();
const plugin = await Bun.file(join(here, 'ts-plugin', 'package.json')).json();
writeFileSync(join(dist, 'package.json'), JSON.stringify({ ...manifest, dependencies: { [plugin.name]: plugin.version } }, null, '\t'));

await $`${join(here, 'node_modules/.bin/vsce')} package --allow-missing-repository --skip-license -o ${join(here, 'pat.vsix')}`.cwd(dist);
