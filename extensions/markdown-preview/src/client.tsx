import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import "highlight.js/styles/github-dark.css";
import "./style.css";
import { fetchFileText } from "../../_shared/fileApi";
import { injectStylesheet } from "../../_shared/injectStylesheet";
import Icon from "../../_shared/Icon";

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
          <div className="markdown-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
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
}) {
  injectStylesheet(ctx.assetUrl, "dist/client.css");
  ctx.registerFileViewer({
    id: "markdownViewer",
    extensions: ["md", "markdown"],
    mode: "preview",
    component: MarkdownView,
  });
}
