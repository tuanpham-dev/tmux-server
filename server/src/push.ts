import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import webpush from "web-push";

// VAPID keys + push subscriptions, stored beside settings.json in the same
// config dir (settingsStore.ts's convention) — a separate file rather than
// folded into the synced settings doc, since a PushSubscription is
// inherently device/browser-specific (tied to that browser's own service
// worker registration), unlike settings.json's cross-device-synced fields.
const configDir = path.join(
  process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"),
  "tmux-server",
);
const pushPath = path.join(configDir, "push.json");

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

interface PushDoc {
  vapidPublicKey: string;
  vapidPrivateKey: string;
  subscriptions: PushSubscriptionRecord[];
}

function isPushDoc(value: unknown): value is PushDoc {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PushDoc).vapidPublicKey === "string" &&
    typeof (value as PushDoc).vapidPrivateKey === "string" &&
    Array.isArray((value as PushDoc).subscriptions)
  );
}

async function writeDoc(doc: PushDoc): Promise<void> {
  await mkdir(configDir, { recursive: true });
  // Temp-then-rename so a crash mid-write can't leave a truncated file —
  // same pattern as settingsStore.ts.
  const tmp = `${pushPath}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(doc, null, 2));
  await rename(tmp, pushPath);
}

// Memoized across calls within this process — subsequent calls read the
// cached doc instead of hitting disk, mutated in place and persisted on
// every write below.
let cached: PushDoc | undefined;

async function loadOrInit(): Promise<PushDoc> {
  if (cached) return cached;
  try {
    const parsed: unknown = JSON.parse(await readFile(pushPath, "utf8"));
    if (isPushDoc(parsed)) {
      cached = parsed;
      return cached;
    }
  } catch {
    // Missing or corrupt file — generate fresh VAPID keys below.
  }
  const keys = webpush.generateVAPIDKeys();
  const doc: PushDoc = { vapidPublicKey: keys.publicKey, vapidPrivateKey: keys.privateKey, subscriptions: [] };
  await writeDoc(doc);
  cached = doc;
  return doc;
}

export async function getVapidPublicKey(): Promise<string> {
  return (await loadOrInit()).vapidPublicKey;
}

export async function addSubscription(sub: PushSubscriptionRecord): Promise<void> {
  const doc = await loadOrInit();
  if (doc.subscriptions.some((s) => s.endpoint === sub.endpoint)) return;
  doc.subscriptions.push(sub);
  await writeDoc(doc);
}

export async function removeSubscription(endpoint: string): Promise<void> {
  const doc = await loadOrInit();
  const next = doc.subscriptions.filter((s) => s.endpoint !== endpoint);
  if (next.length === doc.subscriptions.length) return;
  doc.subscriptions = next;
  await writeDoc(doc);
}

// Per-pane cooldown so a pane bouncing the bell repeatedly (a busy build
// script, not just Claude's permission-prompt bell) doesn't spam a push per
// ring — in-memory only, resets on server restart, which is fine since a
// restart is rare and the cost of one extra push after it is negligible.
const RATE_LIMIT_MS = 30_000;
const lastNotifiedAt = new Map<string, number>();

export async function notifyBell(pane: string): Promise<void> {
  const now = Date.now();
  const last = lastNotifiedAt.get(pane) ?? 0;
  if (now - last < RATE_LIMIT_MS) return;
  lastNotifiedAt.set(pane, now);

  const doc = await loadOrInit();
  if (doc.subscriptions.length === 0) return;
  webpush.setVapidDetails("mailto:tmux-server@localhost", doc.vapidPublicKey, doc.vapidPrivateKey);
  const payload = JSON.stringify({ title: "tmux-server", body: `${pane} is waiting for input`, pane });

  const stale: string[] = [];
  await Promise.all(
    doc.subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, payload);
      } catch (err) {
        // 404/410: the push service says this subscription is gone
        // (unsubscribed elsewhere, expired) — drop it rather than retrying
        // it forever on every future bell.
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) stale.push(sub.endpoint);
      }
    }),
  );
  if (stale.length > 0) {
    doc.subscriptions = doc.subscriptions.filter((s) => !stale.includes(s.endpoint));
    await writeDoc(doc);
  }
}
