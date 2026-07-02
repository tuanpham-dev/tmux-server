# tmux-server

A VSCode-style web UI for tmux. Browse all tmux sessions in a sidebar, open them as tabbed terminals, and manage sessions/windows — all from the browser via [xterm.js](https://xtermjs.org/) and WebSockets.

## Features

- **Sidebar** — sessions and windows as a tree, or grouped by working directory. Resizable, collapsible (`Ctrl+B`), shows attached/activity status.
- **Tabbed terminals** — open any session as a tab, switch between them, close individually or all-but-one.
- **Session & window management** — create, rename, kill sessions and windows via context menu.
- **tmux-backed scrollbar** — draggable, since tmux (not the browser) owns scrollback.
- **Theming** — matches VS Code's Plastic Legacy theme and IBM Plex Mono by default; configurable via the in-app Settings dialog (font, size, cursor style, etc.).
- **Auto-reconnect** — a dropped connection (server restart, laptop sleep) reconnects automatically instead of losing the tab; open tabs also survive a browser reload.

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

## Project layout

```
server/   Express + ws + node-pty — REST API for tmux operations, WS bridge to a PTY running `tmux attach`
client/   React + TypeScript + xterm.js — the browser UI
plans/    Design docs written during development
```

## License

MIT — see [LICENSE](LICENSE).
