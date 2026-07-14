import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// Only matters for `npm run dev`: the built index.html's <title> is instead
// templated per-request by the server (see APP_NAME handling in
// server/src/index.ts) so a rebuild isn't needed in production.
function appNameTitlePlugin() {
  return {
    name: "app-name-title",
    transformIndexHtml(html: string) {
      const appName = process.env.APP_NAME;
      if (!appName) return html;
      const escaped = appName.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
      return html.replace(/<title>.*?<\/title>/, `<title>${escaped}</title>`);
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    appNameTitlePlugin(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.ico", "icon.svg", "apple-touch-icon-180x180.png"],
      manifest: {
        name: "tmux-server",
        short_name: "tmux",
        description: "A web-based tmux terminal client",
        display: "standalone",
        theme_color: "#21252b",
        background_color: "#21252b",
        icons: [
          { src: "pwa-64x64.png", sizes: "64x64", type: "image/png" },
          { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png" },
          {
            src: "maskable-icon-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        // index.html deliberately NOT precached and no navigateFallback:
        // navigations always fetch fresh HTML from the server, so a deploy
        // takes effect on the next reload instead of whenever the service
        // worker deigns to update — devices were stuck on stale bundles
        // for hours (the app is useless offline anyway; the hashed assets
        // below stay precached purely for load speed).
        globPatterns: ["**/*.{js,css,ttf,woff2,svg,png,ico}"],
        navigateFallback: null,
        // Symbols Nerd Font Mono (Powerline/prompt icon glyphs) is ~2.5 MB,
        // just over workbox's 2 MiB default.
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
      },
    }),
  ],
  // Shown in the Settings footer as ground truth for which build a device
  // is actually running (see settings-build).
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC"),
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:3001",
      "/tunnel.mjs": "http://127.0.0.1:3001",
      "/ws": {
        target: "http://127.0.0.1:3001",
        ws: true,
      },
      "/proxy": {
        target: "http://127.0.0.1:3001",
        ws: true,
      },
      "/absproxy": {
        target: "http://127.0.0.1:3001",
        ws: true,
      },
    },
  },
});
