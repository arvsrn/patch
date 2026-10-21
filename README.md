# PAT

A single-file reactive UI language (`.pat`) with a deliberately small visual
model. The same app can run in the browser or be rendered into
[Runic](../runic.design) at any concrete state.

```sh
bun install
bun index.ts dev examples/tasks.pat                     # Vite dev server on http://localhost:5173
bun index.ts build examples/tasks.pat                   # → examples/tasks.html (standalone, imports bundled)
bun index.ts runic examples/tasks.pat                   # copy to the clipboard, then paste in Runic
bun index.ts runic examples/tasks.pat \
  --state filter='"done"' --state loading=true          # paste a specific design-time state
bun index.ts runic examples/tasks.pat --stdout          # print the clipboard payload instead
bun index.ts runic examples/tasks.pat --output out.html # write_html-ready Runic nodes (or .json)
bun index.ts lsp                                        # language server over stdio
```

`<script lang="ts">` may import npm packages and local `.ts`/`.js`/`.mjs`
modules (Vite resolves them in `dev` and bundles them in `build`). Importing
`.pat` files is not supported yet. The script is type-checked with TypeScript
(using the nearest `tsconfig.json`); type errors appear in the editor and the
dev overlay, and fail `build` and `runic`.

`bun link` exposes the same commands as `pat` (`pat dev app.pat`, …). `compile` is
kept as an alias for `build`.

- `compiler.ts`: parsing, validation (`analyze()`), style completion (`complete()`), code generation (`compile()`), design-time `evaluate()`
- `typecheck.ts`: TypeScript Language Service over the script (rune declarations, diagnostics in .pat offsets)
- `runtime.ts`: reactive core, DOM mounting, style model (the one style schema validation and completion share), concrete evaluation
- `runic-adapter.ts`: concrete tree → Runic nodes (Runic's `createNode`, `NodeSchema`) and Runic's native clipboard payload
- `vite-plugin.ts`: Vite plugin for `dev` (server, full-page reload, error overlay) and `build` (one bundled HTML file)
- `lsp.ts`: publishes `analyze()` diagnostics (PAT and TypeScript) and `complete()` style completions for open `.pat` documents
- `index.ts`: CLI
- `editors/vscode/`: development VS Code extension (language registration, highlighting, LSP client)

`pat runic` writes what copying nodes inside Runic writes: plain text holding a
JSON array of Runic nodes (`pbcopy` on macOS, `wl-copy`/`xclip` on Linux).

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
