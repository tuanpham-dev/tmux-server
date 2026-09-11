// Byte counts as MB, for the upload size limit's settings copy and every
// message that reports a file was refused for being too big. Shared so the
// wire layer (api.ts's 413 mapping) and the upload pipeline (upload.ts's
// pre-flight check) can't drift apart in how they phrase a size.
export function formatMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

// Byte counts as GB, for the status bar's memory readout. One decimal keeps
// the number stable enough to read at a glance while it drifts.
export function formatGb(bytes: number): string {
  return (bytes / (1024 * 1024 * 1024)).toFixed(1);
}

// A byte count with whichever unit keeps it to two or three digits. The
// system-stats popover stacks memory (read in gigabytes) against disks that
// run to terabytes, so neither can hard-code its unit the way the status
// bar's own reading does.
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let n = Math.max(0, bytes);
  let unit = 0;
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024;
    unit++;
  }
  // Whole bytes have no fraction to show, and three digits are precise
  // enough without one — "512 GB" reads better than "512.0 GB".
  const decimals = unit === 0 || n >= 100 ? 0 : 1;
  return `${n.toFixed(decimals)} ${units[unit]}`;
}
