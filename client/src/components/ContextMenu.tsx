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
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      // A toggle-style trigger (e.g. the tab-group chip's windows-dropdown
      // arrow) marks itself with this attribute so its own click handler
      // can decide whether to open or close the menu — without this, the
      // mousedown here would close it first, and the trigger's own click
      // (which fires after mousedown) would immediately reopen it, making
      // the toggle look like it does nothing.
      if ((e.target as HTMLElement).closest("[data-menu-trigger]")) return;
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Capture phase, not bubble: the terminal view stops propagation on its
    // own mousedown handling (link/selection gestures) at the capture phase
    // on its screen element, which would otherwise swallow the event before
    // a bubble-phase window listener ever saw it — clicking into a terminal
    // wouldn't close the menu. A capture listener on window itself always
    // runs first (capture visits ancestors before descendants), so this
    // sees every mousedown regardless of what a descendant does with it.
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  const shortcutHint = (commandId: string | undefined): string | undefined => {
    const key = commandId ? resolvedBindings[commandId]?.[0]?.key : undefined;
    return key ? formatBinding(key) : undefined;
  };

  const hasChecks = menu.items.some((item) => item.checked !== undefined);

  return (
    <div ref={ref} className="context-menu" style={{ left: pos.x, top: pos.y }}>
      {menu.items.map((item, i) =>
        item.swatches ? (
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
                {item.checked && <Icon name="check" />}
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
