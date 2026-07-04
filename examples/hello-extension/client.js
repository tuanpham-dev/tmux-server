// Reference client entry — exercises every v1 extension API surface:
// a command with a default keybinding, a file viewer for a made-up ".demo"
// extension, a sidebar panel that talks to this same extension's server
// hook, and contributes.configuration settings (see package.json's "hello.*"
// properties). Plain ESM, no build step — ctx.React is how it gets React
// without bundling its own copy.
export function activate(ctx) {
  const { React, registerCommand, registerFileViewer, registerSidebarPanel, app, serverFetch, settings } = ctx;

  // Reads this extension's current setting values (declared default,
  // overridden by whatever the user set in Settings → Hello Extension) and
  // composes them into the greeting text.
  function buildGreeting() {
    const base = settings.get("hello.greeting");
    const mood = settings.get("hello.mood");
    let text =
      mood === "excited" ? `${base} 🎉` : mood === "formal" ? `${base} Sincerely, Hello Extension.` : base;
    if (settings.get("hello.shout")) text = `${text.toUpperCase()}!!!`;
    return Array.from({ length: settings.get("hello.repeatCount") }, () => text).join(" ");
  }

  registerCommand({
    id: "sayHello",
    label: "Hello Extension: Say Hello",
    defaultBinding: "ctrl+alt+KeyH",
    run: () => {
      const active = app.getActiveContext();
      const where = active.cwd ? ` (active window's cwd: ${active.cwd})` : "";
      window.alert(`${buildGreeting()}${where}`);
    },
  });

  registerFileViewer({
    id: "demoViewer",
    extensions: ["demo"],
    component: function DemoViewer({ filePath }) {
      const [text, setText] = React.useState("Loading…");
      React.useEffect(() => {
        let cancelled = false;
        fetch(`/api/download?inline=1&path=${encodeURIComponent(filePath)}`)
          .then((res) => res.text())
          .then((body) => {
            if (!cancelled) setText(body);
          })
          .catch((err) => {
            if (!cancelled) setText(`Failed to load: ${err}`);
          });
        return () => {
          cancelled = true;
        };
      }, [filePath]);
      return React.createElement(
        "div",
        { style: { padding: 16, fontFamily: "monospace", whiteSpace: "pre-wrap", color: "var(--fg)" } },
        React.createElement("h3", { style: { marginTop: 0 } }, `.demo viewer — ${filePath}`),
        text,
      );
    },
  });

  registerSidebarPanel({
    id: "helloPanel",
    title: "Hello",
    component: function HelloPanel() {
      const [message, setMessage] = React.useState("Loading…");
      // Live-apply demo: settings.onDidChange fires with no arguments
      // whenever any of this extension's settings change (a user edit in
      // Settings → Hello Extension, or the server doc syncing in) — re-read
      // via settings.get() rather than relying on the callback's payload.
      // No reload needed; try changing "Tone of the greeting" while this
      // panel is open.
      const [greeting, setGreeting] = React.useState(buildGreeting);
      React.useEffect(() => settings.onDidChange(() => setGreeting(buildGreeting())), []);
      React.useEffect(() => {
        let cancelled = false;
        serverFetch("/hello")
          .then((res) => res.json())
          .then((data) => {
            if (!cancelled) setMessage(data.message);
          })
          .catch((err) => {
            if (!cancelled) setMessage(`Server hook unreachable: ${err}`);
          });
        return () => {
          cancelled = true;
        };
      }, []);
      return React.createElement(
        "div",
        { style: { padding: "8px 12px", fontSize: 13 } },
        React.createElement("div", { style: { marginBottom: 6 } }, greeting),
        message,
      );
    },
  });
}
