# PAT

A single-file reactive UI language (`.pat`) with a deliberately small visual
model. The same app can run in the browser or be rendered into
[Runic](../runic.design) at any concrete state.

```sh
bun install
bun link                                           # installs the `patch` command (~/.bun/bin/patch)

patch dev examples/tasks.pat                       # Vite dev server on http://localhost:5173
patch build examples/tasks.pat                     # → examples/tasks.html (standalone, imports bundled)
patch runic examples/tasks.pat                     # copy to the clipboard, then paste in Runic
patch runic examples/tasks.pat \
  --state filter='"done"' --state loading=true     # paste a specific design-time state
patch runic examples/tasks.pat --stdout            # print the clipboard payload instead
patch runic examples/tasks.pat --output out.html   # write_html-ready Runic nodes (or .json)
patch lsp                                          # language server over stdio
```

Without linking, `bun index.ts <command>` does the same. `patch` is also the
name of the standard Unix tool: anything that is not one of the commands above
(`patch -p1 < fix.diff`, `patch --version`) is passed through to `/usr/bin/patch`.

`<script lang="ts">` may import npm packages and local `.ts`/`.js`/`.mjs`
modules (Vite resolves them in `dev` and bundles them in `build`). Importing
`.pat` files is not supported yet. The script is type-checked with TypeScript
(using the nearest `tsconfig.json`); type errors appear in the editor and the
dev overlay, and fail `build` and `runic`.

`compile` is kept as an alias for `build`.

- `compiler.ts`: parsing, validation (`analyze()`), style completion (`complete()`), code generation (`compile()`), design-time `evaluate()`
- `typecheck.ts`: TypeScript Language Service over the script (rune declarations, diagnostics in .pat offsets)
- `runtime.ts`: reactive core, DOM mounting, style model (the one style schema validation and completion share), concrete evaluation
- `runic-adapter.ts`: concrete tree → Runic nodes (Runic's `createNode`, `NodeSchema`) and Runic's native clipboard payload
- `vite-plugin.ts`: Vite plugin for `dev` (server, full-page reload, error overlay) and `build` (one bundled HTML file)
- `lsp.ts`: publishes `analyze()` diagnostics (PAT and TypeScript) and `complete()` style completions for open `.pat` documents
- `index.ts`: CLI
- `editors/vscode/`: development VS Code extension (language registration, highlighting, LSP client)

`patch runic` writes what copying nodes inside Runic writes: plain text holding a
JSON array of Runic nodes (`pbcopy` on macOS, `wl-copy`/`xclip` on Linux).

The Runic adapter imports `../runic.design/packages/types` directly, so the
`runic` command expects a checkout of runic.design (with installed dependencies)
next to this repo.

## Editor

Install the extension (highlighting and diagnostics for `.pat` files):

```sh
bun link                                   # the extension starts `patch lsp`
cd editors/vscode && bun install && bun run package
cursor --install-extension pat.vsix        # or: code --install-extension pat.vsix
```

Rebuild and reinstall the `.vsix` only when files in `editors/vscode/` change;
compiler and language server changes in the repo are picked up on the next
editor restart because the extension runs the linked `patch` command.

The extension runs bun from `~/.bun/bin/bun` (else `bun` on PATH). Override with
the `patch.bun` and `patch.entry` settings. For extension development, run the
"PAT extension" launch configuration (F5), which uses this repo's `index.ts`
directly.
