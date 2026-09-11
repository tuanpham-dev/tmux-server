// What the status bar's memory reading opens: the same host counters the bar
// shows one of, with CPU, swap, disk and network beside them. Reads the
// shared stats store rather than a snapshot prop, so the meters keep moving
// while the popover is open even though the bar captured this node when it
// was clicked — and subscribing through useDetailedSystemStats is also what
// asks the server for the expensive half of the reading, for exactly as long
// as this is mounted.

import Icon from "./Icon";
import { levelOf, systemStatRows, systemStatsSummary } from "../lib/systemStats";
import { useDetailedSystemStats } from "../lib/systemStatsStore";

export default function SystemStatsPanel() {
  const stats = useDetailedSystemStats();

  if (!stats) {
    return <div className="system-stats-empty">Host statistics unavailable</div>;
  }
  // The first opening of the popover in a session, for the moment between
  // mounting and the detailed reading it just asked for.
  if (!stats.detail) {
    return <div className="system-stats-empty">Reading host statistics…</div>;
  }

  return (
    <div className="system-stats">
      {systemStatRows(stats, stats.detail).map((row) => (
        <div key={row.id} className="system-stats-row">
          <div className="system-stats-head">
            <Icon name={row.icon} />
            <span className="system-stats-label">{row.label}</span>
            <span className="system-stats-percent">{row.value}</span>
          </div>
          {/* The meter is decoration over the percentage right above it, so
              it stays out of the accessibility tree rather than repeating
              the number as a progressbar. */}
          {row.meter && (
            <div className="system-stats-meter" aria-hidden="true">
              <span
                className="system-stats-meter-fill"
                data-level={levelOf(row.meter.percent)}
                style={{ width: `${row.meter.percent ?? 0}%` }}
              />
            </div>
          )}
          <div className="system-stats-detail">{row.detail}</div>
          {row.note && <div className="system-stats-note">{row.note}</div>}
        </div>
      ))}
      <div className="system-stats-summary">{systemStatsSummary(stats.detail)}</div>
    </div>
  );
}
