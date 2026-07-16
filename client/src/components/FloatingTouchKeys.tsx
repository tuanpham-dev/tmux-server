import { useEffect, useRef, useState, type RefObject } from "react";
import type { TouchKey } from "../touchKeys";
import { TouchKeyButton, visibleKeys } from "./TouchKeyBar";

interface Props {
  visible: boolean;
  keys: TouchKey[];
  currentCommand: string;
  stickyCtrl: boolean;
  onToggleStickyCtrl: () => void;
  onSendInput: (data: string) => void;
  onSendVoiceText: (text: string) => void;
  onUploadImage: (file: File) => void;
  // TerminalView's .terminal-body — the toggle's position is clamped within
  // its bounds and re-clamped on resize (rotation, sidebar toggle).
  containerRef: RefObject<HTMLElement | null>;
}

const STORAGE_KEY = "touchKeyFabPos";
const TOGGLE_SIZE = 44;
const DRAG_THRESHOLD = 6;
const CLUSTER_GAP = 8;

interface FabPos {
  // Fraction (0-1) of container width/height, applied to the toggle's
  // center — resize-proportional so orientation changes don't strand it
  // off-screen. Device-specific by nature, so this lives in localStorage
  // only, never the synced settings doc.
  xFrac: number;
  yFrac: number;
}

const DEFAULT_POS: FabPos = { xFrac: 0.9, yFrac: 0.82 };

function loadPos(): FabPos {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "");
    if (typeof parsed.xFrac === "number" && typeof parsed.yFrac === "number") {
      return parsed as FabPos;
    }
  } catch {
    // fall through to default
  }
  return DEFAULT_POS;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

// A movable AssistiveTouch-style toggle: tap expands the same when-filtered
// key set TouchKeyBar would show, positioned in a cluster next to the
// toggle instead of a fixed bottom strip; drag moves the toggle anywhere
// over the terminal. Alternative to TouchKeyBar for touchKeyBarStyle
// "floating" — see settings.ts.
export default function FloatingTouchKeys({
  visible,
  keys,
  currentCommand,
  stickyCtrl,
  onToggleStickyCtrl,
  onSendInput,
  onSendVoiceText,
  onUploadImage,
  containerRef,
}: Props) {
  const [pos, setPos] = useState<FabPos>(loadPos);
  const [expanded, setExpanded] = useState(false);
  const dragState = useRef<{ startX: number; startY: number; moved: boolean } | null>(null);
  // Bumped by the ResizeObserver below so a container resize (rotation,
  // sidebar toggle) re-derives centerX/centerY from the live rect — the
  // fractional pos itself never needs adjusting, only the render does.
  const [, bumpForResize] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => bumpForResize((n) => n + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerRef]);

  if (!visible) return null;

  const shown = visibleKeys(keys, currentCommand);
  const rect = containerRef.current?.getBoundingClientRect();
  const width = rect?.width ?? 0;
  const height = rect?.height ?? 0;
  const half = TOGGLE_SIZE / 2;
  const centerX = width ? clamp(pos.xFrac * width, half, width - half) : 0;
  const centerY = height ? clamp(pos.yFrac * height, half, height - half) : 0;

  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    dragState.current = { startX: e.clientX, startY: e.clientY, moved: false };
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const drag = dragState.current;
    if (!drag || !rect) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (Math.hypot(dx, dy) > DRAG_THRESHOLD) drag.moved = true;
    if (!drag.moved) return;
    const nx = clamp(e.clientX - rect.left, half, width - half);
    const ny = clamp(e.clientY - rect.top, half, height - half);
    setPos({ xFrac: width ? nx / width : DEFAULT_POS.xFrac, yFrac: height ? ny / height : DEFAULT_POS.yFrac });
  };

  const handlePointerUp = () => {
    const drag = dragState.current;
    dragState.current = null;
    if (!drag) return;
    if (drag.moved) {
      setPos((p) => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
        return p;
      });
    } else {
      setExpanded((v) => !v);
    }
  };

  // Quadrant-based flip: the cluster grows away from whichever edge the
  // toggle is nearest, so it never opens off the container.
  const openLeft = centerX > width / 2;
  const openUp = centerY > height / 2;

  return (
    <>
      {expanded && shown.length > 0 && (
        <div
          className="touch-key-fab-cluster"
          style={{
            position: "absolute",
            ...(openLeft
              ? { right: `${width - centerX + half + CLUSTER_GAP}px` }
              : { left: `${centerX + half + CLUSTER_GAP}px` }),
            ...(openUp
              ? { bottom: `${height - centerY + half + CLUSTER_GAP}px` }
              : { top: `${centerY + half + CLUSTER_GAP}px` }),
            maxWidth: `${Math.max(width - 24, 120)}px`,
          }}
        >
          {shown.map(({ key, data }, i) => (
            <TouchKeyButton
              key={i}
              touchKey={key}
              data={data}
              stickyCtrl={stickyCtrl}
              onToggleStickyCtrl={onToggleStickyCtrl}
              onSendInput={onSendInput}
              onSendVoiceText={onSendVoiceText}
              onUploadImage={onUploadImage}
            />
          ))}
        </div>
      )}
      <button
        className={`touch-key-fab${expanded ? " active" : ""}`}
        style={{ left: `${centerX - half}px`, top: `${centerY - half}px` }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        ⌨
      </button>
    </>
  );
}
