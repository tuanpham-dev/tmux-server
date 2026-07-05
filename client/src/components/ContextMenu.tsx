import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MenuState } from "../types";

interface Props {
  menu: MenuState;
  onClose: () => void;
}

export default function ContextMenu({ menu, onClose }: Props) {
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
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

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
            className={`context-menu-item${item.danger ? " danger" : ""}`}
            onClick={() => {
              onClose();
              item.onClick();
            }}
          >
            {item.label}
          </button>
        ),
      )}
    </div>
  );
}
