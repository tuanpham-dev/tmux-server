import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { formatBinding, type Keybinding } from "../keybindings";
import type { MenuState } from "../types";
import Icon from "./Icon";

interface Props {
  menu: MenuState;
  onClose: () => void;
  // Resolves each item's shortcutCommand to a live hint — a Settings rebind
  // re-renders App (this component's sole render site), so even a menu
  // already open when the rebind happens shows the new combo immediately.
  resolvedBindings: Record<string, Keybinding[]>;
}

export default function ContextMenu({ menu, onClose, resolvedBindings }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: menu.x, y: menu.y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { innerWidth, innerHeight } = window;
    const rect = el.getBoundingClientRect();
    setPos({
      x: Math.min(menu.x, innerWidth - rect.width - 4),
      y: Math.min(menu.y, innerHeight - rect.height - 4),
    });
  }, [menu]);

  useEffect(() => {
    const onOutsidePress = (e: MouseEvent | TouchEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      // A toggle-style trigger (e.g. the tab-group chip's windows-dropdown
      // arrow) marks itself with this attribute so its own click handler
      // can decide whether to open or close the menu — without this, the
      // press here would close it first, and the trigger's own click
      // (which fires after mousedown/touchend) would immediately reopen
      // it, making the toggle look like it does nothing.
      if ((e.target as HTMLElement).closest("[data-menu-trigger]")) return;
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Capture phase, not bubble, on both mousedown and touchstart: the
    // terminal view's own gesture handling (link/selection on mouse, tap/
    // scroll on touch) calls stopPropagation/preventDefault at the capture
    // phase on its screen element. For a mouse press that swallows the
    // bubble phase before a bubble-phase window listener ever saw it; for a
    // real touch tap, canceling its touchend suppresses the synthetic
    // mousedown/click the browser would otherwise synthesize, so there is
    // no mouse event at all to listen for. A capture listener on window
    // itself always runs first (capture visits ancestors before
    // descendants) and touchstart itself is dispatched before any of that
    // suppression, so both variants are seen regardless of what a
    // descendant does with the event afterward.
    window.addEventListener("mousedown", onOutsidePress, true);
    window.addEventListener("touchstart", onOutsidePress, true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onOutsidePress, true);
      window.removeEventListener("touchstart", onOutsidePress, true);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  const shortcutHint = (commandId: string | undefined): string | undefined => {
    const key = commandId ? resolvedBindings[commandId]?.[0]?.key : undefined;
    return key ? formatBinding(key) : undefined;
  };

  const hasChecks = menu.items.some((item) => item.checked !== undefined || item.icon !== undefined);

  return (
    <div ref={ref} className="context-menu" style={{ left: pos.x, top: pos.y }}>
      {menu.items.map((item, i) =>
        item.separator ? (
          <div key={i} className="context-menu-separator" />
        ) : item.swatches ? (
          <div key={i} className="context-menu-swatches">
            {item.swatches.colors.map((c) => (
              <button
                key={c.key}
                className={`swatch${item.swatches!.selected === c.key ? " selected" : ""}`}
                title={c.key}
                style={{ background: c.hex }}
                onClick={() => {
                  onClose();
                  item.swatches!.onPick(c.key);
                }}
              />
            ))}
          </div>
        ) : (
          <button
            key={i}
            className={`context-menu-item${item.danger ? " danger" : ""}${item.disabled ? " disabled" : ""}`}
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return;
              onClose();
              item.onClick();
            }}
          >
            {hasChecks && (
              <span className="context-menu-item-check">
                {item.checked ? <Icon name="check" /> : item.icon ? <Icon name={item.icon} /> : null}
              </span>
            )}
            <span className="context-menu-item-label">{item.label}</span>
            {shortcutHint(item.shortcutCommand) && (
              <span className="context-menu-item-shortcut">{shortcutHint(item.shortcutCommand)}</span>
            )}
          </button>
        ),
      )}
    </div>
  );
}
