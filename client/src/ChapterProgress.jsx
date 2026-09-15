function pct(w) {
  return `${Math.max(0, Math.min(100, Math.round((w || 0) * 100)))}%`;
}

export default function ChapterProgress({ rows = [] }) {
  const doneCount = rows.filter((r) => r.span > 0 && r.visited >= r.span).length;
  const startedCount = rows.filter((r) => r.visited > 0).length;

  return (
    <div className="chapter-progress">
      <div className="chapter-progress-head">
        <strong>Chapter progress</strong>
        <span className="muted">
          {doneCount}/{rows.length || 0} done{startedCount ? ` · ${startedCount} started` : ""}
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="pageheatmap-empty">No chapters yet — add a TOC in Settings.</div>
      ) : (
        rows.map((r, i) => {
          const allRead = r.span > 0 && r.visited >= r.span;
          const state = allRead ? "done" : r.visited > 0 ? "active" : "idle";
          const p = allRead ? 1 : r.span ? r.visited / r.span : 0;
          return (
            <div className="chapter-progress-row" key={i}>
              <span className="cp-title" title={r.title || "Untitled"}>
                {r.title || "Untitled"}
              </span>
              <span className="cp-bar">
                <span className={`prog-bar prog-${state}`}>
                  <span className="prog-fill" style={{ width: pct(p) }} />
                </span>
              </span>
              <span className="cp-status">
                {allRead ? "✓ done" : r.visited > 0 ? `${r.visited}/${r.span}` : "not started"}
              </span>
            </div>
          );
        })
      )}
    </div>
  );
}