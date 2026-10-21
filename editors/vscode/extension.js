// Starts `bun index.ts lsp` from this repository for .pat documents.
const path = require('node:path');
const { workspace } = require('vscode');
const { LanguageClient, TransportKind } = require('vscode-languageclient/node');

let client;

exports.activate = () => {
	const server = {
		command: workspace.getConfiguration('pat').get('bun') || 'bun',
		args: [path.join(__dirname, '..', '..', 'index.ts'), 'lsp'],
		transport: TransportKind.stdio
	};
	client = new LanguageClient('pat', 'PAT', { run: server, debug: server }, {
		documentSelector: [{ language: 'pat' }]
	});
	return client.start();
};

exports.deactivate = () => client?.stop();
