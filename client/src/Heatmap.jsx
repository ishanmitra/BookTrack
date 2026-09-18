import { useLayoutEffect, useMemo, useRef, useState } from "react";

const PALETTE = ["#21262d", "#9be9a8", "#40c463", "#30a14e", "#216e39"];
const DAY_NAMES = ["Mon", "Wed", "Fri"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

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

const fmtDate = (iso) =>
  new Date(iso + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" });

export default function Heatmap({ commits, weeksBack = 26, onSelectDay, selectedDay }) {
  const { columns, totalMinutes, sessionCount } = useMemo(() => buildGrid(commits, weeksBack), [commits, weeksBack]);
  const heatRef = useRef(null);
  const tipRef = useRef(null);
  const [tip, setTip] = useState(null);
  const [tipPos, setTipPos] = useState({ left: -999, top: -999 });

  useLayoutEffect(() => {
    if (!tip || !tipRef.current || !heatRef.current) return;
    const rect = heatRef.current.getBoundingClientRect();
    const w = tipRef.current.offsetWidth;
    const h = tipRef.current.offsetHeight;
    let left = tip.x + 12;
    if (left + w > rect.width - 4) left = tip.x - w - 12;
    let top = tip.y - h - 10;
    if (top < 4) top = tip.y + 14;
    top = Math.min(top, rect.height - h - 4);
    setTipPos({ left: Math.max(4, left), top: Math.max(4, top) });
  }, [tip]);

  const monthLabels = useMemo(() => {
    const out = [];
    for (let wi = 0; wi < columns.length; wi++) {
      const m = columns[wi].length ? Number(columns[wi][0].date.slice(5, 7)) : 0;
      const prevM = wi > 0 && columns[wi - 1].length ? Number(columns[wi - 1][0].date.slice(5, 7)) : m;
      out.push(wi === 0 || m !== prevM ? MONTHS[m - 1] : "");
    }
    return out;
  }, [columns]);

  const onHover = (e, cell) => {
    const el = heatRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setTip({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      text: cell.minutes
        ? `${fmtDate(cell.date)} — ${cell.minutes.toFixed(0)} min read`
        : `${fmtDate(cell.date)} — no reading`,
    });
  };

  return (
    <div className="heatmap" ref={heatRef}>
      {tip && (
        <div className="heatmap-tooltip" ref={tipRef} style={{ left: tipPos.left, top: tipPos.top }}>
          {tip.text}
        </div>
      )}
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
          <div className="heatmap-months">
            {monthLabels.map((label, wi) => (
              <span key={wi} className={`heatmap-month${label ? " has-label" : ""}`}>{label}</span>
            ))}
          </div>
          <div className="heatmap-grid">
            {columns.map((week, wi) => (
              <div className="heatmap-week" key={wi}>
                {week.map((cell) => (
                  <div
                    key={cell.date}
                    className={`heatmap-cell${cell.minutes ? " clickable" : ""}${cell.date === selectedDay ? " selected" : ""}`}
                    style={{ backgroundColor: PALETTE[cell.level] }}
                    onMouseMove={(e) => onHover(e, cell)}
                    onMouseLeave={() => setTip(null)}
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