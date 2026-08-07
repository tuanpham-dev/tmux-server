import { useEffect, useRef, useState } from "react";
import * as api from "../api";
import Icon from "./Icon";

interface Props {
  // Seed path — the "default new session dir" setting when set, else "~".
  initialPath: string;
  onPick: (path: string) => void;
  onCancel: () => void;
}

// Code-server-style "Open Folder" dialog: an editable path input over a
// browsable listing of the current folder's subdirectories (the existing
// /api/fs listing endpoint — files are filtered out here). Enter in the
// input lists the typed path; clicking (or Enter-ing) a row descends; ".."
// ascends; "Open Folder" resolves with the last successfully listed folder.
// The server echoes back the expanded absolute path on every listing, so
// navigation always works on canonical paths even when the user types
// "~/…". A failed listing (typo'd path) shows its error inline and disables
// the confirm until a valid folder is listed again.
export default function FolderPickerDialog({ initialPath, onPick, onCancel }: Props) {
  // What the user is asked to list next (input Enter / row click / "..").
  const [requestPath, setRequestPath] = useState(initialPath);
  // The last successfully listed folder — what descend/ascend/confirm act on.
  const [listedPath, setListedPath] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState(initialPath);
  const [dirs, setDirs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Guards against an out-of-order response landing after a faster, newer
  // one (typing a new path while a slow listing is still in flight).
  const requestSeq = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const seq = ++requestSeq.current;
    api
      .listDir(requestPath)
      .then((listing) => {
        if (seq !== requestSeq.current) return;
        setDirs(listing.entries.filter((e) => e.dir).map((e) => e.name));
        setListedPath(listing.path);
        setInputValue(listing.path);
        setError(null);
      })
      .catch((err: Error) => {
        if (seq !== requestSeq.current) return;
        setError(err.message);
      });
  }, [requestPath]);

  // Listed paths are `~`-shortened (the server echoes them that way — see
  // /api/fs). "~" itself gets no ".." row: the picker treats home as its
  // effective root; anywhere outside is reachable by typing an absolute
  // path.
  const parentPath = (() => {
    if (listedPath === null || listedPath === "/" || listedPath === "~") return null;
    const idx = listedPath.lastIndexOf("/");
    if (idx === -1) return null;
    return idx === 0 ? "/" : listedPath.slice(0, idx);
  })();

  const descend = (name: string) => {
    if (listedPath === null) return;
    setRequestPath(listedPath === "/" ? `/${name}` : `${listedPath}/${name}`);
  };

  // ArrowUp/ArrowDown walk the entry buttons; Enter activates the focused
  // one (native button behavior). Home/End jump to first/last.
  const onListKeyDown = (e: React.KeyboardEvent) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const buttons = [...(listRef.current?.querySelectorAll<HTMLButtonElement>(".folder-picker-entry") ?? [])];
    if (buttons.length === 0) return;
    e.preventDefault();
    const focused = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? buttons.length - 1
          : e.key === "ArrowDown"
            ? Math.min(focused + 1, buttons.length - 1)
            : Math.max(focused - 1, 0);
    buttons[next]?.focus();
  };

  return (
    <div className="dialog-overlay" onMouseDown={onCancel}>
      <div
        className="dialog folder-picker"
        role="dialog"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
      >
        <div className="dialog-message">Open Folder</div>
        <input
          ref={inputRef}
          className="dialog-input"
          value={inputValue}
          placeholder="~/path/to/project"
          spellCheck={false}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (inputValue.trim()) setRequestPath(inputValue.trim());
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              listRef.current?.querySelector<HTMLButtonElement>(".folder-picker-entry")?.focus();
            }
          }}
        />
        {error && <div className="folder-picker-error">{error}</div>}
        <div className="folder-picker-list" ref={listRef} onKeyDown={onListKeyDown}>
          {parentPath !== null && (
            <button className="folder-picker-entry" onClick={() => setRequestPath(parentPath)}>
              <Icon name="folder" />
              <span>..</span>
            </button>
          )}
          {dirs.map((name) => (
            <button key={name} className="folder-picker-entry" onClick={() => descend(name)}>
              <Icon name="folder" />
              <span>{name}</span>
            </button>
          ))}
          {listedPath !== null && dirs.length === 0 && !error && (
            <div className="folder-picker-empty">No subfolders</div>
          )}
        </div>
        <div className="dialog-buttons">
          <button className="dialog-button secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="dialog-button primary"
            disabled={error !== null || listedPath === null}
            onClick={() => listedPath !== null && onPick(listedPath)}
          >
            Open Folder
          </button>
        </div>
      </div>
    </div>
  );
}
