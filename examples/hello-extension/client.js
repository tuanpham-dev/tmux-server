// Reference client entry — exercises every v1 extension API surface:
// a command with a default keybinding, a file viewer for a made-up ".demo"
// extension, and a sidebar panel that talks to this same extension's
// server hook. Plain ESM, no build step — ctx.React is how it gets React
// without bundling its own copy.
export function activate(ctx) {
  const { React, registerCommand, registerFileViewer, registerSidebarPanel, app, serverFetch } = ctx;

  registerCommand({
    id: "sayHello",
    label: "Hello Extension: Say Hello",
    defaultBinding: "ctrl+alt+KeyH",
    run: () => {
      const active = app.getActiveContext();
      const where = active.cwd ? ` (active window's cwd: ${active.cwd})` : "";
      window.alert(`Hello from the sample extension!${where}`);
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
      return React.createElement("div", { style: { padding: "8px 12px", fontSize: 13 } }, message);
    },
  });
}
