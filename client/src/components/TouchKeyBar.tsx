import { useEffect, useRef, useState, type PointerEvent } from "react";
import { parseSend, sendWithInkSafeEnters, whenMatches, type TouchKey } from "../touchKeys";
import { isVoiceInputSupported, VoiceInput } from "../voiceInput";

interface Props {
  visible: boolean;
  keys: TouchKey[];
  // Pushed by the server's attach watcher; gates each key's `when`. See
  // TerminalView's "command" WS message handling.
  currentCommand: string;
  stickyCtrl: boolean;
  onToggleStickyCtrl: () => void;
  onSendInput: (data: string) => void;
  // Final voice transcripts (plans/codeman-mobile-features.md Phase 5) route
  // through this instead of onSendInput: TerminalView wires it to the same
  // local-echo-or-direct fork image paste/drop already uses (sendTextOrEcho)
  // — voice text is plain printable text, not a control sequence, so it
  // belongs in the buffered overlay when local echo is active, unlike every
  // other touch key.
  onSendVoiceText: (text: string) => void;
}

// Filters `keys` down to the ones that should render right now: `when`
// matched against currentCommand, and `send` successfully parsed (a key
// authored with a bad token, or still empty mid-edit in Settings, is
// skipped rather than rendered broken). `{mic}` is filtered out entirely on
// a browser without SpeechRecognition ("hidden when unsupported" — checked
// here, not just inside the button, so an all-unsupported bar still collapses
// via the shown.length === 0 check below). Exported so FloatingTouchKeys
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
    if (key.send === "{mic}") {
      if (isVoiceInputSupported()) result.push({ key, data: "" });
      continue;
    }
    const parsed = parseSend(key.send);
    if ("error" in parsed || parsed.data === "") continue;
    result.push({ key, data: parsed.data });
  }
  return result;
}

// Pointer handlers that fire onTap only for a still tap. preventDefault on
// pointerdown keeps focus on the terminal's hidden textarea (so tapping a
// key never dismisses the on-screen keyboard), while the action itself waits
// for pointerup within a small movement threshold: when the bar overflows
// and the user swipes it, the browser's pan takes the pointer (pointercancel,
// no pointerup) — or the finger has moved — so the key the swipe started on
// doesn't send.
function useTapHandlers(onTap: () => void) {
  const start = useRef<{ x: number; y: number } | null>(null);
  return {
    onPointerDown: (e: PointerEvent) => {
      e.preventDefault();
      start.current = { x: e.clientX, y: e.clientY };
    },
    onPointerUp: (e: PointerEvent) => {
      const s = start.current;
      start.current = null;
      if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) < 10) onTap();
    },
    onPointerCancel: () => {
      start.current = null;
    },
  };
}

// A `{mic}` key: toggles a VoiceInput session on tap, sending each final
// transcript through onTranscript. Its own component (unlike the stateless
// {ctrl} branch below) since it owns a VoiceInput instance's lifecycle —
// created once per mount, disposed on unmount, independent of whichever
// parent (TouchKeyBar or FloatingTouchKeys) renders it.
function MicKeyButton({ label, onTranscript }: { label: string; onTranscript: (text: string) => void }) {
  const [listening, setListening] = useState(false);
  const voiceRef = useRef<VoiceInput | null>(null);
  // Ref-mirrored so the VoiceInput instance (created once, in the effect
  // below) always calls the latest onTranscript without needing to be
  // recreated whenever the parent re-renders with a new closure identity.
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  useEffect(() => {
    const voice = new VoiceInput({
      onFinalResult: (text) => onTranscriptRef.current(text),
      onStateChange: setListening,
    });
    voiceRef.current = voice;
    return () => voice.dispose();
  }, []);

  const tap = useTapHandlers(() => voiceRef.current?.toggle());

  return (
    <button className={`touch-key touch-key-mic${listening ? " active" : ""}`} {...tap}>
      {label}
    </button>
  );
}

// One key button: the sticky-Ctrl toggle for send === "{ctrl}" (applies to
// the next character typed, since holding Ctrl isn't possible with an
// on-screen keyboard), the mic toggle for send === "{mic}", otherwise a
// plain send button. Pointer handlers (not onClick) via useTapHandlers so
// tapping a button never steals focus from the terminal's hidden textarea —
// losing it would dismiss the on-screen keyboard — and so panning an
// overflowing bar doesn't send. Exported for reuse by FloatingTouchKeys.
export function TouchKeyButton({
  touchKey,
  data,
  stickyCtrl,
  onToggleStickyCtrl,
  onSendInput,
  onSendVoiceText,
}: {
  touchKey: TouchKey;
  data: string;
  stickyCtrl: boolean;
  onToggleStickyCtrl: () => void;
  onSendInput: (data: string) => void;
  onSendVoiceText: (text: string) => void;
}) {
  const isCtrl = touchKey.send === "{ctrl}";
  const tap = useTapHandlers(() => {
    if (isCtrl) onToggleStickyCtrl();
    else sendWithInkSafeEnters(data, onSendInput);
  });
  if (touchKey.send === "{mic}") {
    return <MicKeyButton label={touchKey.label} onTranscript={onSendVoiceText} />;
  }
  if (isCtrl) {
    return (
      <button className={`touch-key touch-key-ctrl${stickyCtrl ? " active" : ""}`} {...tap}>
        {touchKey.label}
      </button>
    );
  }
  return (
    <button className="touch-key" {...tap}>
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
  onSendVoiceText,
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
          onSendVoiceText={onSendVoiceText}
        />
      ))}
    </div>
  );
}
