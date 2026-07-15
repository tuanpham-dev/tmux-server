import { parseSend, whenMatches, type TouchKey } from "../touchKeys";

interface Props {
  visible: boolean;
  keys: TouchKey[];
  // Pushed by the server's attach watcher; gates each key's `when`. See
  // TerminalView's "command" WS message handling.
  currentCommand: string;
  stickyCtrl: boolean;
  onToggleStickyCtrl: () => void;
  onSendInput: (data: string) => void;
}

// Filters `keys` down to the ones that should render right now: `when`
// matched against currentCommand, and `send` successfully parsed (a key
// authored with a bad token, or still empty mid-edit in Settings, is
// skipped rather than rendered broken). Exported so FloatingTouchKeys
// renders the identical set.
export function visibleKeys(
  keys: TouchKey[],
  currentCommand: string,
): { key: TouchKey; data: string }[] {
  const result: { key: TouchKey; data: string }[] = [];
  for (const key of keys) {
    if (!whenMatches(key.when, currentCommand)) continue;
    if (key.send === "{ctrl}") {
      result.push({ key, data: "" });
      continue;
    }
    const parsed = parseSend(key.send);
    if ("error" in parsed || parsed.data === "") continue;
    result.push({ key, data: parsed.data });
  }
  return result;
}

// One key button: the sticky-Ctrl toggle for send === "{ctrl}" (applies to
// the next character typed, since holding Ctrl isn't possible with an
// on-screen keyboard), otherwise a plain send button. onPointerDown (not
// onClick) + preventDefault so tapping a button never steals focus from the
// terminal's hidden textarea — losing it would dismiss the on-screen
// keyboard. Exported for reuse by FloatingTouchKeys.
export function TouchKeyButton({
  touchKey,
  data,
  stickyCtrl,
  onToggleStickyCtrl,
  onSendInput,
}: {
  touchKey: TouchKey;
  data: string;
  stickyCtrl: boolean;
  onToggleStickyCtrl: () => void;
  onSendInput: (data: string) => void;
}) {
  if (touchKey.send === "{ctrl}") {
    return (
      <button
        className={`touch-key touch-key-ctrl${stickyCtrl ? " active" : ""}`}
        onPointerDown={(e) => {
          e.preventDefault();
          onToggleStickyCtrl();
        }}
      >
        {touchKey.label}
      </button>
    );
  }
  return (
    <button
      className="touch-key"
      onPointerDown={(e) => {
        e.preventDefault();
        onSendInput(data);
      }}
    >
      {touchKey.label}
    </button>
  );
}

// Onscreen keys a mobile keyboard can't send (Esc, Tab, arrows, Ctrl+C by
// default) plus sticky Ctrl — fully user-customizable via Settings > UI
// (touchKeys.ts). Renders nothing when no key currently matches `when`.
export default function TouchKeyBar({
  visible,
  keys,
  currentCommand,
  stickyCtrl,
  onToggleStickyCtrl,
  onSendInput,
}: Props) {
  if (!visible) return null;
  const shown = visibleKeys(keys, currentCommand);
  if (shown.length === 0) return null;

  return (
    <div className="touch-key-bar">
      {shown.map(({ key, data }, i) => (
        <TouchKeyButton
          key={i}
          touchKey={key}
          data={data}
          stickyCtrl={stickyCtrl}
          onToggleStickyCtrl={onToggleStickyCtrl}
          onSendInput={onSendInput}
        />
      ))}
    </div>
  );
}
