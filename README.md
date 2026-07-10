# tmux-server

A VSCode-style web UI for tmux. Browse all tmux sessions in a sidebar, open them as tabbed terminals, and manage sessions/windows — all from the browser via [xterm.js](https://xtermjs.org/) and WebSockets.

![Sidebar, FILES panel, Source Control panel, and an nvim tab with inline git blame](docs/screenshots/overview.png)

<details>
<summary>More screenshots</summary>

| | |
|---|---|
| ![Colorized terminal output in a tab](docs/screenshots/tabs-and-logs.png) | ![git log and status in a terminal tab](docs/screenshots/git-shell.png) |
| ![Extensions settings panel](docs/screenshots/extensions.png) | ![Ctrl+P quick switcher for tabs, windows, and sessions](docs/screenshots/quick-switcher.png) |

</details>

## Features

- **Sidebar** — VS Code-style icon tabs across the top switch between views: **Explorer** (sessions and windows as a tree, or grouped by working directory, plus FILES and PORTS — panels reorderable by drag and independently resizable) and one tab per extension-contributed panel, like SOURCE CONTROL. Drag a tab to reorder it. Resizable, collapsible (`Ctrl+Shift+B`), shows attached/activity status. Jump straight to a tab with its shortcut — `Ctrl+Shift+E` for Explorer, `Ctrl+Shift+G` for Source Control, `Ctrl+Shift+F` for Search (which yields to the terminal's own find when a terminal is focused) — revealing the sidebar first if it's hidden, and re-pressing the active tab's shortcut hides it again.
- **Quick switcher (`Ctrl+P`)** — fuzzy-search and jump to any open tab, window, or session, or search files by name. `Enter` opens a file in the editor; `Shift+Enter` opens it in its preview viewer instead; `Alt+J`/`Alt+K` move the selection (in addition to the arrow keys). Type `>` as the first character (or press `Ctrl+Shift+P`) to switch it into a **command palette** — every keyboard-bindable command, including extension-contributed ones, searchable by name and runnable without a bound key. The command you last ran from the palette always appears first; enable "Sort command palette by most-used" in Settings → Behavior to order the rest by usage instead of their default order.
- **Tabbed terminals** — open a whole session or a single window as its own tab, switch between them, close individually or all-but-one. Drag to reorder (long-press then drag on touch), middle-click to close, double-click a tab to toggle the sidebar. Background tabs with new output get an activity dot; closing the active tab reactivates the most-recently-used one. In the installed PWA: `Ctrl+Tab`/`Ctrl+Shift+Tab` to cycle tabs, `Ctrl+W` to close the active one. Optional Chrome-style **tab groups** (Settings → Behavior) collect each session's tabs — plus any preview tab opened from it — behind a colored, collapsible chip; pick the chip's color, collapse/expand, or reorder groups from its context menu, or drag a chip to reorder it directly.
- **Session & window management** — click a session to open every one of its windows as its own tab; create, rename, kill sessions and windows via context menu or hover buttons. **Pin a session** (context menu) to keep it in the sidebar after it's killed — a dimmed row with a pin icon that restores the session (and its saved working directory) with one click or "New Window".
- **FILES panel** — browse the active window's working directory, drag-and-drop upload (files or folders, with conflict handling and progress), git status badges, and a context menu for creating, renaming, deleting, downloading (folders as zip), and copying paths. Clicking a file opens it in the pane's running `nvim`, or a new window if it's busy; hovering a previewable file (image, PDF, Markdown, JSON/YAML, CSV, HTML) shows a Preview icon that opens it in a rendered tab instead. The current git branch shows as a pill in the FILES header — click it to open (or jump to) `lazygit` as a tab.
- **File viewer tabs** — image (zoom/pan), audio/video, PDF, and rendered Markdown previews, plus editable CSV and JSON/YAML tree viewers with save-back to disk.
- **SOURCE CONTROL tab** — stage/unstage/discard changes, commit, push/pull/sync with ahead/behind counts, publish a new branch, and open a unified diff view — all without leaving the browser. Bundled as the `git-scm` extension.
- **Live Preview** — a sandboxed, auto-reloading preview tab for local HTML files. Bundled as the `live-preview` extension.
- **Terminal niceties** — `Ctrl+click` (`Cmd+click` on Mac) opens URLs, local file paths (with `:line[:col]` jumping), and hyperlinked text; scrollback search (`Ctrl+Shift+F`); Shift+drag for browser text selection instead of tmux copy-mode; an on-screen key bar (Esc, Tab, arrows, Ctrl+C, sticky Ctrl) on touch devices.
- **tmux-backed scrollbar** — draggable, since tmux (not the browser) owns scrollback.
- **Theming** — matches VS Code's Plastic Legacy theme and IBM Plex Mono by default; configurable via the in-app Settings dialog (font, size, cursor style, etc.). Settings are persisted server-side, so they follow you across browsers/devices.
- **Rebindable keybindings** — every shortcut can be remapped from Settings → Keyboard; see [Keyboard & mouse](#keyboard--mouse) below for the defaults.
- **Extensions** — install VS Code color themes and icon themes unchanged, contribute custom terminal fonts, or a small custom extension that adds a command, a file viewer, a sidebar panel, and a server route. See [Extensions](#extensions) below.
- **Auto-reconnect** — a dropped connection (server restart, laptop sleep) reconnects automatically instead of losing the tab; open tabs also survive a browser reload.
- **Installable PWA** — installable app shell with offline caching for the UI; terminal/session traffic (`/api`, `/ws`) is always network-only.

## Keyboard & mouse

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+B` | Toggle sidebar |
| `Ctrl+P` | Toggle quick switcher |
| `Ctrl+Shift+P` † | Show command palette |
| `Ctrl+Tab` * | Next tab |
| `Ctrl+Shift+Tab` * | Previous tab |
| `Ctrl+W` * | Close active tab |
| `Ctrl+,` | Open Settings |
| `Ctrl+Shift+C` | Copy terminal selection |
| `Ctrl+Shift+F` | Scrollback search |
| `Shift+Enter` | Insert a literal newline in the terminal |
| `Alt+1`…`Alt+9` ‡ | Jump straight to the 1st…9th tab |
| `Ctrl+Shift+PageUp` / `Ctrl+Shift+PageDown` | Move the active tab left / right |
| `Shift+Alt+T` | Reopen the last closed tab |
| `Ctrl+=` / `Ctrl+-` | Increase / decrease terminal font size |
| `Ctrl+0` | Reset terminal font size |

\* Browser-reserved outside the installed PWA — bind a different combo in Settings → Keyboard if you're using tmux-server as a regular browser tab.

† Firefox reserves `Ctrl+Shift+P` for opening a private window and won't let pages intercept it — rebind it in Settings → Keyboard, or just type `>` into the `Ctrl+P` quick switcher instead.

‡ Firefox on Linux also binds `Alt+1`…`Alt+9` to its own tab switching and may not let pages intercept them — rebind in Settings → Keyboard if that's in the way.

The command palette also lists eight session/window actions — **New Session**, **Kill Current Session**, **Rename Current Session…**, **Pin/Unpin Current Session**, **New Window**, **Kill Current Window**, **Rename Current Window…**, and **Close Other Tabs** — that ship with no default key so they don't collide with anything; bind any of them from Settings → Keyboard if you use them often. They stay accessible from the sidebar's context menus and hover buttons either way. **Terminal: Clear Scrollback** and **Terminal: Scroll to Bottom** likewise ship unbound — assign a chord in Settings → Keyboard if you want one.

- **`Ctrl`+click** (`Cmd`+click on Mac) a URL, local file path, or hyperlink in the terminal to open it; add `Shift` to open a file in its preview viewer instead of the editor.
- **Drag** in the terminal makes a tmux copy-mode selection; **Shift+drag** makes a normal browser text selection.
- **Shift+scroll** (or a trackpad's horizontal scroll) sends horizontal scroll events to `nvim`.

All of the above are defaults — remap any of them, including extension-contributed commands, from Settings → Keyboard.

## Requirements

- Node.js 20+
- `tmux` installed and on `PATH`
- A C/C++ toolchain (`node-pty` compiles a native addon on install)

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/tuanpham-dev/tmux-server/main/install.sh | bash
```

Clones the repo to `~/.local/share/tmux-server`, builds it, and symlinks a `tmux-server` command into `~/.local/bin`. On systemd systems, it also installs and starts a user service (`~/.config/systemd/user/tmux-server.service`) with linger enabled, so it survives logout and starts on boot. No `sudo`, nothing written outside `$HOME`. Re-running the same command later updates an existing install instead of failing.

The installer checks for Node 20+, `tmux`, `git`, and a C/C++ toolchain up front and exits with distro-specific hints if anything's missing, rather than trying to install them itself.

### The `tmux-server` command

| Command | What it does |
|---|---|
| `tmux-server start` / `stop` / `restart` | Start, stop, or restart the service |
| `tmux-server status` | Whether it's running, and whether it's actually responding |
| `tmux-server instances` | List every running instance — any port, any launch method (`npm run dev`, `npm start`, the systemd service, or a `start --port` one-off) |
| `tmux-server logs` | Follow the server's logs |
| `tmux-server enable` / `disable` | Install and enable (or disable) the systemd service |
| `tmux-server update` | Pull the latest code, reinstall, rebuild, and restart |
| `tmux-server doctor` | Check dependencies and install health, and troubleshoot problems |

Config (`PORT`, `AUTH_TOKEN`, `ALLOWED_HOSTS`, `NEW_SESSION_CWD`, `APP_NAME`) goes in `~/.local/share/tmux-server/server/.env` — see [Production](#production) below for what each does. Without systemd (e.g. on macOS), `start`/`stop`/`restart` fall back to running the server in the background directly instead of managing a service.

#### Flags instead of env vars

`start` and `restart` also accept the same config as flags — `tmux-server start --help` shows the full list (`--port`, `--app-name`, `--allowed-hosts`, `--auth-token`, `--new-session-cwd`; both `--flag value` and `--flag=value` work):

```bash
tmux-server start --port=8040 --app-name="Tmux Server - Work"
```

- **With systemd** (the default managed install): flags are written into `server/.env` and the service is restarted — they persist across future restarts, same as editing `server/.env` by hand.
- **Without systemd** (foreground-fallback mode): flags start an *additional* background instance on the given port, alongside anything already running — handy for running a second, differently-configured instance (e.g. a "work" one on another port) without disturbing the main one. Starting on a port that's already in use is refused.

`tmux-server stop` stops the only running instance automatically; if more than one instance is running, it lists them and asks which to stop (or pass `--port <n>` or `--all` to skip the prompt). See `tmux-server stop --help`.

## Manual setup (from source)

Prefer [Install](#install) above for a managed, updatable install. To run from a clone directly instead:

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

Override the port with `PORT=<port> npm start`. The server always binds to `127.0.0.1` and has no authentication by default, so it's meant to be used locally, fronted by a reverse-proxy auth layer, or gated with `AUTH_TOKEN` (see [Authentication](#authentication) below). Set `NEW_SESSION_CWD` to change the working directory new sessions start in — without it, tmux falls back to the server process's own cwd. (The client's own "default new session directory" setting, if set, wins over both.)

Set `APP_NAME` to rebrand the browser tab title and PWA name away from the "tmux" default — e.g. `APP_NAME="My Server" npm start`. It's applied dynamically as the server templates `index.html` and `manifest.webmanifest` per request, so (like the other config above) a restart is all it takes — no rebuild needed. `APP_NAME=... npm run dev` retitles the dev server's tab too, but the PWA manifest is only active in the production build (Vite's PWA plugin doesn't run in dev by default).

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
    proxy_set_header X-Forwarded-Proto $scheme;

    # Terminals are long-lived WebSocket connections.
    proxy_read_timeout 1d;
    proxy_send_timeout 1d;
}
```

If you add `auth_basic` (nginx-level HTTP Basic Auth) in front of this, exempt the manifest and service worker from it — Chrome's internal PWA-installability check fetches them without your browser's cached Basic Auth credentials, so they'll get a 401 and the "Install app" option won't appear even though the site itself loads fine:

```nginx
location = /manifest.webmanifest {
    auth_basic off;
    proxy_pass http://127.0.0.1:3001;
}
location = /sw.js {
    auth_basic off;
    proxy_pass http://127.0.0.1:3001;
}
location ~ ^/workbox-.*\.js$ {
    auth_basic off;
    proxy_pass http://127.0.0.1:3001;
}
```

`AUTH_TOKEN` (see [Authentication](#authentication) below) doesn't have this problem, since it's cookie-based and cookies ride along on every request automatically — it's the simpler option if you don't need Basic Auth for another reason.

The server only accepts requests whose `Host` (and, for browser requests, `Origin`) resolve to `localhost`, `127.0.0.1`, or `::1` by default — this blocks other websites' pages from reaching it via your browser (WebSockets ignore same-origin policy). Set `ALLOWED_HOSTS` to a comma-separated list of the hostname(s) you expose it as, e.g.:

```bash
ALLOWED_HOSTS=tmux.example.com npm start
```

The `Host $host` line in the nginx config above forwards the real hostname through, so this only needs to be set once per domain. The `X-Forwarded-Proto` line lets the server mark the auth cookie (see below) `Secure` when you're serving over HTTPS.

### Authentication

Set `AUTH_TOKEN` to require a shared secret before anything under `/api` or either WebSocket endpoint (`/ws/attach`, `/ws/tunnel`) is reachable:

```bash
AUTH_TOKEN=<a-long-random-secret> npm start
```

Open the app with the token in the URL once:

```
https://tmux.example.com/?token=<a-long-random-secret>
```

The server mints an HttpOnly cookie from that request and strips `?token=` from the address bar; every later request in that browser rides the cookie automatically. Visiting without a valid token shows a login form asking for it instead of the app.

Notes:

- **Off by default.** Leaving `AUTH_TOKEN` unset disables the gate entirely — identical to today's behavior.
- **The token appears once in plaintext** — in the URL you opened, and in your browser history unless you clear it. Treat that URL like a credential; don't paste it into chat or a public issue.
- **Scripts and the tunnel CLI** can't hold a cookie across invocations — pass the token as a header instead: `curl -H 'x-auth-token: <secret>' ...` or `node tunnel.mjs --header 'x-auth-token: <secret>' ...`. The PORTS panel's copy button already bakes in whatever `Cookie`/`Authorization` your browser session is carrying (see [Port forwarding](#port-forwarding) below), so the auth cookie — including one minted by `AUTH_TOKEN` — rides along automatically when you copy its generated command.
- **Static assets and `/tunnel.mjs`** stay reachable without a token — they're public code with nothing to protect. An extension's own `/api/ext/<id>/public/*` routes are likewise exempt from the gate, the same way they're exempt from the Origin check.

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

Every built-in file preview (image, media, PDF, markdown, JSON/YAML, CSV, HTML) — the SOURCE CONTROL panel — and the app's default color theme, icon theme, and terminal font — is itself a bundled extension under the repo's own [`extensions/`](extensions) directory, discovered alongside `~/.config/tmux-server/extensions/` — see [Bundled extensions](#bundled-extensions) below. A user-installed extension with the same id always takes precedence over a bundled one.

### Bundled extensions

Two shapes of bundled extension live under `extensions/<name>/`:

- **Functionality extensions** (one per built-in preview — `image-preview`, `media-preview`, `pdf-preview`, `markdown-preview`, `json-preview`, `csv-preview` — plus `git-scm`, the SOURCE CONTROL panel, and `live-preview`, the sandboxed HTML preview) ship a normal extension manifest plus a `src/client.tsx` built by `extensions/build.mjs` into `dist/client.js` (+ `dist/client.css` if it imports any CSS). `npm run build`/`npm run dev` build these automatically (`prebuild`/`predev` hooks); `npm run build:extensions` builds them standalone, and `node extensions/build.mjs --watch` rebuilds on save (what `npm run dev` runs in the background).
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
- `ctx.registerSidebarPanel({ id, title, icon?, focusBinding?, component })` — adds its own tab to the sidebar's tab strip, alongside the built-in Explorer tab (SESSIONS/FILES/PORTS); `icon` is a codicon name (default `"extensions"`); `focusBinding` (a keybindings.ts-style combo, e.g. `"ctrl+shift+KeyG"`) auto-registers a rebindable "Sidebar: Focus `<title>`" command that reveals the sidebar (if hidden) and switches to this tab, or hides the sidebar if it's already the active tab — omit it for no dedicated shortcut/palette entry; the component receives one optional host prop, `actionsTarget` (a `HTMLDivElement | null` to portal header-row buttons into, e.g. a refresh/sync icon next to the panel's title — same portal mechanism `registerFileViewer`'s `toolbarTarget` uses)
- `ctx.app.getActiveContext()` / `ctx.app.onDidChangeContext(cb)` — the active tab's session name / window index / cwd
- `ctx.app.openFileTab(path)` — opens a path through the same dispatch a FILES-tree click uses
- `ctx.app.openViewerTab(viewerId, path, opts?: { title? })` — opens (or activates) a tab for one of this extension's own `registerFileViewer` components directly, bypassing extension-based matching — for a viewer registered with `extensions: []` that's only ever reached this way (e.g. a diff view opened from a source-control panel). `opts.title` overrides the tab-bar label (default: the path's basename); calling it again for an already-open `(viewerId, path)` tab updates its title in place
- `ctx.app.refreshFiles()` — bumps the FILES tree's refresh key, so its git-status badges reflect a change this extension just made (stage, commit, discard, pull) without waiting for its own poll
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
extensions/ Bundled extensions (image/media/pdf/markdown/json/csv/html preview, git source control) — see Bundled extensions
cli/        tunnel.mjs — standalone port-forwarding client, served at GET /tunnel.mjs
bin/        tmux-server — CLI for managing an installed instance, see Install
systemd/    tmux-server.service — the user-mode systemd unit installed by install.sh
examples/   hello-extension — a reference extension covering every surface in Extensions
plans/      Design docs written during development
```

## License

MIT — see [LICENSE](LICENSE).
