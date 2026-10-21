# The Patch language

This is the reference for Patch as currently implemented. A Patch app is one `.pat` file. It contains an optional `<script>` and a template. The template is built from a small set of elements and styled only through `style={...}`.

```svelte
<script lang="ts">
	let count = $state(0);
	let doubled = $derived(count * 2);

	const button = $style({ padding: [8, 12], borderRadius: 6, background: '#18181b', color: '#ffffff' });
</script>

<main style={{ width: 'fill', height: 'fill', padding: 24, gap: 12 }}>
	<p>{count} × 2 = {doubled}</p>
	<button style={button} onclick={() => count++}>Increment</button>
</main>
```

## File structure

- A file has **at most one** `<script>` (or `<script lang="ts">`). Everything outside the script is the template.
- With `lang="ts"` the script is TypeScript and gets type-checked. Without `lang`, or with `lang="js"`, it is JavaScript. Any other `lang` value is treated as JavaScript.
- The template may have any number of top-level nodes. They are stacked in a column inside the viewport (see [The root](#the-root)).
- HTML comments (`<!-- -->`) are ignored.
- Not allowed: `<style>`, `<script module>`, `<svelte:options>`, and any other `<svelte:*>` element.

## Script

The script runs **once** when the app starts, top to bottom, before the template is rendered. Every top-level binding (variables, functions, classes, imports) is visible in the template.

### Supported JS/TS

Standard JS and TS work: functions, classes, closures, `async` functions, `try`/`catch`, type aliases, interfaces, generics, `as` / `satisfies` / `!`.

| Not allowed | Diagnostic or behavior |
| --- | --- |
| `export` of any kind | error: a `.pat` file has no props |
| TS `enum` and `namespace` | error |
| dynamic `import()` | error |
| `import x = require(...)` | error |
| top-level `await` | compilation fails with a parse error and no Patch diagnostic |
| undeclared identifiers starting with `$` (`$props`, `$state.raw`, `$inspect`, `$store`, …) | error |
| references to identifiers starting with `$$` | error (reserved) |

**Visual escape hatches** are rejected wherever they appear in the script or in template expressions:

- Accessing a property with one of these names, on **any** object: `querySelector`, `querySelectorAll`, `getElementById`, `getElementsByClassName`, `getElementsByTagName`, `getElementsByName`, `createElement`, `createElementNS`, `createTextNode`, `createDocumentFragment`, `appendChild`, `insertBefore`, `removeChild`, `replaceChild`, `replaceChildren`, `replaceWith`, `insertAdjacentHTML`, `insertAdjacentElement`, `insertAdjacentText`, `innerHTML`, `outerHTML`, `innerText`, `textContent`, `setProperty`, `cssText`, `classList`, `className`, `attachShadow`, `getComputedStyle`, `getBoundingClientRect`, `adoptedStyleSheets`, `styleSheets`.
- `document.body`, `document.documentElement`, `document.head`, `document.write`, `document.writeln`.
- The global `getComputedStyle`.
- Assigning through `.style`, for example `el.style.color = …`.

Other browser APIs (`fetch`, `localStorage`, `setTimeout`, `document.title`, `window`) are allowed.

### Imports

```ts
import { format } from 'date-fns';          // npm package (ESM or CommonJS)
import { load, type Task } from './api.ts'; // local ES module (.ts, .js, .mjs)
```

- Imports must be static ES imports. They are resolved relative to the `.pat` file.
- Type-only imports are removed from the output.
- You cannot import `.pat` files. An app is one file.
- You cannot import local CommonJS files (`.cjs`, `.cts`). CommonJS npm packages work.

### TypeScript checking

With `lang="ts"`, the script is checked against the nearest `tsconfig.json`. If there is none, `strict` is used. DOM types are always available. Unused locals and parameters are not reported. The runes are typed as:

```ts
declare function $state<T>(initial: T): T;
declare function $state<T>(): T | undefined;
declare function $derived<T>(value: T): T;
declare namespace $derived { function by<T>(fn: () => T): T; }
declare function $effect(fn: () => void | (() => void)): void;
declare function $style(style: { readonly [property: string]: unknown }): PatStyle; // opaque
```

Type errors fail `patch build` and `patch snapshot`. `patch dev` shows them in the browser overlay.

**Only the script is type-checked.** Template expressions are not, so a misspelled name in the template compiles and throws at runtime. With `lang="ts"`, template expressions may use TS syntax such as `name as Filter`. Without it, TS syntax in the template is a parse error.

### Where the script runs

| Command | Environment |
| --- | --- |
| `patch dev`, `patch build`, `patch snapshot html` | browser |
| `patch snapshot figma` | Bun, with no DOM or browser globals |

Top-level code that touches browser globals, such as `localStorage.getItem(...)` outside an `$effect`, works in the browser but makes `patch snapshot figma` fail. Put browser-only work in `$effect`, because effects never run in snapshots.

## Reactivity

### `$state`

```ts
let count = $state(0);
let tasks: Task[] = $state([]);
let selected: number | null = $state(null);
let draft = $state(); // undefined
```

- Declare state only as a top-level `let x = $state(...)`. Using `const`, declaring it inside a function or block, or destructuring (`let [a] = $state(...)`) is an error.
- The variable name is the state's id for [design-time overrides](#design-time-state-and-snapshots).
- Reading gives the current value. Closures always read the current value.
- Writing works through `=`, compound assignment (`+=`, …), `++`/`--`, and array-destructuring assignment (`[a, b] = [b, a]`). Object-destructuring assignment into a state variable (`({ a } = obj)`) is not supported.
- Assigning a value that is `Object.is`-equal to the current one does nothing. For example, `tasks = tasks` does not update anything.

**Mutation.** An assignment through a member whose chain starts at a state variable notifies every reader of that variable:

```ts
user.name = 'Ada';      // tracked
todos[0].done = true;   // tracked: everything that reads `todos` re-evaluates
counts[key]++;          // tracked
```

Tracking applies to the whole variable, not to individual paths. Other in-place changes are **not tracked** and do not update the UI:

```ts
tasks.push(t);              // compile error (also pop, shift, unshift, splice, sort, reverse, fill, copyWithin)
data.items.sort();          // compile error: the chain starts at a state variable
const list = tasks; list.push(t); // not caught, not tracked
delete user.name;           // not tracked
Object.assign(user, patch); // not tracked
map.set(k, v);              // not tracked (Map/Set methods)
```

Prefer assigning new values: `tasks = [...tasks, t]`.

> **Keyed lists and mutation:** an in-place member write such as `todos[0].done = true` does **not** update content rendered from that item inside `{#each todos as todo (todo.id)}`. The same applies to lists derived from `todos`. Use immutable updates for list items: `todos = todos.map((t) => (t.id === id ? { ...t, done: true } : t))`. See [Open questions](#open-questions).

### `$derived`

```ts
let remaining = $derived(tasks.filter((t) => !t.done).length);
const label = $derived.by(() => {
	if (remaining === 0) return 'All done';
	return `${remaining} left`;
});
```

- Declare derived values only at the top level, with `let` or `const`, assigned to a plain identifier. `$derived` takes exactly one expression. `$derived.by` takes exactly one function.
- A derived value is read-only. You cannot assign to it or write through its members.
- It is lazy and cached. It is recomputed on the next read after any `$state` or `$derived` it read changes.

### `$effect`

```ts
$effect(() => {
	localStorage.setItem('tasks', JSON.stringify(tasks));
	document.title = `${remaining} left`;
});

$effect(() => {
	const id = setInterval(tick, 1000);
	return () => clearInterval(id); // cleanup
});
```

- Use `$effect(fn)` only as a top-level expression statement. It takes exactly one function.
- Effects first run **after the initial render**, in declaration order.
- An effect re-runs whenever a `$state` or `$derived` that it read during its last run changes. Dependencies are collected only while `fn` runs synchronously. Reads after an `await` are not tracked.
- If `fn` returns a function, that function runs before the next run. Cleanup code that reads state sees the **current** values, not the values from the run being cleaned up.
- Effects may write state. An effect that writes state it also reads triggers itself again. After 1000 such rounds the runtime throws `Reactive loop`.
- An error thrown inside an effect is logged with `console.error`, and the other effects still run.
- In TS, async effect functions are a type error. In JS they are accepted, and the returned promise is ignored.
- **Effects never run in snapshots** (`figma` or `html`). This includes interactions inside an HTML snapshot.

### Batching

Writes made synchronously inside an event handler are batched. Effects and DOM updates run once, after the handler returns. Writes made after an `await` are not batched: each write updates immediately.

```ts
function twice() { n++; n++; }                         // effects re-run once
async function later() { await x; n++; n++; }          // effects re-run twice
```

## Template

### Elements

| Tag | Kind | Children |
| --- | --- | --- |
| `<main>`, `<div>`, `<button>` | container | elements, text, blocks |
| `<p>`, `<span>` | text | text, `{expressions}`, nested `<span>` |
| `<input>`, `<textarea>` | input | none |

Any other tag (`<img>`, `<section>`, `<h1>`, `<a>`, components, …) is an error.

- **Containers** are flex boxes, laid out in a column by default. `<main>`, `<div>`, and `<button>` lay out identically. `<button>` additionally shows a pointer cursor and accepts `disabled`.
- **Text elements** contain only inline content. A `<span>` nested inside text is an *inline span*: it accepts only `style=`, and that style may contain typography only. You cannot put blocks (`{#if}`, `{#each}`) or other elements inside text. Use a ternary or move the block into a `<div>`.
- **Inputs** cannot have children. Set their content with `value={...}`.

A `<span>` whose parent is a container is a text **block**, not inline:

```svelte
<div>Count: <span>{n}</span></div>  <!-- two stacked blocks: "Count:" and "{n}" -->
<p>Count: <span style={{ fontWeight: 700 }}>{n}</span></p>  <!-- one line -->
```

### Text and whitespace

- Bare text (with `{expressions}`) directly inside a container becomes an unstyled text block. It hugs its content and inherits typography.
- Static whitespace collapses to a single space and is trimmed at the start and end of each text run, including across nested spans. Whitespace between elements is dropped.
- Values of `{expressions}` are inserted verbatim. Spaces and `\n` in them are kept.
- `null`, `undefined`, and `false` render as nothing. Any other value is converted with `String(value)`, so `0` renders as `"0"` and `true` renders as `"true"`.

### Expressions

`{expr}` accepts any JS expression. In expressions you can read top-level script bindings, globals, and `{#each}` item and index names. Expressions re-evaluate when the state they read changes.

### Attributes

Elements accept only these attributes, plus `style=` and event handlers (`on…`):

| Element | Attributes |
| --- | --- |
| `<button>` | `disabled` |
| `<input>` | `value`, `placeholder`, `disabled`, `type` |
| `<textarea>` | `value`, `placeholder`, `disabled` |
| everything else | none |

You can write an attribute value in these forms:

```svelte
<button disabled>…</button>                 <!-- true -->
<button disabled={!draft.trim()}>…</button> <!-- expression -->
<input placeholder="Search {count} items" /> <!-- interpolated string: each part is String(v ?? "") -->
```

- `disabled` is applied as `!!value`, so `disabled="false"` disables the element.
- `type` must be a static string: `text`, `password`, `email`, `search`, `url`, or `tel`. The default is `text`.
- `value` sets the field's current value. It is one-way: typing changes the field but not your state. The field is reset only when the expression's value changes.
- Not allowed: `class`, `id`, `title`, `aria-*`, any other attribute, spread attributes (`{...props}`), `class:`, `style:`, `on:event`, `use:`, `transition:`, `animate:`, and `{@attach}`.

### `{#if}`

```svelte
{#if loading}
	<p>Loading…</p>
{:else if error}
	<p style={{ color: '#dc2626' }}>{error}</p>
{:else}
	<p>Ready</p>
{/if}
```

The first branch whose test is truthy is rendered. When the selected branch changes, the old branch's content is destroyed and the new branch's content is created. Re-evaluating to the same branch keeps the existing content.

### `{#each}`

```svelte
{#each tasks as task (task.id)}
	<p>{task.title}</p>
{/each}

{#each tasks as task, i (task.id)}
	<p>{i + 1}. {task.title}</p>
{/each}
```

- A key is **required**: `(expr)` after the item name. The key can be any expression, and it may use the item and the index.
- The item must be a plain identifier. Destructuring (`as { id, title }`) is not supported.
- The list must be an array. `null` and `undefined` render nothing. Anything else, including Sets, Maps, and other iterables, is a runtime error.
- Keys are compared by `SameValueZero`. Object keys compare by identity. A duplicate key is a runtime error.
- An item whose key is still present keeps its rendered content and is moved into the new order. Its item value updates when the new element is a different value (`Object.is`), and its index updates too. Items whose keys disappear are destroyed. New keys are created.
- The item and index are read-only. You cannot assign to them or mutate through them, for example with `task.done = true`. Update the source array instead.
- `{:else}` inside `{#each}` is not supported. Use `{#if list.length === 0}`.

### Other blocks and tags

These are not supported: `{#await}`, `{#key}`, `{#snippet}`, `{@render}`, `{@html}`, `{@const}`, `{@debug}`, and `{@attach}`.

## Events and `bind:value`

```svelte
<button onclick={() => count++}>+</button>
<input
	style={{ width: 'fill' }}
	value={draft}
	oninput={(e: Event) => (draft = (e.currentTarget as HTMLInputElement).value)}
	onkeydown={(e: KeyboardEvent) => e.key === 'Enter' && add(draft)}
/>
```

- Use `on<name>={handler}` on any element except an inline span. `<name>` must be lowercase (`onclick`, not `onClick`). It is used directly as a DOM event name, so any DOM event works: `onclick`, `oninput`, `onkeydown`, `onfocus`, `onpointerenter`, and so on.
- The handler expression is evaluated **each time the event fires**. It must produce a function, which receives the DOM `Event`, or `null`/`undefined`, which is ignored. Any other value is a runtime error. This means `onclick={enabled ? save : null}` works.
- State writes in the synchronous part of a handler are [batched](#batching).

`bind:value` keeps an input and a state variable in sync:

```svelte
<script lang="ts">
	let query = $state('');
</script>
<input style={{ width: 240 }} bind:value={query} placeholder="Search" />
```

- `bind:value` is allowed only on `<input>` and `<textarea>`. Its target must be a **top-level `$state` identifier**. A derived value, a member (`form.name`), or an each item is not allowed.
- It is equivalent to `value={query}` plus an `input` handler that sets `query = event.currentTarget.value`. The bound value is always a string.
- You cannot combine it with `value=` or `oninput=` on the same element.
- No other bindings exist (`bind:checked`, `bind:this`, …).

## Styles

Styles are attached to elements only through `style={...}`. There are no classes, selectors, stylesheets, or cascade. The only exception is that [typography inherits](#typography-and-inheritance).

### Inline styles

```svelte
<div style={{ width: 'fill', padding: 12, gap: 8, background: '#fafafa' }}>…</div>
```

An object literal written in `style=` is compiled exactly like `$style({...})`.

### `$style(...)`

```ts
const card = $style({ width: 480, padding: 24, gap: 16, background: '#ffffff', borderRadius: 16 });
```

`$style` takes exactly one object. It validates the object, expands shorthands, and returns a frozen style value. Treat that value as opaque: compose it, don't read it. In TS its type is `PatStyle`, whose properties are all `unknown`. You can call `$style` anywhere, including in functions and template expressions:

```ts
const tone = (c: string) => $style({ color: c });
```

### Composition and merging

A style value can be:

- an object or `$style` value
- an array of style values, which may be nested
- a falsy value (`false`, `null`, `undefined`, `0`), which is skipped

```svelte
<button style={[button, ghost, filter === name && selected, { padding: [4, 8] }]}>…</button>
```

The merge rules are:

1. Entries merge **left to right**, and later entries win.
2. Each object is normalized before merging. `padding` and `margin` expand to their four longhands, so precedence applies **per side**:
   ```ts
   [{ padding: 8 }, { paddingLeft: 0 }]  // 8 8 8 0
   [{ paddingLeft: 0 }, { padding: 8 }]  // 8 8 8 8
   ```
3. `borderRadius` and `shadow` are replaced as a whole.
4. A property whose value is `null` or `undefined` is ignored. It does **not** unset an earlier value. To override something, set an explicit neutral value: `width: 'hug'`, `gap: 0`, `borderWidth: 0`, `shadow: []`, `opacity: 1`, or `background: '#0000'`.
5. [Combination rules](#combination-rules) are checked on the **merged** result, so `[row, { justifyContent: 'space-between', gap: 0 }]` is valid even if `row` sets a gap.

Strings are never styles. A string or template literal in a style position is a compile error, and that includes `''`. For example, `cond ? card : ''` fails. Use `false` or `null` instead.

### When styles are validated

The compiler checks property names, and values written as literals, in these places:

- object literals in `style=`, including inside arrays, `&&`, `||`, `??`, and ternaries, checked for that element's kind
- `$style({...})` calls, checked on their own (any property allowed)
- identifiers that refer to a top-level `const x = $style({...})`, checked for each element that uses them

Every other case is validated **only at runtime**, with the same rules: non-literal values, computed keys, spread entries, styles returned from functions, styles reached through members or variables holding arrays, `let` styles, and plain objects that are not `$style`. The [combination rules](#combination-rules) are always checked at runtime.

What a runtime style error does:

- **On first render:** rendering stops at that element. Content before it remains, and the element and everything after it are missing. Effects still run. In snapshots, the snapshot fails.
- **On update:** the error is logged to the console, and the element keeps its previous style.

## Style properties

Units are pixels. All numbers must be finite.

| Notation | Meaning |
| --- | --- |
| *px* | number ≥ 0 |
| *num* | any number (negatives allowed) |
| *color* | `#rgb`, `#rgba`, `#rrggbb`, or `#rrggbbaa` (any case). No named colors, `rgb()`, `transparent`, gradients, or images |
| *size* | *px*, `'hug'`, or `'fill'` |

### Layout (containers only)

| Property | Values | Default |
| --- | --- | --- |
| `display` | `'flex'` (has no effect: every container is flex) | `'flex'` |
| `flexDirection` | `'row'`, `'column'` | `'column'` |
| `justifyContent` | `'start'`, `'center'`, `'end'`, `'space-between'` | `'start'` |
| `alignItems` | `'start'`, `'center'`, `'end'` (no `'stretch'`: use `'fill'`) | `'start'` |
| `flexWrap` | `'wrap'`, `'nowrap'` | `'nowrap'` |
| `gap` | *px* | `0` |
| `overflow` | `'visible'`, `'hidden'` | `'visible'` |

### Box (containers, text, inputs)

| Property | Values | Default |
| --- | --- | --- |
| `width`, `height` | *size* | `'hug'` |
| `minWidth`, `maxWidth`, `minHeight`, `maxHeight` | *px* | none |
| `margin` | *num* or `'auto'`; or `[vertical, horizontal]`; or `[top, right, bottom, left]` | `0` |
| `marginTop`, `marginRight`, `marginBottom`, `marginLeft` | *num* or `'auto'` | `0` |
| `alignSelf` | `'start'`, `'center'`, `'end'` | parent's `alignItems` |
| `position` | `'flow'`, `'absolute'` | `'flow'` |
| `left`, `top` | *num* | none |
| `opacity` | number from 0 to 1 | `1` |

### Paint (containers, inputs)

| Property | Values | Default |
| --- | --- | --- |
| `padding` | *px*; or `[vertical, horizontal]`; or `[top, right, bottom, left]` | `0` |
| `paddingTop`, `paddingRight`, `paddingBottom`, `paddingLeft` | *px* | `0` |
| `background` | *color* | none |
| `borderWidth` | *px* | `0` |
| `borderColor` | *color* | `'#000000'` |
| `borderRadius` | *px*, or `[topLeft, topRight, bottomRight, bottomLeft]` | `0` |
| `shadow` | `{ x?, y?, blur?, spread?, color? }` or an array of them | none |

A shadow's `x`, `y`, and `spread` are *num*, `blur` is *px*, and `color` is *color*. Missing fields default to `0, 0, 0, 0, '#00000040'`. Other keys (such as `inset`) are rejected. Shadows are outer drop shadows, and an array draws several.

### Typography (all elements, inherited)

| Property | Values | Default |
| --- | --- | --- |
| `color` | *color* | `'#000000'` |
| `fontFamily` | non-empty string, a single family name | `'Inter'` |
| `fontSize` | *px* > 0 | `16` |
| `fontWeight` | integer from 1 to 1000 | `400` |
| `fontStyle` | `'normal'`, `'italic'` | `'normal'` |
| `lineHeight` | *px* > 0 (pixels, **not** a multiplier: `1.5` means 1.5px) | 1.2 × `fontSize` |
| `letterSpacing` | *num* | `0` |
| `textAlign` | `'start'`, `'center'`, `'end'` (not allowed on inline spans) | `'start'` |

Any property not listed here is an error. That includes `zIndex`, `right`, `bottom`, `flex`, `flexGrow`, `border`, `fontWeight: 'bold'`, string units like `'4px'`, and percentages like `'100%'`.

### Allowed properties by element

| Element | Layout | Box | Paint | Typography |
| --- | --- | --- | --- | --- |
| `<main>`, `<div>`, `<button>` | ✓ | ✓ | ✓ | ✓ |
| `<input>`, `<textarea>` | | ✓ | ✓ | ✓ |
| `<p>`, `<span>` (block) | | ✓ | | ✓ |
| inline `<span>` inside text | | | | ✓ except `textAlign` |

For example, a `<p>` cannot have `padding`, `background`, a border, a radius, or a shadow. Wrap it in a `<div>` for those.

### Combination rules

These are checked on the merged style, **at runtime only**:

- `justifyContent: 'space-between'` cannot be combined with a non-zero `gap`, or with `flexWrap: 'wrap'`.
- `left` and `top` require `position: 'absolute'`.
- An absolute element cannot use `'fill'` for `width` or `height`.
- `<input>` needs `width` set to a number or `'fill'`. `<textarea>` needs both `width` and `height` set to a number or `'fill'`. A bare `<input />` compiles but fails when rendered.

## Layout

Every container is a flex box. Children follow source order along the main axis (`flexDirection`) and are separated by `gap`. On the cross axis they are placed by `alignItems`, which a child can override with `alignSelf`. Children never shrink or grow unless they are sized `'fill'`. The exception is noted under `hug` below.

### Sizing

Each axis of each element is sized one of three ways:

- **Fixed** (a number): exactly that many pixels. Padding is included, so `width: 100, padding: 10` leaves 80 for content.
- **`hug`** (the default): the size of the content plus padding.
  - Text that hugs its width stays on one line and never wraps. It breaks only at `\n` characters in expression values. If the parent is too narrow, it overflows.
  - In the browser, a container that hugs its width inside a **row** may shrink below its content when the row runs out of space. See [Open questions](#open-questions).
- **`fill`**:
  - On the parent's **main axis**: the element takes an equal share of the space left after fixed and hugging siblings and gaps.
  - On the parent's **cross axis**: the element stretches to the parent's inner size. This overrides `alignSelf` and `alignItems` for that axis.
  - Text with `width` set to `'fill'` or a number wraps at spaces.

`min*` and `max*` clamp the result of all three modes, `fill` included. Clamping can make an element overflow its parent.

When the parent hugs the axis that its child fills:

- **Cross axis:** the child stretches to the largest sibling. An only child gets its content size.
- **Main axis:** the result is not well-defined. Avoid it. See [Open questions](#open-questions).

```svelte
<div style={{ flexDirection: 'row', width: 'fill', gap: 8, alignItems: 'center' }}>
	<input style={{ width: 'fill' }} bind:value={draft} />  <!-- takes the remaining width -->
	<button style={button}>Add</button>                      <!-- hugs -->
</div>
```

### Spacing, borders, and clipping

- `padding` insets the content. `gap` separates flow children.
- `justifyContent: 'space-between'` spreads children across the main axis.
- `flexWrap: 'wrap'` wraps children onto new lines, which are separated by the same `gap`.
- Margins act like flex-item margins. An `'auto'` margin absorbs free space, so `margin: [0, 'auto']` centers an element on a row's main axis. Negative margins are allowed.
- **Borders do not affect layout.** A border is drawn inside the element's box, on top of the padding area, on all four sides, as a solid line. Setting `borderColor` without `borderWidth` draws nothing.
- `borderRadius` rounds the corners of the background, border, and shadow. `overflow: 'hidden'` clips children to the box, including its radius. Inputs always clip.
- `opacity` applies to the element together with its contents.
- Paint order follows source order: later siblings paint above earlier ones. There is no `zIndex`.

### Absolute positioning

```svelte
<div style={{ width: 200, height: 120 }}>
	<div style={{ position: 'absolute', left: 8, top: 8, width: 24, height: 24, background: '#ef4444' }}></div>
</div>
```

- An absolute element leaves the flow. It does not affect its siblings or its parent's hug size.
- `left` and `top` are measured from the parent's outer top-left corner, ignoring the parent's padding. An omitted side keeps the position the element would have as the parent's only flow child.
- Absolute elements are positioned relative to their direct parent. `right`, `bottom`, and `fill` sizing are not available.

### The root

Top-level nodes are laid out as a column inside a viewport-sized host:

- **In the browser**, the host is the full window. It has a white background and scrolls when content overflows.
- **In a Figma snapshot**, the host is a clipped 1280 × 800 frame.

`width: 'fill'` and `height: 'fill'` at the top level fill the viewport.

## Typography and inheritance

The typography properties (`color`, `fontFamily`, `fontSize`, `fontWeight`, `fontStyle`, `lineHeight`, `letterSpacing`, `textAlign`) inherit from parent to child through every element kind, including inputs and inline spans. No other property inherits.

```svelte
<div style={{ color: '#71717a', fontSize: 14 }}>
	<p>Inherits gray, 14px</p>
	<p>Mixed <span style={{ fontWeight: 600, color: '#18181b' }}>emphasis</span> inside one line</p>
</div>
```

- The root defaults are Inter, 16px, weight 400, normal style, line height 1.2 × font size, letter spacing 0, color `#000000`, and `start` alignment.
- An explicit `lineHeight` is inherited as a fixed pixel value.
- Input placeholders use the current text color at 50% opacity.
- Browser outputs load Inter from Google Fonts, which needs network access. Any other `fontFamily` must be installed on the machine that views the app. Figma snapshots measure text with locally installed font files, and fall back to a substitute font with a warning.

## Design-time state and snapshots

```sh
patch dev app.pat                       # browser, live reload; effects run
patch build app.pat [out.html]          # standalone HTML; effects run
patch snapshot html app.pat [out.html] [--state name=value]...
patch snapshot figma app.pat [--state name=value]...
```

A snapshot renders the app from its **initial state**, with optional overrides, and **never runs `$effect`s**.

### State overrides

`--state name=value` replaces the initial value of a top-level `$state` named `name`:

- Only `$state` variables can be overridden. A `$derived` cannot, and it is computed from the overridden state.
- Unknown names are errors, and the error lists the available names.
- The value is parsed as JSON. If parsing fails, it is used as a plain string.
- In a `lang="ts"` script, each candidate is checked against the variable's **declared** type: the JSON reading first, then the raw string. The first one that fits is used. If none fits, the type error is reported.
  ```sh
  --state filter=done                       # "done"  (not valid JSON)
  --state count=3                           # 3
  --state label=123                         # "123" when `label` is a string
  --state 'label="quoted"'                  # "quoted"
  --state 'tasks=[{"id":1,"done":true}]'    # an array
  --state selected=null                     # null, if the type allows it
  ```
- In a JS script, the value is used as JSON if it parses, and as a string otherwise, without any checking.
- The initializer expression still runs, so its side effects happen, but its value is discarded.

### Snapshot targets

| | `snapshot html` | `snapshot figma` |
| --- | --- | --- |
| Output | one standalone HTML file (default `<name>.snapshot.html`) | editable layers copied to the clipboard |
| Runs in | the browser | Bun (no DOM) |
| Interactive | yes: handlers run and state updates | no |
| `$effect` | never runs, even after interaction | never runs |
| Inputs | real inputs | frames showing the value (passwords masked as `•`) or the placeholder at 50% opacity |

The Figma target approximates what Figma cannot express, and prints a warning each time:

- wrapping in columns is not applied
- negative margins are dropped
- auto margins on absolute elements are dropped
- a `fill` child of a parent that hugs the same axis is written as `hug`
- a hugging-width text with a set height is given a fixed width

## Unsupported constructs

| Construct | Use instead |
| --- | --- |
| `<style>`, `class=`, `class:`, CSS strings in `style=`, `style:` | `style={{ ... }}`, `$style`, arrays |
| components, imported `.pat` files, `export`, props | one file per app |
| `{#await}` | `$state` plus an `async` function or `$effect` |
| `{:else}` in `{#each}` | `{#if list.length === 0}` |
| unkeyed `{#each}`, destructured items | `{#each list as item (item.id)}` |
| `{#key}`, `{#snippet}`, `{@render}`, `{@html}`, `{@const}`, `{@debug}`, `{@attach}` | none |
| `bind:` other than `bind:value` on inputs | `value=` plus a handler |
| `on:click` / `onClick` | `onclick` |
| transitions, animations, actions (`use:`) | none |
| spread attributes, arbitrary HTML attributes | none |
| `$props`, `$state.raw`, `$bindable`, `$inspect`, stores (`$x`) | none |
| DOM manipulation and measurement | template and `style` |
| CSS grid, `z-index`, `right`/`bottom`, percentages, units, named colors, gradients, images, per-side borders, inset shadows, transforms | none |

## Open questions

These behaviors in the current implementation are inconsistent or unclear. They are documented as they behave today, but they have not been settled.

1. **In-place mutation does not update keyed `{#each}` items.** `todos[0].done = true` notifies `todos`, and the list re-evaluates. But the item value is the same object, so the item's content is not updated. Content outside the `{#each}` that reads `todos` does update. Lists derived from `todos` behave the same way. The mutation rule ("member writes notify every reader") therefore has an exception that the compiler does not report.
2. **Fill along an axis that the parent hugs.**
   - In the browser, a `height: 'fill'` child of a column that hugs its height collapses to 0, and its content overflows.
   - A `width: 'fill'` child of a row that hugs its width gets an engine-computed share instead.
   - Figma snapshots write the child as `hug` (content size) with a warning.

   There is no defined rule.
3. **Hugging containers shrink in browser rows but not in Figma.** The browser lets a hugging container in a row shrink below its content when space runs out. The Figma layout keeps the content size, so the browser and Figma disagree in this case.
4. **Combination rules are runtime-only.** `space-between` with `gap`, `left`/`top` without `absolute`, `absolute` with `fill`, and input/textarea sizing all compile without errors, then fail at render. For example, `<input />` compiles and then aborts rendering.
5. **Element-kind checks only follow direct references.** A `$style` used as an identifier is checked against each element that uses it. The same style returned from a function, stored in a `let`, read from an object member, or held in an array constant is checked only at runtime.
6. **Properties cannot be unset in a merge.** A `null` or `undefined` value is ignored. In most cases a neutral value works around this. But once `left` or `top` is set, `position: 'flow'` cannot be applied later in the array without failing the "left/top require absolute" rule.
7. **A runtime error on first render leaves a partial UI.** Rendering stops at the failing element, and effects still run. After the first render, the same error only logs and keeps the previous style.
8. **Template expressions are not type-checked**, even with `lang="ts"`. Undefined names in the template compile and fail at runtime.
9. **Top-level `await`** has no Patch diagnostic. Compilation fails with a raw parse error.
10. **Side-effect CSS imports** (`import './x.css'`) are not rejected. They are bundled into `build` and HTML snapshot output, which bypasses the no-stylesheet model.
11. **`''` in a style expression is a compile error** ("CSS strings are not supported"), while other falsy values are allowed and skipped.
12. **Text and attribute interpolation differ for `false`.** `{false}` renders as nothing in text, but `"a {false}"` in an attribute renders `"a false"`. Separately, `disabled="false"` disables the element.
13. **Escape-hatch property names are rejected on every object**, not only on DOM objects. For example, `{ textContent: 1 }.textContent` is an error.
14. **HTML snapshots are interactive, but effects stay disabled for their whole lifetime.** An HTML snapshot therefore does not behave like the app after the first interaction.
15. **Script top-level code runs in Bun for Figma snapshots**, so browser globals used outside `$effect` break `snapshot figma` but not `snapshot html`.
16. **Small rune details:** `$state(a, b)` silently ignores extra arguments. Declaring `const $$x` is allowed, but any reference to it is an error.
