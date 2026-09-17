import { useMemo } from "react";

const PALETTE = ["#21262d", "#9be9a8", "#40c463", "#30a14e", "#216e39"];
const DAY_NAMES = ["Mon", "Wed", "Fri"];

function startOfWeekMonday(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day);
  return d;
}

function buildGrid(commits, weeksBack = 26) {
  const today = new Date();
  const start = startOfWeekMonday(today);
  start.setDate(start.getDate() - (weeksBack - 1) * 7);
  const pad2 = (n) => String(n).padStart(2, "0");
  const dateKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const startKey = dateKey(start);
  const todayKey = dateKey(today);

  const dayMinutes = {};
  let totalMinutes = 0;
  let sessionCount = 0;
  for (const c of commits || []) {
    const key = String(c.started_at || "").slice(0, 10);
    if (!key || key < startKey || key > todayKey) continue;
    const minutes = Number(c.minutes) || 0;
    totalMinutes += minutes;
    sessionCount += 1;
    dayMinutes[key] = (dayMinutes[key] || 0) + minutes;
  }

  const values = Object.values(dayMinutes);
  const max = values.length ? Math.max(...values) : 0;

  const columns = [];
  for (let w = 0; w < weeksBack; w++) {
    const week = [];
    for (let d = 0; d < 7; d++) {
      const date = new Date(start);
      date.setDate(start.getDate() + w * 7 + d);
      const key = dateKey(date);
      if (key > todayKey) break;
      const mins = dayMinutes[key] || 0;
      const level = max > 0 && mins > 0 ? 1 + Math.min(3, Math.floor((mins / max) * 4)) : 0;
      week.push({ date: key, minutes: mins, level });
    }
    if (week.length) columns.push(week);
  }
  return { columns, totalMinutes, sessionCount };
}

export default function Heatmap({ commits, weeksBack = 26, onSelectDay, selectedDay }) {
  const { columns, totalMinutes, sessionCount } = useMemo(() => buildGrid(commits, weeksBack), [commits, weeksBack]);

  return (
    <div className="heatmap">
      <div className="heatmap-header">
        <strong>{totalMinutes.toFixed(0)} min read</strong>
        <span>across {sessionCount} reading sessions</span>
        <button
          className={`day-filter-chip${selectedDay ? "" : " invisible"}`}
          onClick={() => onSelectDay?.(null)}
          title="Clear day filter"
        >
          <span className="chip-label">Filtering: {selectedDay || "\u00A0"}</span>
          <span className="chip-x" aria-hidden="true">✕</span>
        </button>
      </div>
      <div className="heatmap-body">
        <div className="heatmap-days">
          <span className="spacer" />
          {DAY_NAMES.map((d) => <span key={d}>{d}</span>)}
        </div>
        <div className="heatmap-scroll">
          <div className="heatmap-grid">
            {columns.map((week, wi) => (
              <div className="heatmap-week" key={wi}>
                {week.map((cell) => (
                  <div
                    key={cell.date}
                    className={`heatmap-cell${cell.minutes ? " clickable" : ""}${cell.date === selectedDay ? " selected" : ""}`}
                    style={{ backgroundColor: PALETTE[cell.level] }}
                    title={cell.minutes ? `${cell.date}: ${cell.minutes.toFixed(0)} min read` : cell.date}
                    onClick={() => cell.minutes && onSelectDay?.(cell.date === selectedDay ? null : cell.date)}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="heatmap-legend">
        Less
        {PALETTE.map((c) => <span key={c} style={{ backgroundColor: c }} />)}
        More
      </div>
    </div>
  );
}