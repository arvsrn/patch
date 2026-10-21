# PAT

A single-file reactive UI language (`.pat`) with a deliberately small visual
model. The same app can run in the browser or be rendered into
[Runic](../runic.design) at any concrete state.

```sh
bun install
bun index.ts compile examples/tasks.pat                 # → examples/tasks.html
bun index.ts runic examples/tasks.pat                   # → examples/tasks.runic.json
bun index.ts runic examples/tasks.pat out.html \
  --state filter='"done"' --state loading=true          # write_html-ready Runic nodes
bun index.ts lsp                                        # language server over stdio
```

- `compiler.ts`: parsing, validation (`analyze()`), code generation (`compile()`), design-time `evaluate()`
- `runtime.ts`: reactive core, DOM mounting, style model, concrete evaluation
- `runic-adapter.ts`: concrete tree → Runic nodes (Runic's `createNode`, `NodeSchema`)
- `lsp.ts`: publishes `analyze()` diagnostics for open `.pat` documents
- `index.ts`: CLI
- `editors/vscode/`: development VS Code extension (language registration, highlighting, LSP client)

The Runic adapter imports `../runic.design/packages/types` directly, so the
`runic` command expects a checkout of runic.design (with installed dependencies)
next to this repo.

## Editor

```sh
cd editors/vscode && bun install
```

Then run the "PAT extension" launch configuration from this folder in VS Code
(F5), or:

```sh
code --extensionDevelopmentPath="$PWD/editors/vscode" examples/invalid.pat
```

The extension runs `bun index.ts lsp` from this repository. If `bun` is not on
the editor's PATH, set `pat.bun` to its absolute path.
