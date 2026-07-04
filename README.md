# tmux-server

A VSCode-style web UI for tmux. Browse all tmux sessions in a sidebar, open them as tabbed terminals, and manage sessions/windows — all from the browser via [xterm.js](https://xtermjs.org/) and WebSockets.

## Features

- **Sidebar** — sessions and windows as a tree, or grouped by working directory. Resizable, collapsible (`Ctrl+Shift+B`), shows attached/activity status.
- **Tabbed terminals** — open a whole session or a single window as its own tab, switch between them, close individually or all-but-one. Drag to reorder (long-press then drag on touch). In the installed PWA: `Ctrl+Tab`/`Ctrl+Shift+Tab` to cycle tabs, `Ctrl+W` to close the active one.
- **Session & window management** — create, rename, kill sessions and windows via context menu or hover buttons.
- **FILES panel** — browse the active window's working directory, drag-and-drop upload (files or folders, with conflict handling and progress), git status badges, and a context menu for creating, renaming, deleting, downloading (folders as zip), and copying paths. Clicking a file opens it in the pane's running `nvim`, or a new window if it's busy.
- **tmux-backed scrollbar** — draggable, since tmux (not the browser) owns scrollback.
- **Theming** — matches VS Code's Plastic Legacy theme and IBM Plex Mono by default; configurable via the in-app Settings dialog (font, size, cursor style, etc.).
- **Extensions** — install VS Code color themes and icon themes unchanged, contribute custom terminal fonts, or a small custom extension that adds a command, a file viewer, a sidebar panel, and a server route. See [Extensions](#extensions) below.
- **Auto-reconnect** — a dropped connection (server restart, laptop sleep) reconnects automatically instead of losing the tab; open tabs also survive a browser reload.
- **Installable PWA** — installable app shell with offline caching for the UI; terminal/session traffic (`/api`, `/ws`) is always network-only.

## Requirements

- Node.js 20+
- `tmux` installed and on `PATH`
- A C/C++ toolchain (`node-pty` compiles a native addon on install)

## Setup

```bash
npm install
```

## Development

Runs the server (`:3001`) and Vite dev server (`:5173`, proxying `/api` and `/ws` to the server) together:

```bash
npm run dev
```

Open http://localhost:5173.

## Production

Builds the client and serves everything — static assets, `/api`, and `/ws` — from a single Express server:

```bash
npm run build
npm start          # listens on 127.0.0.1:3001 by default
```

Override the port with `PORT=<port> npm start`. The server always binds to `127.0.0.1` — there's no built-in authentication, so it's meant to be used locally or fronted by a reverse proxy (see below).

### Behind nginx

```nginx
location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

    # Terminals are long-lived WebSocket connections.
    proxy_read_timeout 1d;
    proxy_send_timeout 1d;
}
```

The server only accepts requests whose `Host` (and, for browser requests, `Origin`) resolve to `localhost`, `127.0.0.1`, or `::1` by default — this blocks other websites' pages from reaching it via your browser (WebSockets ignore same-origin policy). Set `ALLOWED_HOSTS` to a comma-separated list of the hostname(s) you expose it as, e.g.:

```bash
ALLOWED_HOSTS=tmux.example.com npm start
```

The `Host $host` line in the nginx config above forwards the real hostname through, so this only needs to be set once per domain.

## Port forwarding

If something on the server listens on a port (a dev server, a database) and you want `localhost:PORT` on your own machine to reach it — like `ssh -L`, but without SSH access — download and run the tunnel CLI:

```bash
curl -O http://<host>:3001/tunnel.mjs
node tunnel.mjs --url http://<host>:3001 3000
```

Now `http://localhost:3000` on your machine reaches `127.0.0.1:3000` on the server. Forward multiple ports in one command, and use `LOCAL:REMOTE` when you want a different local port:

```bash
node tunnel.mjs --url http://<host>:3001 3000 8080:80
```

`--url` defaults to `$TMUX_SERVER_URL`, then `http://127.0.0.1:3001`. All forwards share a single WebSocket connection, multiplexed per-connection — the CLI is a single dependency-free file (Node 20+, stdlib only), always served fresh from the server it's connecting to, so it never drifts out of sync with the server's protocol.

The **PORTS** panel in the sidebar lists the server's listening ports, lets you select the ones you want, and builds this command for you — just copy it and run it locally. If your browser session is carrying a `Cookie` or `Authorization` header (because tmux-server is fronted by a reverse-proxy auth layer), the panel automatically bakes it into the copied command via `-H`/`--header`, so the download and the tunnel both authenticate the same way your browser did. Values are masked on screen (click the eye icon to reveal them before copying) — but the pasted command still contains the real secret, so it lands in your shell history like any credential-bearing command.

If you're downloading or running the CLI by hand instead of using the panel's copy button, pass auth through yourself with URL credentials or headers:

```bash
curl -u user:pass -O https://myhost/tunnel.mjs
node tunnel.mjs --url https://user:pass@myhost 3000
node tunnel.mjs --url https://myhost --header 'Cookie: session=...' 3000
```

The nginx config above needs no changes — `/ws/tunnel` is covered by the same `location /` WebSocket proxy block as terminal sessions. Note that if a proxy strips the `Cookie`/`Authorization` header before forwarding upstream (some hardening configs explicitly clear `Authorization`), the panel has no way to detect that and will silently omit the header — same as if there were no auth layer at all.

## Extensions

Extensions live as folders under `~/.config/tmux-server/extensions/<folder>/` — either drop one in directly (the server picks it up on next scan/restart), or install a packed `.tsix` from the Settings dialog's **Extensions** section, which also lists what's installed and lets you enable/disable or uninstall each one. A worked example covering every surface below is in [`examples/hello-extension`](examples/hello-extension).

Every built-in file preview (image, media, PDF, markdown, JSON/YAML, CSV) — and the app's default color theme, icon theme, and terminal font — is itself a bundled extension under the repo's own [`extensions/`](extensions) directory, discovered alongside `~/.config/tmux-server/extensions/` — see [Bundled extensions](#bundled-extensions) below. A user-installed extension with the same id always takes precedence over a bundled one.

### Bundled extensions

Two shapes of bundled extension live under `extensions/<name>/`:

- **Functionality extensions** (one per built-in preview: `image-preview`, `media-preview`, `pdf-preview`, `markdown-preview`, `json-preview`, `csv-preview`) ship a normal extension manifest plus a `src/client.tsx` built by `extensions/build.mjs` into `dist/client.js` (+ `dist/client.css` if it imports any CSS). `npm run build`/`npm run dev` build these automatically (`prebuild`/`predev` hooks); `npm run build:extensions` builds them standalone, and `node extensions/build.mjs --watch` rebuilds on save (what `npm run dev` runs in the background).
- **Asset-only extensions** (`plastic-legacy-theme`, `seti-icons`, `ibm-plex-mono` — the app's default color theme, icon theme, and terminal font) have no `src/client.tsx`, so `build.mjs` skips them entirely; their manifest just points at theme/font files directly. All three are enabled by default, giving a fresh install the same look it always had, but each is now independently disable-/uninstallable/overridable like any other extension — a hard-coded fallback (styles.css's `:root` values, "no icon theme", generic `monospace`) covers the gap if one is off.

Bundled extensions are enabled by default and show a **Built-in** badge in Settings. Uninstalling one doesn't delete repo files — it's tombstoned in `~/.config/tmux-server/extensions-state.json` (hidden from the list until you install a `.tsix` with the same id, which restores or overrides it, or you remove the tombstone entry from that file by hand).

Small helpers shared across the bundled extensions (an `Icon` component, clipboard/file-fetch wrappers, a `MenuItem` type) live in `extensions/_shared/` as plain source — each extension's build inlines its own copy rather than sharing a runtime module, per `_shared`'s own comments. `extensions/_shared/shims/` holds the react/react-dom/react-jsx-runtime aliases described below.

Writing your own bundled-style extension with JSX or npm dependencies (not required — a plain ESM `client.js` like hello-extension's works with zero build step) means following the same convention: bundle with a tool of your choice, but alias `react`/`react-dom`/`react/jsx-runtime` to thin re-exports of `window.__tmuxServerModules` (set by `client/src/main.tsx` before any extension activates) instead of bundling real copies — two React instances break hooks and portals shared with the host. See `extensions/build.mjs` and `extensions/_shared/shims/*.mjs` for the reference implementation.

### Manifest format

Each extension has a `package.json` — a subset of the real VS Code extension manifest, plus one custom field:

```json
{
  "name": "my-extension",
  "publisher": "me",
  "version": "1.0.0",
  "displayName": "My Extension",
  "description": "What it does",
  "contributes": {
    "themes": [{ "label": "My Theme", "uiTheme": "vs-dark", "path": "./themes/my-theme-color-theme.json" }],
    "iconThemes": [{ "id": "my-icons", "label": "My Icons", "path": "./themes/my-icon-theme.json" }],
    "fonts": [{ "group": "My Fonts", "fonts": [{ "family": "My Mono", "src": [{ "path": "./fonts/MyMono-Regular.woff2", "format": "woff2" }] }] }],
    "configuration": {
      "title": "My Extension",
      "properties": {
        "myExtension.greeting": { "type": "string", "default": "Hello!", "description": "Greeting text" }
      }
    }
  },
  "tmuxServer": {
    "client": "./client.js",
    "server": "./server.js"
  }
}
```

The extension's id is `publisher.name` (falling back to its folder name). `contributes.themes`/`contributes.iconThemes` point at real, unmodified VS Code color-theme / icon-theme JSON — comments and trailing commas are tolerated, and one level of `include` is resolved. `tmuxServer.client`/`tmuxServer.server` are both optional; either, neither, or both may be set.

### Color themes

A theme JSON's `colors` map is read via VS Code's own workbench keys (`editor.background`, `tab.activeBackground`, `list.hoverBackground`, `button.background`, `terminal.ansiRed`, …) — anything not set falls back to the hard-coded Plastic Legacy value for that slot (styles.css's `:root`), so a partial theme never breaks the UI. That hard fallback is pixel-identical to the bundled `plastic-legacy-theme` extension, which is what's actually selected by default. Applies live, no reload — both the app chrome and the terminal palette.

### Icon themes

Both icon styles VS Code themes use are supported: font-glyph (`fontCharacter`/`fontColor`, the bundled `seti-icons` extension's style — the theme's own font is loaded at runtime via `FontFace`) and SVG (`iconPath`, the Material Icon Theme style). Matched by filename, then extension, then a theme-wide default, same as VS Code. Selecting no icon theme ("None") shows blank spacer icons rather than falling back to Seti.

### Fonts

Not a VS Code manifest concept (VS Code's own font contributions are icon-theme glyph fonts only) — `contributes.fonts` is tmux-server's own extension of the manifest, for terminal text fonts. Each entry is a named **group** bundling one or more font families:

```json
"contributes": {
  "fonts": [
    {
      "group": "My Fonts",
      "fonts": [
        { "family": "My Mono", "src": [{ "path": "./fonts/MyMono-Regular.woff2", "format": "woff2" }] },
        { "family": "My Mono", "src": [{ "path": "./fonts/MyMono-Bold.woff2", "format": "woff2" }], "weight": "bold" },
        { "family": "My Nerd Symbols", "src": [{ "path": "./fonts/MyNerdSymbols.woff2", "format": "woff2" }] }
      ]
    }
  ]
}
```

Within a group's `fonts`, entries sharing a `family` register different weights/styles of the same font (worth including a `"weight": "bold"` face — xterm renders bold cells with it, falling back to synthetic bold otherwise); entries with distinct `family` values bundle separate fonts into that one group, e.g. a mono text font plus a Nerd Font symbols companion. A group is the Settings → Terminal font picker's unit of selection: picking "My Fonts" writes **every** family in the group into the font stack at once (mono as the primary font, the symbols font riding along as an implicit fallback) — no separate step to combine them. One extension can contribute several groups (e.g. the same symbols font offered both bundled into a combo group and on its own).

The font-family select only lists fonts this app can actually guarantee: "Use fallback fonts" (contributes nothing itself — the whole stack comes from the fallback field), its own bundled fonts, and whatever enabled extensions contribute. A locally-installed system font isn't offered there (it isn't guaranteed to exist wherever the page is next opened) — type it into the fallback field instead, same as any other font-family string. A stored stack whose leading font doesn't match a listed option (typed by hand, or from an extension that's since been disabled) just shows as "Use fallback fonts" with the whole thing sitting in that field.

Unlike themes, fonts aren't mutually exclusive and aren't all loaded up front: a family's `FontFace`s are only fetched once that family is actually present in the stack — whether it got there via a group selection or a hand-typed fallback — and are dropped again if it's removed or its extension is disabled/uninstalled, the same selected-only-loads policy color and icon themes already follow; this is per-family, so a stack that keeps only one member of a group never loads the other. Registers under each family's real name (unlike icon-theme fonts, which load under an internal namespaced family), so you can reference it directly in the fallback field. Applies live, no reload.

### Settings

`contributes.configuration` is VS Code's real manifest shape — a single object or an array of them (each with an optional `title` and a `properties` map), which lets one extension group its settings under more than one heading. Each property key is the full dotted name the extension will read back (no shared prefix is required, but `myExtension.foo` is the usual convention):

```json
"contributes": {
  "configuration": {
    "title": "My Extension",
    "properties": {
      "myExtension.greeting": { "type": "string", "default": "Hello!", "description": "Greeting text" },
      "myExtension.shout": { "type": "boolean", "default": false, "description": "Shout the greeting" },
      "myExtension.repeatCount": { "type": "integer", "default": 1, "minimum": 1, "maximum": 5 },
      "myExtension.mood": {
        "type": "string",
        "enum": ["neutral", "excited"],
        "enumItemLabels": ["Neutral", "Excited"],
        "enumDescriptions": ["Plain greeting", "Adds an exclamation"],
        "default": "neutral"
      }
    }
  }
}
```

Supported `type`s are `boolean`, `number`, `integer`, and `string` (with `enum` for a picker) — a property with any other `type` (or missing one) is dropped; `array`/`object` values aren't supported. An `enum` property's options are labeled with `enumItemLabels[i]` (falling back to the raw value) with `enumDescriptions[i]` shown as that option's tooltip, matching VS Code. `description` (or `markdownDescription`, rendered as plain text) is shown as the setting's label.

Extensions with at least one enabled, valid property get their own entry in the Settings nav (below a divider, under the built-in sections), titled by the manifest's `displayName`. Only non-default values are ever persisted — same as keybinding overrides — so a later change to an extension's declared default still reaches a user who never touched that setting; a value survives the extension being disabled or uninstalled. Applies live, no reload, on both sides:

- Client: `ctx.settings.get(key)` returns the current value (declared default, or the user's override); `ctx.settings.onDidChange(cb)` fires `cb()` (no arguments — call `get()` again for whatever you care about) whenever any of this extension's settings change, returning an unsubscribe function.
- Server: the server hook's `activate({ router, log, getSettings })` gains `getSettings()`, returning a `Promise` of this extension's full key→value map (declared defaults merged with the user's overrides). Read fresh on every call, so there's no cache to invalidate — a change reaches the next request without a server restart.

### Functionality

`tmuxServer.client` is a plain ESM module (no JSX, no bundler) exporting `activate(ctx)`:

- `ctx.React` — the app's own React instance (use `React.createElement`, or a JSX build step of your own that targets it — see [Bundled extensions](#bundled-extensions))
- `ctx.registerCommand({ id, label, defaultBinding?, run })` — joins the built-in command list and the Keyboard settings section, auto-namespaced to `ext.<extensionId>.<id>`
- `ctx.registerFileViewer({ id, extensions, mode?, editorFallback?, component })` — a component rendered full-tab for files with one of the given extensions:
  - `mode` (default `"default"`): `"default"` means a FILES-tree click opens this viewer directly; `"preview"` means a click still opens the file in nvim as usual, and this viewer is reached instead via the FILES-tree hover icon, the "Preview" context-menu item, or Shift+Enter in the quick switcher
  - `editorFallback` (default `true`, `"default"`-mode only): whether the context menu offers an "Open in Editor" item to fall back to nvim — the bundled image-preview leaves this on (for editing e.g. an SVG's source), media-preview/pdf-preview turn it off (nvim on binary content isn't useful)
  - among same-path matches, a third-party (user-installed) viewer takes precedence over a bundled one, so you can override a built-in preview by registering for the same extension
  - the component receives `{ filePath, active }` plus optional host props: `toolbarTarget` (a `HTMLDivElement | null` to portal tab-bar controls into), `openInEditor(path)`, `showMenu(x, y, items)`, `setDirty(dirty)` (report unsaved edits so closing the tab confirms first), `fontSize` (px)
- `ctx.registerSidebarPanel({ id, title, component })` — joins the sidebar accordion alongside SESSIONS/FILES/PORTS
- `ctx.app.getActiveContext()` / `ctx.app.onDidChangeContext(cb)` — the active tab's session name / window index / cwd
- `ctx.app.openFileTab(path)` — opens a path through the same dispatch a FILES-tree click uses
- `ctx.serverFetch(path, init?)` — `fetch()` scoped to this extension's own server route
- `ctx.assetUrl(relPath)` — resolves an extension-relative path (e.g. a bundled stylesheet) to a fetchable URL, the same route the client entry itself is loaded from
- `ctx.settings.get(key)` / `ctx.settings.onDidChange(cb)` — this extension's `contributes.configuration` values — see [Settings](#settings) above

`tmuxServer.server` is a plain ESM module exporting `activate({ router, log, getSettings })` — `router` is an Express router mounted at `/api/ext/<extensionId>` for as long as the extension stays enabled; disabling/uninstalling unmounts the routes immediately, though the loaded module itself stays resident until the server restarts (Node can't unload an ES module) — the Settings dialog shows a restart hint for this case. `getSettings()` returns this extension's current settings — see [Settings](#settings) above.

A client entry activates once at page load; enabling, disabling, or installing one takes a page reload to fully apply. Themes and icon themes need no reload.

### Security

Installing an extension with a `tmuxServer.server` entry runs its code as the server process's user, and a `tmuxServer.client` entry runs with full access to the page (same origin, same DOM) — identical in kind to the access this app already gives you through the terminal itself, but only install extensions you trust.

## Project layout

```
server/     Express + ws + node-pty — REST API for tmux operations, WS bridge to a PTY running `tmux attach`
client/     React + TypeScript + xterm.js — the browser UI
extensions/ Bundled extensions (image/media/pdf/markdown/json/csv preview) — see Bundled extensions
cli/        tunnel.mjs — standalone port-forwarding client, served at GET /tunnel.mjs
examples/   hello-extension — a reference extension covering every surface in Extensions
plans/      Design docs written during development
```

## License

MIT — see [LICENSE](LICENSE).
