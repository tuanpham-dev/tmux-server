// esbuild emits a sibling dist/client.css when an extension's entry imports
// CSS (see ../build.mjs) but never auto-links it — call this once from
// activate() to add it to <head>. A no-op ctx.assetUrl check isn't needed:
// this is only ever called by an extension whose build actually produced a
// CSS file.
export function injectStylesheet(assetUrl: (relPath: string) => string, relPath: string): void {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = assetUrl(relPath);
  document.head.appendChild(link);
}
