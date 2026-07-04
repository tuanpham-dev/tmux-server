# tmux-server

A VSCode-style web UI for tmux. Browse all tmux sessions in a sidebar, open them as tabbed terminals, and manage sessions/windows — all from the browser via [xterm.js](https://xtermjs.org/) and WebSockets.

## Features

- **Sidebar** — sessions and windows as a tree, or grouped by working directory. Resizable, collapsible (`Ctrl+Shift+B`), shows attached/activity status.
- **Tabbed terminals** — open a whole session or a single window as its own tab, switch between them, close individually or all-but-one. Drag to reorder (long-press then drag on touch). In the installed PWA: `Ctrl+Tab`/`Ctrl+Shift+Tab` to cycle tabs, `Ctrl+W` to close the active one.
- **Session & window management** — create, rename, kill sessions and windows via context menu or hover buttons.
- **FILES panel** — browse the active window's working directory, drag-and-drop upload (files or folders, with conflict handling and progress), git status badges, and a context menu for creating, renaming, deleting, downloading (folders as zip), and copying paths. Clicking a file opens it in the pane's running `nvim`, or a new window if it's busy.
- **tmux-backed scrollbar** — draggable, since tmux (not the browser) owns scrollback.
- **Theming** — matches VS Code's Plastic Legacy theme and IBM Plex Mono by default; configurable via the in-app Settings dialog (font, size, cursor style, etc.).
- **Extensions** — install VS Code color themes and icon themes unchanged, or a small custom extension that adds a command, a file viewer, a sidebar panel, and a server route. See [Extensions](#extensions) below.
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

Extensions live as folders under `~/.config/tmux-server/extensions/<folder>/` — either drop one in directly (the server picks it up on next scan/restart), or install a packed `.vsix` from the Settings dialog's **Extensions** section, which also lists what's installed and lets you enable/disable or uninstall each one. A worked example covering every surface below is in [`examples/hello-extension`](examples/hello-extension).

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
    "iconThemes": [{ "id": "my-icons", "label": "My Icons", "path": "./themes/my-icon-theme.json" }]
  },
  "tmuxServer": {
    "client": "./client.js",
    "server": "./server.js"
  }
}
```

The extension's id is `publisher.name` (falling back to its folder name). `contributes.themes`/`contributes.iconThemes` point at real, unmodified VS Code color-theme / icon-theme JSON — comments and trailing commas are tolerated, and one level of `include` is resolved. `tmuxServer.client`/`tmuxServer.server` are both optional; either, neither, or both may be set.

### Color themes

A theme JSON's `colors` map is read via VS Code's own workbench keys (`editor.background`, `tab.activeBackground`, `list.hoverBackground`, `button.background`, `terminal.ansiRed`, …) — anything not set falls back to the built-in Plastic Legacy value for that slot, so a partial theme never breaks the UI. Applies live, no reload — both the app chrome and the terminal palette.

### Icon themes

Both icon styles VS Code themes use are supported: font-glyph (`fontCharacter`/`fontColor`, the bundled Seti default's style — the theme's own font is loaded at runtime via `FontFace`) and SVG (`iconPath`, the Material Icon Theme style). Matched by filename, then extension, then a theme-wide default, same as VS Code.

### Functionality

`tmuxServer.client` is a plain ESM module (no JSX, no bundler) exporting `activate(ctx)`:

- `ctx.React` — the app's own React instance (use `React.createElement`, or a JSX build step of your own that targets it)
- `ctx.registerCommand({ id, label, defaultBinding?, run })` — joins the built-in command list and the Keyboard settings section, auto-namespaced to `ext.<extensionId>.<id>`
- `ctx.registerFileViewer({ id, extensions, component })` — a component rendered full-tab for files with one of the given extensions (no override authority over the built-in image/media/PDF viewers)
- `ctx.registerSidebarPanel({ id, title, component })` — joins the sidebar accordion alongside SESSIONS/FILES/PORTS
- `ctx.app.getActiveContext()` / `ctx.app.onDidChangeContext(cb)` — the active tab's session name / window index / cwd
- `ctx.app.openFileTab(path)` — opens a path through the same dispatch a FILES-tree click uses
- `ctx.serverFetch(path, init?)` — `fetch()` scoped to this extension's own server route

`tmuxServer.server` is a plain ESM module exporting `activate({ router, log })` — `router` is an Express router mounted at `/api/ext/<extensionId>` for as long as the extension stays enabled; disabling/uninstalling unmounts the routes immediately, though the loaded module itself stays resident until the server restarts (Node can't unload an ES module) — the Settings dialog shows a restart hint for this case.

A client entry activates once at page load; enabling, disabling, or installing one takes a page reload to fully apply. Themes and icon themes need no reload.

### Security

Installing an extension with a `tmuxServer.server` entry runs its code as the server process's user, and a `tmuxServer.client` entry runs with full access to the page (same origin, same DOM) — identical in kind to the access this app already gives you through the terminal itself, but only install extensions you trust.

## Project layout

```
server/   Express + ws + node-pty — REST API for tmux operations, WS bridge to a PTY running `tmux attach`
client/   React + TypeScript + xterm.js — the browser UI
cli/      tunnel.mjs — standalone port-forwarding client, served at GET /tunnel.mjs
examples/ hello-extension — a reference extension covering every surface in Extensions
plans/    Design docs written during development
```

## License

MIT — see [LICENSE](LICENSE).
