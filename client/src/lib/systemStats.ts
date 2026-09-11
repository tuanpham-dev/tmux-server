// Pure model for the host readout the status bar's memory reading opens:
// turns the raw counters the server sends into the rows the popover draws.
// No React, no fetching — SystemStatsPanel renders these as a label, a meter
// and a figure, and lib/systemStatsStore.ts is what keeps them arriving.

import { formatBytes } from "../formatSize";

export interface DiskUsage {
  // Already shortened for display ("/" or "~"), not a path to act on.
  path: string;
  totalBytes: number;
  usedBytes: number;
  // Free to an ordinary user, which is what `df` reports and is less than
  // total - used on a filesystem with blocks reserved for root.
  availableBytes: number;
}

export interface NetworkRates {
  rxBytesPerSec: number;
  txBytesPerSec: number;
}

// Everything only the popover shows, and therefore everything the server only
// gathers when it is open (GET /api/system-stats?detail=1). Absent from the
// status bar's own 3s poll.
export interface SystemStatsDetail {
  cpuCount: number;
  cpuModel: string;
  loadAvg: [number, number, number];
  // Zero on a box with no swap configured, which drops the row.
  swapTotalBytes: number;
  swapUsedBytes: number;
  disks: DiskUsage[];
  // null off Linux, and for the first reading after a server start.
  network: NetworkRates | null;
  uptimeSeconds: number;
  processCount: number | null;
  hostname: string;
  kernel: string;
}

export interface SystemStats {
  memTotalBytes: number;
  memUsedBytes: number;
  // Busy percentage across every core since the previous poll, or null on
  // the first reading after a server start — a percentage needs two samples
  // of a counter that only ever counts up.
  cpuPercent: number | null;
  detail?: SystemStatsDetail;
}

export interface SystemStatRow {
  id: string;
  // A codicon name for the row's leading glyph.
  icon: string;
  label: string;
  // Right-aligned in the heading row: a percentage where there's a ceiling to
  // measure against, empty where there isn't.
  value: string;
  // The bar under the heading, or null for a row with no ceiling (throughput
  // has no maximum to be a fraction of). A percent of null inside it means
  // the ratio isn't knowable yet — the track draws, the fill doesn't.
  meter: { percent: number | null } | null;
  // The figures under the meter.
  detail: string;
  // A quieter second line, when there's something worth saying (the CPU
  // model, which is interesting once and never again).
  note?: string;
}

// Guards the division as well as the range: a total of 0 (a pseudo-filesystem
// that reports no blocks) would otherwise render a NaN-wide bar.
export function percentOf(used: number, total: number): number | null {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null;
  return Math.min(100, Math.max(0, (used / total) * 100));
}

// How hard a row is being pushed, for the meter's color. Thresholds are
// deliberately late: a box at 70% memory is working, not in trouble, and a
// bar that turns orange at every build would stop meaning anything.
export function levelOf(percent: number | null): "normal" | "high" | "critical" {
  if (percent === null) return "normal";
  if (percent >= 90) return "critical";
  if (percent >= 75) return "high";
  return "normal";
}

// `many` for the nouns a trailing "s" gets wrong ("processes").
function plural(n: number, noun: string, many = `${noun}s`): string {
  return `${n} ${n === 1 ? noun : many}`;
}

function formatPercent(percent: number | null): string {
  return percent === null ? "—" : `${Math.round(percent)}%`;
}

function formatRate(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

// Coarse on purpose: an uptime is context, not a stopwatch. Days and hours
// once a box has been up a day, hours and minutes below that.
export function formatUptime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// A used/total pair as one row, the shape memory, swap and every disk share.
function usageRow(
  id: string,
  icon: string,
  label: string,
  used: number,
  total: number,
  // What a user can actually claim, where that is less than total - used.
  free: number,
): SystemStatRow {
  const percent = percentOf(used, used + free);
  return {
    id,
    icon,
    label,
    value: formatPercent(percent),
    meter: { percent },
    detail: `${formatBytes(used)} of ${formatBytes(total)} · ${formatBytes(free)} free`,
  };
}

export function systemStatRows(stats: SystemStats, detail: SystemStatsDetail): SystemStatRow[] {
  const rows: SystemStatRow[] = [
    {
      id: "cpu",
      icon: "pulse",
      label: "CPU",
      value: formatPercent(stats.cpuPercent),
      meter: { percent: stats.cpuPercent },
      detail: `${plural(detail.cpuCount, "core")} · load ${detail.loadAvg
        .map((n) => n.toFixed(2))
        .join("  ")}`,
      note: detail.cpuModel,
    },
    usageRow(
      "memory",
      "chip",
      "Memory",
      stats.memUsedBytes,
      stats.memTotalBytes,
      Math.max(0, stats.memTotalBytes - stats.memUsedBytes),
    ),
  ];

  // A box with swap off has no row rather than an empty one — most cloud
  // instances are that box, and a permanent 0% bar is noise.
  if (detail.swapTotalBytes > 0) {
    rows.push(
      usageRow(
        "swap",
        "arrow-swap",
        "Swap",
        detail.swapUsedBytes,
        detail.swapTotalBytes,
        Math.max(0, detail.swapTotalBytes - detail.swapUsedBytes),
      ),
    );
  }

  // Used against available, not against total: that's the ratio `df` prints,
  // and the one that answers "how much room is left".
  for (const disk of detail.disks) {
    rows.push(
      usageRow(`disk:${disk.path}`, "database", `Disk ${disk.path}`, disk.usedBytes, disk.totalBytes, disk.availableBytes),
    );
  }

  // No meter: throughput has no ceiling to be a fraction of, so the row is
  // the two rates and nothing else. Dropped entirely rather than shown empty
  // when there is no rate yet (off Linux, or a just-started server).
  if (detail.network) {
    rows.push({
      id: "network",
      icon: "arrow-both",
      label: "Network",
      value: "",
      meter: null,
      detail: `↓ ${formatRate(detail.network.rxBytesPerSec)}   ↑ ${formatRate(
        detail.network.txBytesPerSec,
      )}`,
    });
  }

  return rows;
}

// The popover's footer: which box this is and how long it has been up. One
// line, because none of it is worth a row of its own.
export function systemStatsSummary(detail: SystemStatsDetail): string {
  const parts = [detail.hostname, detail.kernel, `up ${formatUptime(detail.uptimeSeconds)}`];
  if (detail.processCount !== null) {
    parts.push(plural(detail.processCount, "process", "processes"));
  }
  return parts.filter(Boolean).join(" · ");
}
