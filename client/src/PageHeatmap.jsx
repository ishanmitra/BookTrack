import { useEffect, useMemo, useState } from "react";

const BOX = 11;
const GAP = 3;
const CHUNK = 25;
const PER_ROW = 25;
const PAGE_PALETTE = ["#21262d", "#3fb950", "#2da044", "#1f883d", "#0d5326"];

function buildPageStats(commits) {
  const pageSeconds = {};
  const visitedSet = new Set();
  for (const c of commits || []) {
    const pages = typeof c.pages === "string" ? JSON.parse(c.pages) : c.pages || {};
    const readPages = typeof c.read_pages === "string" ? JSON.parse(c.read_pages) : c.read_pages || [];
    for (const [p, secs] of Object.entries(pages)) {
      const n = Number(p);
      if (Number.isFinite(n)) pageSeconds[n] = (pageSeconds[n] || 0) + (Number(secs) || 0);
    }
    for (const p of readPages) visitedSet.add(Number(p));
  }
  return { pageSeconds, visitedSet };
}

function levelFor(seconds, max) {
  if (!seconds) return 0;
  return max > 0 ? 1 + Math.min(3, Math.floor((seconds / max) * 4)) : 0;
}

function formatSeconds(s) {
  s = Math.round(s || 0);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

export default function PageHeatmap({ pageCount, commits }) {
  const [collapsed, setCollapsed] = useState(true);
  const [rangeStart, setRangeStart] = useState(1);

  const { pageSeconds, visitedSet } = useMemo(() => buildPageStats(commits), [commits]);
  const total =
    (pageCount && Number.isFinite(pageCount) && pageCount > 0 ? pageCount : 0) ||
    Math.max(0, ...Object.keys(pageSeconds).map(Number)) ||
    0;

  useEffect(() => {
    setRangeStart(1);
  }, [pageCount]);

  const span = Math.max(0, total - rangeStart + 1);

  const maxSeconds = useMemo(() => {
    let max = 0;
    if (collapsed) {
      for (let p = 1; p <= total; p += CHUNK) {
        let v = 0;
        const end = Math.min(total, p + CHUNK - 1);
        for (let q = p; q <= end; q++) v += pageSeconds[q] || 0;
        if (v > max) max = v;
      }
    } else {
      for (let p = rangeStart; p <= total; p++) {
        if ((pageSeconds[p] || 0) > max) max = pageSeconds[p];
      }
    }
    return max;
  }, [pageSeconds, total, collapsed, rangeStart]);

  const cells = useMemo(() => {
    const list = [];
    if (collapsed) {
      for (let p = 1; p <= total; p += CHUNK) {
        const chunkEnd = Math.min(total, p + CHUNK - 1);
        let secs = 0;
        let visited = 0;
        for (let q = p; q <= chunkEnd; q++) {
          secs += pageSeconds[q] || 0;
          if (visitedSet.has(q)) visited++;
        }
        list.push({
          key: `c${p}`,
          header: p === 1 || p % 100 === 1 ? String(p) : "",
          title: `Pages ${p}–${chunkEnd} · ${formatSeconds(secs)} · ${visited} visited`,
          seconds: secs,
          visited,
        });
      }
      return list;
    }
    for (let p = rangeStart; p <= total; p++) {
      const secs = pageSeconds[p] || 0;
      list.push({
        key: `p${p}`,
        header: p === 1 || p % 100 === 1 ? String(p) : "",
        title: `Page ${p} · ${secs ? formatSeconds(secs) : "no time"}${visitedSet.has(p) ? " · visited" : ""}`,
        seconds: secs,
        visited: visitedSet.has(p),
      });
    }
    return list;
  }, [collapsed, rangeStart, total, pageSeconds, visitedSet]);

  const rows = useMemo(() => {
    if (collapsed) return [cells];
    const arr = [];
    for (let i = 0; i < cells.length; i += PER_ROW) arr.push(cells.slice(i, i + PER_ROW));
    return arr;
  }, [cells, collapsed]);

  return (
    <div className="pageheatmap">
      <div className="pageheatmap-header">
        <strong>Pages visited</strong>
        <span>
          {collapsed ? `${Math.ceil(total / CHUNK)} chunks of ${CHUNK} pages` : `${total} pages`}
        </span>
        <div className="pageheatmap-controls">
          {!collapsed && total > PER_ROW && rangeStart !== 1 && <button onClick={() => setRangeStart(1)}>All</button>}
          {!collapsed && total > PER_ROW && rangeStart > 1 && (
            <button onClick={() => setRangeStart((s) => Math.max(1, s - 100))}>−100</button>
          )}
          {!collapsed && total > PER_ROW && total - rangeStart > 100 && (
            <button onClick={() => setRangeStart((s) => Math.min(total, s + 100))}>+100</button>
          )}
          <button className={collapsed ? "active" : ""} onClick={() => setCollapsed((c) => !c)}>
            {collapsed ? "Expand" : "Collapse"}
          </button>
        </div>
      </div>

      {total === 0 ? (
        <div className="pageheatmap-empty">No page data yet — read a few pages to fill this in.</div>
      ) : (
        <>
          <div className="pageheatmap-wrap">
            {rows.map((row, ri) => (
              <div className="pageheatmap-row" key={ri}>
                <span className="row-label">{row[0]?.header || ""}</span>
                {row.map((cell) => (
                  <div
                    key={cell.key}
                    className={`pageheatmap-cell${cell.visited ? " visited" : ""}`}
                    style={{ backgroundColor: PAGE_PALETTE[levelFor(cell.seconds, maxSeconds)] }}
                    title={cell.title}
                  />
                ))}
              </div>
            ))}
          </div>
          <div className="pageheatmap-legend">
            <span>Dark = more time on page</span>
            <span className="read-key">◼ visited (any dwell)</span>
          </div>
        </>
      )}
    </div>
  );
}