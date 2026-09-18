import { useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { flattenOutline } from "./PdfReader";
import { slugify } from "./slug";
import TocTable from "./TocTable";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const THUMB_W = 168;

export default function BookWizard({
  file,
  bookId,
  meta,
  onMetaChange,
  toc,
  tocDirty,
  onAddChapter,
  onInsertChapter,
  onUpdateChapter,
  onRemoveChapter,
  onImportToc,
  onThumbnail,
  onSave,
  onCancel,
}) {
  const pdfRef = useRef(null);
  const [thumb, setThumb] = useState(null);
  const [thumbFailed, setThumbFailed] = useState(false);
  const [importMsg, setImportMsg] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);

  // Auto-fill slug from title until the user edits it manually.
  useEffect(() => {
    if (!slugTouched) onMetaChange({ slug: slugify(meta?.title ?? "") });
  }, [meta?.title, slugTouched]);

  useEffect(() => {
    let alive = true;
    file
      .arrayBuffer()
      .then((buf) => pdfjsLib.getDocument({ data: buf }).promise)
      .then(async (pdf) => {
        if (!alive) {
          pdf.destroy();
          return;
        }
        pdfRef.current = pdf;
        const page = await pdf.getPage(1);
        const base = page.getViewport({ scale: 1 });
        const scale = THUMB_W / base.width;
        const vp = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);
        await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
        const dataUrl = canvas.toDataURL("image/png");
        if (alive) {
          setThumb(dataUrl);
          onThumbnail(dataUrl);
        }
      })
      .catch((err) => {
        if (alive) {
          console.error("thumbnail failed", err);
          setThumbFailed(true);
        }
      });
    return () => {
      alive = false;
      pdfRef.current?.destroy().catch(() => {});
      pdfRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, bookId]);

  return (
    <div className="wizard-overlay">
      <div className="wizard">
        <div className="wizard-header">
          <div>
            <strong>Set up your book</strong>
            <span className="muted">Add details, table of contents, and a preview — you can change these later in Settings.</span>
          </div>
          <button onClick={onCancel} title="Cancel">✕</button>
        </div>
        <div className="wizard-body">
          {meta?.pending ? (
            <div className="wizard-notice">
              This is a new book — as a member it's <strong>pending admin review</strong> for the
              shared catalog. You can read and track it right away; an admin will confirm the
              catalog record.
            </div>
          ) : null}
          <div className="wizard-thumb-zone">
            {thumb ? (
              <img className="wizard-thumb" src={thumb} alt="First page preview" />
            ) : thumbFailed ? (
              <div className="wizard-thumb wizard-thumb-empty">Preview unavailable</div>
            ) : (
              <div className="wizard-thumb wizard-thumb-empty">Rendering preview…</div>
            )}
          </div>

          <section className="panel settings-section">
            <h2>Book metadata</h2>
            <div className="meta-grid">
              <label>
                Title
                <input value={meta?.title || ""} onChange={(e) => onMetaChange({ title: e.target.value })} />
              </label>
              <label>
                Slug
                <input
                  value={meta?.slug ?? ""}
                  onChange={(e) => {
                    setSlugTouched(true);
                    onMetaChange({ slug: slugify(e.target.value) });
                  }}
                  onBlur={(e) => onMetaChange({ slug: slugify(e.target.value) })}
                />
                <small className="muted">/book/{meta?.slug || "…"}</small>
              </label>
              <label>
                Author
                <input value={meta?.author || ""} onChange={(e) => onMetaChange({ author: e.target.value })} />
              </label>
              <label>
                Edition
                <input
                  type="number"
                  min={1}
                  value={meta?.edition ?? ""}
                  onChange={(e) => onMetaChange({ edition: Number(e.target.value) })}
                />
              </label>
            </div>
          </section>

          <section className="panel settings-section toc-panel">
            <h2>Table of contents <span className="muted">(optional)</span></h2>
            <TocTable
              rows={toc}
              onChange={onUpdateChapter}
              onRemove={onRemoveChapter}
              onAdd={onAddChapter}
              onInsert={onInsertChapter}
            />
            <div className="meta-actions">
              <button
                onClick={async () => {
                  if (!pdfRef.current) {
                    setImportMsg("PDF is still loading — try again in a moment.");
                    return;
                  }
                  const rows = await flattenOutline(pdfRef.current);
                  if (rows && rows.length) {
                    onImportToc(rows);
                    setImportMsg(`Imported ${rows.length} entries.`);
                  } else {
                    setImportMsg("No embedded outline found in this PDF.");
                  }
                }}
              >
                Import from PDF outline
              </button>
              <span className="muted">{importMsg}</span>
            </div>
          </section>
        </div>
        <div className="wizard-footer">
          <span className="muted">{tocDirty ? "Unsaved TOC changes" : ""}</span>
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={onSave}>Save & open</button>
        </div>
      </div>
    </div>
  );
}