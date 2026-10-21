# patch

A single-file reactive UI language with Svelte's surface syntax and a deliberately
small visual model. The same app can run in the browser or be rendered into
[Runic](../runic.design) at any concrete state.

```sh
bun install
bun index.ts compile examples/tasks.svelte              # → examples/tasks.html
bun index.ts runic examples/tasks.svelte                # → examples/tasks.runic.json
bun index.ts runic examples/tasks.svelte out.html \
  --state filter='"done"' --state loading=true          # write_html-ready Runic nodes
```

- `compiler.ts`: parse (svelte/compiler), validate, rewrite runes, generate the program, `evaluate()` for design time
- `runtime.ts`: reactive core, DOM mounting, style model, concrete evaluation
- `runic-adapter.ts`: concrete tree → Runic nodes (Runic's `createNode`, `NodeSchema`)
- `index.ts`: CLI

The Runic adapter imports `../runic.design/packages/types` directly, so the
`runic` command expects a checkout of runic.design (with installed dependencies)
next to this repo.
