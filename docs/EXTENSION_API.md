# Extension API reference

Everything an extension can do, in one place. For *why* the app is split the
way it is — what belongs in core versus an extension — see
[ARCHITECTURE.md](ARCHITECTURE.md). For a worked example that exercises the
basic surfaces with zero build tooling, see
[`examples/hello-extension`](../examples/hello-extension); the bundled
extensions under [`extensions/`](../extensions) are the reference
implementations for every advanced surface (each section below names the one
to read).

- [Anatomy and lifecycle](#anatomy-and-lifecycle)
- [The manifest (`package.json`)](#the-manifest-packagejson)
- [Client API](#client-api)
  - [`activate(ctx)` / `deactivate()`](#activatectx--deactivate)
  - [Commands](#commands--registercommand)
  - [File viewers](#file-viewers--registerfileviewer)
  - [Sidebar panels](#sidebar-panels--registersidebarpanel)
  - [Window actions](#window-actions--registerwindowaction)
  - [File decorations](#file-decorations--registerfiledecorationprovider)
  - [Session decorations](#session-decorations--registersessiondecorationprovider)
  - [Terminal engines](#terminal-engines--registerterminalengine)
  - [Terminal accessories](#terminal-accessories--registerterminalaccessory)
  - [Quick-switcher providers](#quick-switcher-providers--registerquickswitcherprovider)
  - [Settings components](#settings-components--registersettingscomponent)
  - [The `ctx.app` host API](#the-ctxapp-host-api)
  - [`ctx.serverFetch` / `ctx.assetUrl`](#ctxserverfetch--ctxasseturl)
  - [`ctx.settings`](#ctxsettings)
- [Server API](#server-api)
- [Sharing the host runtime](#sharing-the-host-runtime)
- [Building and packaging](#building-and-packaging)
- [Security model](#security-model)

---

## Anatomy and lifecycle

An extension is a folder with a `package.json` manifest, discovered from two
places:

1. **Bundled** — the repo's own `extensions/<folder>/` (shipped with the
   app; shows a *Built-in* badge in Settings).
2. **User-installed** — `~/.config/tmux-server/extensions/<folder>/`
   (`$XDG_CONFIG_HOME` respected), either dropped in directly or unpacked
   from a `.tsix` installed through Settings → Extensions.

A user-installed extension with the same id **always wins** over a bundled
one — that's how you override a built-in preview, and one way to restore a
tombstoned builtin (installing it from the Available section, below, is the
other).

**Extension id** = `<publisher>.<name>` from the manifest (falling back to
the folder name if either is missing or unsafe). Ids are used as URL path
segments (`/api/ext/<id>`, `/api/extensions/<id>/file/*`), so they must
match `[a-zA-Z0-9][a-zA-Z0-9._-]*`.

**State** lives in `~/.config/tmux-server/extensions-state.json`: `true` /
`false` per id for enabled/disabled, or `"uninstalled"` to tombstone a
builtin (its repo files are never deleted). A tombstoned builtin stays
inactive (`enabled: false`, `uninstalled: true` in its `ExtensionInfo`) but
surfaces in the Extensions tab's **Available** section like a normal
installable extension — its **Install** clears the tombstone back to enabled
— rather than vanishing from the list. A *required builtin* (see
[`tmuxServer.required`](#tmuxserver)) ignores this file entirely and can't be
disabled or uninstalled.

**Lifecycle timing:**

- Server hooks mount at server startup (for everything enabled) and on
  enable; they unmount on disable/uninstall. The ES module itself stays
  resident until the server restarts — Node can't unload it — so Settings
  shows a restart hint after disabling one.
- Client entries dynamic-import and `activate()` once per page load, after
  the extension list and settings have loaded. Disable/enable while the page
  is open calls the module's optional `deactivate()` and re-`activate()`s
  live — every `register*` contribution is automatically unregistered on
  deactivation, but anything you created outside the registries (injected
  stylesheets, your own DOM roots, timers, subscriptions) is yours to tear
  down in `deactivate()`.
- Consumers that depend on registrations existing (the terminal-engine
  resolution) wait on an internal *extensions-settled* gate that resolves
  after the first activation pass completes — your `activate()` should do
  its `register*` calls synchronously so contributions are present when the
  gate opens.
- Themes, icon themes, and fonts are **data-only** manifest contributions:
  the host reads them straight from the extension list without running any
  extension code, and they apply without a reload.

---

## The manifest (`package.json`)

A VS Code-shaped manifest. Unknown fields are ignored, and malformed
entries inside `contributes` are skipped individually rather than failing
the whole extension.

```jsonc
{
  "name": "my-extension",          // required for .tsix install; part of the id
  "publisher": "me",               // id becomes "me.my-extension"
  "version": "1.0.0",
  "displayName": "My Extension",   // shown in Settings (falls back to name)
  "description": "One line shown in the extension list.",
  "icon": "./icon.svg",            // extension-relative; served via the file route

  "contributes": {
    "themes": [ ... ],             // color themes
    "iconThemes": [ ... ],         // file-icon themes
    "fonts": [ ... ],              // terminal font groups
    "configuration": { ... }       // settings (object, or an array of them)
  },

  "tmuxServer": {
    "client": "./dist/client.js",  // ESM client entry (omit if none)
    "server": "./server.js",       // ESM server entry (omit if none)
    "required": true               // bundled-only; see below
  }
}
```

### `tmuxServer`

| Field | Meaning |
| --- | --- |
| `client` | Extension-relative path to the browser entry — an ESM module exporting `activate(ctx)` (and optionally `deactivate()`). Dynamic-imported by the host; see [Client API](#client-api). |
| `server` | Extension-relative path to the server entry — an ESM module exporting `activate({ router, log, getSettings, host })`; see [Server API](#server-api). |
| `required` | **Bundled extensions only** (silently ignored on user-installed ones, which could otherwise claim it). Marks the extension as a *required builtin*: the server refuses `disable`/`uninstall`, ignores stale state-file entries for it, and the UI shows a **Required** chip instead of those actions. Reserved for surfaces the app cannot function without — currently only `xterm-engine`, the terminal rendering floor. |

### `contributes.themes`

```jsonc
"themes": [
  { "label": "My Dark", "uiTheme": "vs-dark", "path": "./themes/my-dark.json" }
]
```

VS Code color-theme JSON, resolved relative to the theme file's own
directory (`include` supported). The Settings → UI color-theme dropdown
lists each entry as `<extensionId>:<label>`. Themes drive both the app's
CSS variables and the terminal palette; keys the theme doesn't set keep the
core hard-fallback values. Reference: `extensions/plastic-legacy-theme`.

### `contributes.iconThemes`

```jsonc
"iconThemes": [
  { "id": "my-icons", "label": "My Icons", "path": "./themes/my-icon-theme.json" }
]
```

VS Code file-icon-theme JSON (icon definitions, font glyphs, per-extension/
per-name mappings). `iconPath`/font paths resolve relative to the theme
JSON's own directory. Reference: `extensions/seti-icons`.

### `contributes.fonts`

Not a VS Code concept — tmux-server's own extension of `contributes`, for
terminal fonts:

```jsonc
"fonts": [
  {
    "group": "My Mono",                    // the font picker's unit of selection
    "fonts": [
      {
        "family": "My Mono",
        "src": [{ "path": "./fonts/my-mono-400.woff2", "format": "woff2" }],
        "weight": "400",                   // optional
        "style": "normal",                 // optional
        "unicodeRange": "U+0000-00FF"      // optional; per-script splitting
      }
    ]
  }
]
```

Within a group, entries sharing a `family` register different
weights/styles/unicode-ranges of one font (include a bold face — xterm
renders bold cells with it); entries with distinct families bundle
companion fonts (e.g. a Nerd Font symbols face) that ride along in the
stack when the group is picked. Reference: `extensions/ibm-plex-mono`.

### `contributes.configuration`

VS Code-shaped settings, rendered automatically in the extension's own
Settings section and readable from both entries:

```jsonc
"configuration": {
  "title": "My Extension",
  "properties": {
    "myExt.limit": {
      "type": "integer",                   // boolean | number | integer | string
      "default": 100,
      "minimum": 1,                        // number/integer only
      "maximum": 1000,
      "description": "Shown under the control."
    },
    "myExt.mode": {
      "type": "string",
      "default": "fast",
      "enum": ["fast", "thorough"],
      "enumItemLabels": ["Fast", "Thorough"],       // visible labels
      "enumDescriptions": ["…", "…"]                // option tooltips
    }
  }
}
```

- Property keys are the **full dotted name** — declare your own prefix;
  nothing is prepended.
- Only scalar types render; `array`/`object` properties are dropped. For
  richer config, store a JSON **string** property and edit it with a
  [settings component](#settings-components--registersettingscomponent)
  (that's how `touch-keys` persists its key layout).
- An array of `{ title, properties }` sections is accepted and flattened in
  order.
- Values are server-synced: manifest defaults overridden by the user's
  stored values, shared across the user's devices.

---

## Client API

### `activate(ctx)` / `deactivate()`

`tmuxServer.client` is an ESM module. Without a build step, use
`ctx.React` and `React.createElement`; with one, alias React to the host's
instance instead of bundling a copy (see
[Sharing the host runtime](#sharing-the-host-runtime)).

```js
export function activate(ctx) {
  // synchronous register* calls; stash ctx pieces in module-level
  // variables for your components (the pattern every bundled extension uses)
}

export function deactivate() {
  // optional: remove stylesheets/timers/roots you created yourself;
  // register* contributions are removed for you
}
```

All `register*` ids are auto-namespaced to `ext.<extensionId>.<id>` — write
the short id, and expect the namespaced form anywhere the host reports ids
back (keybindings UI, sidebar state, the engine setting).

The **sync-from-cache + `refresh()`** contract, used by every `provide*`
API below: providers are called synchronously during render and must be
plain lookups — never fetch inside one. Keep your own cache (poll your
server hook, subscribe to events), and call the `{ refresh() }` handle
returned by the registration after the cache changes; the host re-renders
every consumer.

### Commands — `registerCommand`

```ts
ctx.registerCommand({
  id: string,
  label: string,            // palette text, e.g. "Git: Stage All Changes"
  defaultBinding?: string,  // keybindings combo, e.g. "ctrl+alt+KeyH"
  run: () => void,
});
```

Joins the command palette (`Ctrl+Shift+P`) and the Keyboard Shortcuts
settings, where users can rebind it. Combos use the keybindings.ts syntax:
modifiers + `KeyX`/`Digit1`/named keys, e.g. `"ctrl+shift+KeyG"`.

### File viewers — `registerFileViewer`

```ts
ctx.registerFileViewer({
  id: string,
  extensions: string[],       // lowercase, no dot: ["md", "markdown"] — [] = openViewerTab-only
  mode?: "default" | "preview",   // default "default"
  editorFallback?: boolean,       // default true; "default"-mode only
  component: React.ComponentType<FileViewerHostProps>,
});
```

- `"default"`: a FILES-tree click opens this viewer directly (image/media/
  pdf). `"preview"`: a click still opens nvim; the viewer is reached via
  the hover icon, the "Preview" context-menu item, or Shift+Enter
  (markdown/json/csv).
- `editorFallback` controls whether the context menu offers "Open in
  Editor" as an escape hatch from a `"default"`-mode viewer.
- Among same-extension matches, a user-installed viewer beats a bundled
  one; otherwise first registered wins.

```ts
interface FileViewerHostProps {
  filePath: string;
  active: boolean;                       // is this the focused tab
  toolbarTarget?: HTMLDivElement | null; // portal tab-bar controls here
  openInEditor?: (path: string) => void;
  showMenu?: (x: number, y: number, items: MenuItem[]) => void;
  setDirty?: (dirty: boolean) => void;   // closing a dirty tab confirms first
  fontSize?: number;                     // the configured terminal font size, px
}
```

Reference: any of the preview extensions; `git-scm` for `extensions: []`
viewers opened only via `ctx.app.openViewerTab`.

### Sidebar panels — `registerSidebarPanel`

```ts
ctx.registerSidebarPanel({
  id: string,
  title: string,
  icon?: string,                    // codicon name; default "extensions"
  location?: "tab" | "explorer",    // default "tab"
  defaultCollapsed?: boolean,       // "explorer" only
  focusBinding?: string,            // default binding for the focus command
  component: React.ComponentType<SidebarPanelHostProps>,
});
```

Two locations:

- **`"tab"`** — its own full-height sidebar tab in the icon strip (SOURCE
  CONTROL, SEARCH). The auto-registered "Sidebar: Focus *title*" command
  reveals/switches to the tab, or hides the sidebar if it's already active
  (VS Code's toggle). The command only exists if `focusBinding` is given.
- **`"explorer"`** — an accordion section inside the Explorer tab, beside
  the built-in SESSIONS/FILES sections (how the bundled `ports` extension
  renders PORTS). It participates fully in the accordion's drag-reorder,
  collapse, and splitter-resize persistence under its namespaced id;
  `defaultCollapsed` sets the state for users with no stored entry. The
  focus command is **always** registered (unbound unless `focusBinding` is
  given) and expands the section, then focuses its first focusable row.

```ts
interface SidebarPanelHostProps {
  actionsTarget?: HTMLDivElement | null;  // portal header-row buttons here
  showMenu?: (x: number, y: number, items: MenuItem[]) => void;
  confirmDialog?: (message: string, confirmLabel?: string) => Promise<boolean>;
}
```

`actionsTarget` is the panel header's actions container — portal refresh/
sync buttons into it (`createPortal`) so they sit beside the title instead
of inside the scrollable body. `confirmDialog` is the app's shared confirm
dialog, for destructive actions (the ports panel's *Kill process*).

Badge counts on `"tab"` panels are set later via
[`ctx.app.setSidebarBadge`](#the-ctxapp-host-api), not at registration.

References: `search` (tab), `ports` (explorer).

### Window actions — `registerWindowAction`

```ts
ctx.registerWindowAction({
  id: string,
  icon: string,                         // codicon name
  title: string,                        // tooltip
  isVisible: (ctx: WindowActionContext) => boolean,
  onClick: (ctx: WindowActionContext) => void,
  showInTabBar?: boolean,               // default false
});

interface WindowActionContext {
  sessionName: string;
  windowIndex: number;
  cwd: string;
  command: string;   // the pane's current foreground command
}
```

An icon button on SESSIONS-tree window rows (next to the built-in kill
button), shown only where `isVisible` returns true — `command` lets an
action target e.g. only windows running `claude`. `isVisible` re-evaluates
on the session list's own ~3s poll, so it's reactive for free.
`showInTabBar: true` also renders it in the tab bar when the matching
terminal window's tab is focused. Reference: `live-preview`.

### File decorations — `registerFileDecorationProvider`

```ts
const handle = ctx.registerFileDecorationProvider({
  id: string,
  provideDecoration: (path: string, isDir: boolean) => FileDecoration | undefined,
  provideRootDecoration?: (rootPath: string) => RootDecoration | undefined,
});
// handle.refresh() — call after your cached answers change

interface FileDecoration {
  badge?: string;      // short text at the row's right edge, e.g. "M"
  tooltip?: string;    // falls back to the badge text
  className?: string;  // extra class(es) on the whole row — colors/dimming
                       // come from YOUR stylesheet, not a color value here
}

interface RootDecoration {
  label: string;       // the tree-header pill text (the branch pill's slot)
  tooltip?: string;
}
```

Called per **visible row** on every FILES-tree render with **absolute**
paths — resolve them against whatever roots you know about and answer from
cache. `provideRootDecoration` is called with the tree's current root
directory on every sidebar render; it doubles as your signal for *which*
root is on screen (git-scm records it there and fetches that root's status
from its server hook). First provider with an answer wins per path;
decorations don't merge.

The badge element itself is core's `.file-tree-git-badge`; your
`className` lands on the row, so ship the color rules in your own
stylesheet. Reference: `git-scm` (`provideDecoration` +
`statusModel.mjs`).

### Session decorations — `registerSessionDecorationProvider`

```ts
const handle = ctx.registerSessionDecorationProvider({
  id: string,
  provideWindowDecoration: (ctx: SessionDecorationContext) => SessionDecoration | undefined,
  onClick?: (anchorRect: DOMRect, ctx: SessionDecorationContext) => void,
});

interface SessionDecorationContext {  // same snapshot shape as WindowActionContext
  sessionName: string;
  windowIndex: number;
  cwd: string;
  command: string;
}

interface SessionDecoration {
  badge: string;        // the pill text, e.g. a count
  tooltip?: string;
  className?: string;
}
```

Renders a clickable badge on SESSIONS window rows (styled like the core
`.window-decoration-badge` pill). A window row can carry one badge per
provider. `onClick` receives the badge's bounding rect — position your own
popover from it, rendered into a root **you** own (via the
`react-dom/client` shim's `createRoot`) and torn down in `deactivate()`;
there is no host-rendered popover surface. Reference: `subagent-viewer`
(badge + popover + the "learn cwds from provide calls, poll, refresh"
cache pattern).

### Terminal engines — `registerTerminalEngine`

```ts
ctx.registerTerminalEngine({
  id: string,      // the engine setting stores "ext.<extId>.<id>"
  label: string,   // Settings → Terminal engine select text
  create: CreateTerminalEngine,
});
```

`CreateTerminalEngine` is the full terminal-engine seam —
`(options: TerminalEngineOptions) => Promise<TerminalEngineHandle>` — typed
in [`extensions/_shared/terminalEngineTypes.ts`](../extensions/_shared/terminalEngineTypes.ts)
(a structural copy of `client/src/engines/types.ts`; read that file for the
per-method contracts — write/fit/selection/link-hover/IME/etc.). This is
the deepest extension point in the app: implementing an engine means
satisfying every handle method TerminalView calls. One handle method is
optional: `setSoftKeyboardSuppressed(suppressed)` — set/remove
`inputmode="none"` on your hidden input element (both bundled engines do
exactly that on `term.textarea`); it backs the accessory context's
soft-keyboard suppression, and the host calls it defensively plus
re-applies the standing value after engine creation.

Resolution: the `terminalEngine` setting stores a namespaced engine id (or
`"auto"`, which picks xterm on mobile pointers and ghostty elsewhere when
that optional engine is installed, else xterm).
TerminalView resolves it against the registry **after the
extensions-settled gate**; an unknown/stale id falls back to the required
`xterm-engine`, and an empty registry renders an explicit error surface.
Runtime helpers your engine will need (cell math, link candidates, the
synthetic-selection marker) come from the
[`@tmux-server/engine-support` shim](#sharing-the-host-runtime).
References: `xterm-engine`, `ghostty-engine`.

### Terminal accessories — `registerTerminalAccessory`

```ts
ctx.registerTerminalAccessory({
  id: string,
  placement: "bar" | "overlay",
  component: React.ComponentType<{ context: TerminalAccessoryContext }>,
});

interface TerminalAccessoryContext {
  focused: boolean;        // is this the focused terminal
  mobilePointer: boolean;  // matchMedia("(pointer: coarse) and (hover: none)")
  command: string;         // the pane's foreground command
  stickyCtrl: boolean;     // the app's sticky-Ctrl state for this terminal
  toggleStickyCtrl(): void;
  sendInput(data: string): void;   // raw bytes to the pty
  sendText(text: string): void;    // local-echo-aware text (voice, paste-like)
  uploadImage(file: File): void;   // the terminal's upload pipeline
  setSoftKeyboardSuppressed(suppressed: boolean): void; // see below
  containerRef: React.RefObject<HTMLDivElement | null>; // the terminal body,
                                   // for "overlay" positioning
}
```

Rendered **per terminal**: `"bar"` accessories render after the terminal
body, in document flow (the docked touch-key bar's slot); `"overlay"`
accessories render inside the terminal body's positioning context (the
floating toggle's slot). Your component receives a fresh `context` each
render — return `null` whenever you shouldn't show (unfocused terminal,
your own settings say off), and register both placements unconditionally
if a setting picks between them, so flipping it applies live.

`sendInput` is the raw keystroke channel (sticky-Ctrl is applied by the
host's input pipeline, not here); `sendText` routes through the local-echo
overlay when it's active — use it for anything that's *typed prose* rather
than a control sequence. Reference: `touch-keys`.

`setSoftKeyboardSuppressed(true)` stops the OS soft keyboard from opening
when the user taps the terminal, without breaking input: the engine sets
`inputmode="none"` on its hidden input element, which stays focusable —
hardware keys and your accessory's own buttons keep working. It's for
accessories that *replace* the system keyboard (a full on-screen keyboard).
The request survives engine remounts (the host re-applies it to each new
engine instance) and no-ops on an engine that doesn't implement the seam's
optional `setSoftKeyboardSuppressed`. Two rules of thumb: make it
**opt-in behind one of your own settings** — while suppressed, your
accessory is the only on-screen text input, so users lose OS
autocomplete/dictation/IME — and call `setSoftKeyboardSuppressed(false)`
in `deactivate()` so disabling your extension restores normal behavior.

### Quick-switcher providers — `registerQuickSwitcherProvider`

```ts
const handle = ctx.registerQuickSwitcherProvider({
  id: string,
  provideResults: (query: string) => QuickSwitcherItem[],
});

interface QuickSwitcherItem {
  label: string;
  tag?: string;                    // the row's chip text; default "ext"
  run: (secondary: boolean) => void;  // secondary = Shift+Enter/Shift+click
}
```

Contributes rows to the quick switcher's **non-command** mode (`Ctrl+P`;
command mode already lists your `registerCommand`s). Called synchronously
per keystroke with the raw query — do your own matching against cached
data and **self-limit** result counts (core caps its own file matches at
50 for a reason). Ranked after the core tab/window/session groups and
before file matches. `refresh()` re-queries an open switcher when your
cache changes. A provider that throws contributes nothing rather than
breaking the list.

### Settings components — `registerSettingsComponent`

```ts
ctx.registerSettingsComponent({
  id: string,
  component: React.ComponentType,   // no props
});
```

Renders your component inside your extension's own Settings section,
**below** its scalar `contributes.configuration` controls. Registering one
earns the extension a Settings section even with zero scalar properties.
The component takes no props — read and write through `ctx.settings`
(stash it module-level in `activate()`), typically persisting rich state
as a JSON-string configuration property. The section's "Reset … Settings
to Defaults" button clears every stored value for the extension, so treat
"value absent" as "use defaults". Reference: `touch-keys`
(`TouchKeysEditor` + its `readKeys`/`writeKeys` JSON round-trip).

### The `ctx.app` host API

```ts
ctx.app.getActiveContext(): { sessionName: string | null; windowIndex: number | null; cwd: string | null }
ctx.app.onDidChangeContext(cb): () => void   // returns unsubscribe
```
The active tab's identity — the "current directory" for panels that follow
the user around (git-scm's status, search's scope).

```ts
ctx.app.openFileTab(path: string, line?: number): void
```
Opens a path through the same dispatch a FILES-tree click uses (nvim, or
whichever `"default"`-mode viewer claims it); `line` jumps there in nvim.

```ts
ctx.app.openViewerTab(viewerId: string, path: string, opts?: { title?: string }): void
```
Opens (or re-activates) a tab for one of **this extension's own**
registered viewers directly, bypassing extension matching — the route for
viewers registered with `extensions: []` (git-scm's diff view). Re-calling
for an open `(viewerId, path)` tab updates its title in place.

```ts
ctx.app.refreshFiles(): void
```
Bumps the FILES tree's refresh key so listings refetch now instead of on
the next poll — call it after mutating the working tree.

```ts
ctx.app.setSidebarBadge(panelId: string, badge: number | null): void
```
Sets/clears the count badge on one of this extension's own `"tab"` sidebar
panels (short id, un-namespaced). No-ops if the panel isn't registered.

```ts
ctx.app.getFileIcon(fileName: string): IconResult
ctx.app.getFolderIcon(folderName: string, expanded: boolean): IconResult
ctx.app.onDidChangeIconTheme(cb): () => void
```
Read-only queries against the *active* icon theme's resolver — the same
icons the FILES tree shows — so a panel can render file rows that match.
`IconResult` is `{ kind: "none" }` or a resolvable icon (see
`extensions/_shared/FileIcon.tsx` for a ready-made renderer).

```ts
ctx.app.consumeFindInFolderGlob(): string | null
```
One-shot handoff from the FILES tree's "Find in Folder…" menu item — only
the search extension is expected to call this.

### `ctx.serverFetch` / `ctx.assetUrl`

```ts
ctx.serverFetch(path: string, init?: RequestInit): Promise<Response>
```
`fetch()` scoped to this extension's own server hook — `serverFetch("/list")`
hits `/api/ext/<id>/list`. 404s if the extension has no server entry or is
disabled. Plain `fetch("/api/…")` still works for public core routes
(same origin), but prefer your own hook + the server `host` API over
depending on core route shapes.

```ts
ctx.assetUrl(relPath: string): string
```
Resolves an extension-relative path to a fetchable URL (the same
`/api/extensions/<id>/file/*` route your client entry loads from). Use it
with `extensions/_shared/injectStylesheet.ts` to attach `dist/client.css`,
images, etc. Traversal outside the extension folder is rejected.

### `ctx.settings`

```ts
ctx.settings.get(key: string): unknown          // full dotted key
ctx.settings.set(key: string, value: unknown): void
ctx.settings.onDidChange(cb: () => void): () => void
```

Your `contributes.configuration` values: manifest default overridden by the
user's stored value. `set` writes to the same server-synced store the
Settings UI edits — the value persists, syncs across the user's devices,
and fires `onDidChange` (which also fires for edits made in Settings or on
another device; it passes no arguments — re-`get` whatever you care
about). Only write keys you declared.

`ctx.React` is the host's own React instance, for no-build extensions.

---

## Server API

`tmuxServer.server` is a plain ESM module (no build step — the server runs
TypeScript via tsx, but extension server entries are plain JS):

```js
export function activate({ router, log, getSettings, host }) {
  router.get("/list", async (req, res) => { ... });
}
```

| Piece | Contract |
| --- | --- |
| `router` | An Express router mounted at `/api/ext/<extensionId>` while the extension is enabled. JSON bodies are parsed (`req.body`); send errors as `res.status(4xx/5xx).json({ error: "…" })` — client helpers surface the `error` field. Routes 404 immediately on disable/uninstall. |
| `log(...args)` | `console.log` prefixed with `[ext:<id>]`. |
| `getSettings()` | `Promise<Record<string, unknown>>` — this extension's current configuration values (defaults + user overrides), read fresh per call. |
| `host.ports.list()` | `Promise<ListeningPort[]>` — listening ports attributed to tmux sessions (`{ port, address, process?, pid?, session }`). The same attribution data the WS tunnel's security gate uses; consume it rather than re-scanning `/proc`. |
| `host.ports.find(port)` | `Promise<ListeningPort \| null>` — one port's fresh attribution (kill-confirmation flows). |
| `host.events.onApiMutation(cb)` | Fires after **any** mutating (non-GET/HEAD) core API request finishes — the signal that on-disk state probably changed. Use it to invalidate caches that mirror the filesystem (git-scm drops its status-scan cache here). Returns an unsubscribe; all of an extension's subscriptions are dropped when its hook unmounts. |

The `host` object is the **only** sanctioned way to reach core services —
never import core modules from an extension (it would bypass
enable/disable and break when core refactors).

Caveats:

- One activation per process per enable — but a disable→enable cycle
  within one server process calls `activate` again on the already-resident
  module. Module-level state persists across that; guard one-time setup
  (e.g. a unix-socket listener) accordingly, or key it per-activation.
- Long-lived children/watchdogs you spawn are yours to clean up; the host
  only unmounts your routes. See `git-scm/server.js` for a worked example
  of process-group management and timers.
- `cwd`-style parameters may arrive `~`-shortened (the client displays
  them that way) — expand before touching the filesystem.

References: `ports/server.js` (minimal, `host`-driven),
`subagent-viewer/server.js` (filesystem watcher with TTL caches),
`git-scm/server.js` (the full works).

---

## Sharing the host runtime

Bundled-style extensions are built by `extensions/build.mjs` (esbuild) with
these import aliases, each a thin re-export of the host's own instance via
`window.__tmuxServerModules` (set in `client/src/main.tsx` before any
extension loads):

| Alias | Provides |
| --- | --- |
| `react`, `react-dom`, `react/jsx-runtime` | The host's React. Two React copies break hooks and portals — never bundle your own. |
| `react-dom/client` | `createRoot` — for extension-owned floating UI (popovers) mounted into your own DOM node and unmounted in `deactivate()`. |
| `@tmux-server/engine-support` | Host terminal helpers (below). |

`@tmux-server/engine-support` exports (typed in
[`extensions/_shared/engine-support.d.ts`](../extensions/_shared/engine-support.d.ts)):

| Export | For |
| --- | --- |
| `cellFromPoint(x, y, rect, charW, charH, cols, rows)` | Pixel → 1-based cell math (mouse reports, touch selection). |
| `findCandidates(text)` / `Candidate` | The host's URL/path link detector — engines feed stitched lines through it. |
| `isOpenGesture(event)` / `openUrl(url)` | The app-wide Ctrl/Cmd+click convention and safe `window.open`. |
| `MAX_STITCH_LINES` | Cap for wrapped-line stitching walks. |
| `markSyntheticSelectStart(e)` / `isSyntheticSelectStart(e)` | Tags an engine's synthetic selection mousedown so the host's capture layer lets it pass. **Symbol-keyed — must be the host's instance**, which is the whole reason this ships as a shim. |
| `ensureContrastRatio(fg, bg, ratio)` / `Rgb` | WCAG minimum-contrast math (ghostty's renderer shims use it; xterm has it natively). |
| `whenMatches(when, command)` | The comma-separated program-list matcher (touch-key `when` clauses; same rule as core local echo). |
| `sendWithInkSafeEnters(data, send)` | Splits text at `\r` with 80ms gaps so Ink-based TUIs don't drop input. |

The rule of thumb: anything with **identity or shared state** (React, the
selection Symbol, the link detector) must come through a shim; small
**stateless** helpers live in `extensions/_shared/` as plain source
(`Icon.tsx`, `FileIcon.tsx`, `useListNavigation.ts`,
`useMarqueeSelection.ts`, `clipboard.ts`, `injectStylesheet.ts`,
`types.ts`, `terminalEngineTypes.ts`) — each extension's build inlines its
own copy, and structural typing keeps host-passed values compatible.

If you bundle with your own tooling instead of `build.mjs`, replicate the
aliases: map those module names to thin files re-exporting from
`window.__tmuxServerModules`. A plain no-build ESM `client.js` (like
hello-extension's) needs none of this — use `ctx.React` and skip JSX.

---

## Building and packaging

- **Bundled-style** (JSX/npm deps): put sources in `src/client.tsx`;
  `node extensions/build.mjs` (or `--watch`; `npm run dev` runs it for you)
  emits `dist/client.js` + `dist/client.css` (when the entry imports CSS —
  attach it in `activate()` via `injectStylesheet(ctx.assetUrl,
  "dist/client.css")` and detach in `deactivate()`). Bundled extensions
  are npm workspaces — declare npm deps in the extension's own
  `package.json`; they hoist to the root `node_modules` and esbuild inlines
  them into `dist/client.js`.
- **No-build**: a plain ESM `client.js`/`server.js` works as-is —
  hello-extension is the template.
- **Distribution**: a `.tsix` is a zip whose contents live under an
  `extension/` folder inside the archive. Installing through Settings
  unpacks it into `~/.config/tmux-server/extensions/<name>/` and enables
  it. Registries (Settings → Extensions → Available) serve an `index.json`
  catalog of `.tsix` URLs.

## Security model

There is no sandbox. A `tmuxServer.server` entry runs as the server
process's user; a `tmuxServer.client` entry runs with full page access
(same origin, same DOM, same auth). That's identical in kind to what the
app already hands you through the terminal itself — but it means:
**only install extensions you trust**, and as an author, treat your
`/api/ext/<id>` routes with the same care as core routes (they sit behind
the app's Host/Origin gate and auth, but validate paths and inputs — see
`git-scm/server.js`'s `resolveSafePath` for the pattern).
