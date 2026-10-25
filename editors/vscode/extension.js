// Starts the PAT language server (`patch lsp`) for .pat documents and
// .pat.ts / .pat.js modules, and points the TypeScript plugin
// (ts-plugin/, which VS Code loads into its own TypeScript server) at the
// declarations of the same Patch install (src/types).
//
// Run from the repository, it uses ../../src/cli.ts. Installed from a .vsix, it
// uses the `patch` command that `bun link` puts in ~/.bun/bin. Both are run
// through bun directly because editors launched from the Dock often do not
// have ~/.bun/bin on PATH.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { extensions, window, workspace } = require('vscode');
const { LanguageClient, TransportKind } = require('vscode-languageclient/node');

let client;

const exists = (file) => {
	try {
		fs.accessSync(file);
		return true;
	} catch {
		return false;
	}
};

exports.activate = () => {
	const config = workspace.getConfiguration('patch');
	const bunBin = path.join(os.homedir(), '.bun', 'bin');
	const repoEntry = path.join(__dirname, '..', '..', 'src', 'cli.ts');
	const linked = path.join(bunBin, 'patch');
	const entry =
		config.get('entry') || (exists(repoEntry) ? repoEntry : exists(linked) ? fs.realpathSync(linked) : null);
	if (!entry) {
		window.showErrorMessage('PAT: run `bun link` in the patch repository (or set patch.entry) to enable diagnostics.');
		return;
	}
	const bun = config.get('bun') || (exists(path.join(bunBin, 'bun')) ? path.join(bunBin, 'bun') : 'bun');
	const server = { command: bun, args: [entry, 'lsp'], transport: TransportKind.stdio };
	client = new LanguageClient('pat', 'PAT', { run: server, debug: server }, {
		documentSelector: [{ language: 'pat' }, { scheme: 'file', pattern: '**/*.pat.{ts,js}' }]
	});
	configureTypeScript(path.join(path.dirname(entry), 'types'));
	return client.start();
};

async function configureTypeScript(types) {
	try {
		const extension = extensions.getExtension('vscode.typescript-language-features');
		const api = (await extension?.activate())?.getAPI?.(0);
		api?.configurePlugin('patch-typescript-plugin', { types });
	} catch (error) {
		console.error('PAT: could not configure the TypeScript plugin', error);
	}
}

exports.deactivate = () => client?.stop();
