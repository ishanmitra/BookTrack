import { Fragment, useRef } from "react";

function InsertHandle({ onClick }) {
  return (
    <button type="button" className="toc-insert" title="Insert chapter here" onClick={onClick}>
      <span className="toc-insert-plus">+</span>
    </button>
  );
}

export default function TocTable({ rows, onChange, onRemove, onAdd, onInsert }) {
  const refs = useRef({});
  const moveDown = (i, field) => {
    const next = refs.current[`${i + 1}:${field}`];
    if (next) {
      next.focus();
      next.select();
    }
  };
  const handleInsert = (i) => {
    onInsert(i);
    setTimeout(() => {
      const el = refs.current[`${i}:title`];
      if (el) {
        el.focus();
        el.select();
      }
    }, 0);
  };

  return (
    <div className="toctable">
      <div className="toctable-head">
        <span className="c-idx">#</span>
        <span className="c-title">Chapter</span>
        <span className="c-start">Start</span>
        <span className="c-pages">Pages</span>
        <span className="c-del" />
      </div>
      {rows.map((r, i) => (
        <Fragment key={i}>
          <InsertHandle onClick={() => handleInsert(i)} />
          <div className="toctable-row">
          <span className="c-idx">{i + 1}</span>
          <input
            ref={(el) => { refs.current[`${i}:title`] = el; }}
            className={`c-title${r.title ? "" : " empty"}`}
            value={r.title}
            placeholder="Chapter name"
            onChange={(e) => onChange(i, { title: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); moveDown(i, "title"); }
            }}
          />
          <input
            ref={(el) => { refs.current[`${i}:start`] = el; }}
            className="c-start"
            type="number"
            min={1}
            value={r.startPage}
            onChange={(e) => onChange(i, { startPage: Number(e.target.value) })}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); moveDown(i, "start"); }
            }}
          />
          <span className="c-pages">{r.span > 0 ? r.span : "—"}</span>
          <button type="button" className="danger c-del" title="Remove chapter" onClick={() => onRemove(i)}>✕</button>
        </div>
        </Fragment>
      ))}
      <div className="toctable-add">
        <button onClick={onAdd}>+ Add chapter</button>
      </div>
    </div>
  );
}