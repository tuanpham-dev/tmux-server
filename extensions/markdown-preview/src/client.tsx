import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { common } from "lowlight";
import apache from "highlight.js/lib/languages/apache";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import ini from "highlight.js/lib/languages/ini";
import nginx from "highlight.js/lib/languages/nginx";
import "highlight.js/styles/github-dark.css";
import "./style.css";
import { fetchFileText } from "../../_shared/fileApi";
import { injectStylesheet } from "../../_shared/injectStylesheet";
import Icon from "../../_shared/Icon";

// Set once from activate() — see the module comment on extSettings below.
interface SettingsApi {
  get(key: string): unknown;
  onDidChange(cb: () => void): () => void;
}

let extSettings: SettingsApi | null = null;

// lowlight's default "common" set (~35 languages) excludes several
// devops/config languages that show up in READMEs — nginx, dockerfile,
// apache all fall back to unhighlighted plain text otherwise (rehype-
// highlight silently no-ops on an unregistered language, no error). Curated
// rather than lowlight's "all" (~192 languages): +6KB vs. +1.18MB bundled.
const rehypeHighlightPlugin: [typeof rehypeHighlight, { languages: Record<string, unknown> }] = [
  rehypeHighlight,
  { languages: { ...common, nginx, dockerfile, apache, toml: ini } },
];

function readFontSize(): number {
  return Number(extSettings?.get("markdown.previewFontSize")) || 14;
}

// Perceived brightness (ITU-R BT.601): >THRESHOLD reads as a light theme.
// Tunable in isolation if a mid-tone theme ever lands on the wrong side.
const LIGHT_THRESHOLD = 140;

function parseCssColorBrightness(value: string): number | null {
  const hex = value.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1];
    const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    return 0.299 * r + 0.587 * g + 0.114 * b;
  }
  const rgb = value.trim().match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  if (rgb) {
    const [, r, g, b] = rgb;
    return 0.299 * Number(r) + 0.587 * Number(g) + 0.114 * Number(b);
  }
  return null;
}

function computeHl(): "light" | "dark" {
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg");
  const brightness = parseCssColorBrightness(bg);
  return brightness !== null && brightness > LIGHT_THRESHOLD ? "light" : "dark";
}

interface Props {
  filePath: string;
  active: boolean;
  // The tab bar's actions container (TabBar's .tab-bar-actions) — same
  // portal mechanism as image-preview's zoom toolbar, only one viewer's
  // controls ever render into it since only one tab is active at a time.
  toolbarTarget?: HTMLDivElement | null;
  // Escape hatch back to the default (nvim) view of this same file —
  // markdown's primary click already opens the editor, so unlike images
  // this is surfaced directly in the tab bar rather than only the context
  // menu, since the user had to opt out of the editor to get here.
  openInEditor?: (path: string) => void;
}

function MarkdownView({ filePath, active, toolbarTarget, openInEditor }: Props) {
  const basename = filePath.slice(filePath.lastIndexOf("/") + 1);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fontSize, setFontSize] = useState(readFontSize);
  const [hl, setHl] = useState(computeHl);

  useEffect(() => extSettings?.onDidChange(() => setFontSize(readFontSize())), []);

  // The host applies color themes as CSS var overrides directly on <html>
  // (see theme.ts's applyColorThemeCssVars) with no light/dark class to read
  // instead — so react to any style mutation there and recompute from --bg.
  useEffect(() => {
    setHl(computeHl());
    const observer = new MutationObserver(() => setHl(computeHl()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
    return () => observer.disconnect();
  }, []);

  // No auto-refresh/polling — fetched once on mount, plus the portaled
  // Refresh button below for picking up on-disk edits on demand.
  const load = useCallback(() => {
    setError(null);
    fetchFileText(filePath)
      .then(setContent)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [filePath]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath]);

  const controls = (
    <>
      <button className="icon-button" title="Refresh" onClick={load}>
        <Icon name="refresh" />
      </button>
      {/* file-code, not edit/pencil — matches code-server's own markdown
          extension, which uses $(file-code) for showSource/reopenAsSource
          (its "back to editor from preview" action). */}
      <button className="icon-button" title="Open in Editor" onClick={() => openInEditor?.(filePath)}>
        <Icon name="file-code" />
      </button>
    </>
  );

  return (
    <div className={`markdown-host${active ? "" : " hidden"}`}>
      <div className="markdown-scroll">
        {error && <div className="markdown-status markdown-error">Couldn't load {basename}</div>}
        {!error && content === null && <div className="markdown-status">Loading…</div>}
        {!error && content !== null && (
          <div className="markdown-body" data-hl={hl} style={{ fontSize: `${fontSize}px` }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlightPlugin]}>
              {content}
            </ReactMarkdown>
          </div>
        )}
      </div>
      {active && toolbarTarget && createPortal(controls, toolbarTarget)}
    </div>
  );
}

export function activate(ctx: {
  registerFileViewer: (v: {
    id: string;
    extensions: string[];
    mode: "default" | "preview";
    component: typeof MarkdownView;
  }) => void;
  assetUrl: (relPath: string) => string;
  settings: SettingsApi;
}) {
  extSettings = ctx.settings;
  injectStylesheet(ctx.assetUrl, "dist/client.css");
  ctx.registerFileViewer({
    id: "markdownViewer",
    extensions: ["md", "markdown"],
    mode: "preview",
    component: MarkdownView,
  });
}
