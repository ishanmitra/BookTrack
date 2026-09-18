import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import * as storage from "./storage";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const WINDOW_BEFORE = 3;
const WINDOW_AFTER = 10;
const LINK_ANNOTATION = 2;

function chapterForPage(page, toc) {
  let current = null;
  for (const c of toc) {
    if (c.startPage <= page) current = c;
    else break;
  }
  return current || (toc.length ? toc[0] : null);
}

function createSession() {
  return {
    sessionId: crypto.randomUUID(),
    deviceId: storage.getDeviceId(),
    startedAt: new Date().toISOString(),
    endedAt: null,
    secondsPerPage: {},
    readPages: [],
  };
}

function fmtClock(totalSeconds) {
  totalSeconds = Math.floor(totalSeconds || 0);
  const pad = (n) => String(n).padStart(2, "0");
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function chapterRefFor(n, toc) {
  const c = chapterForPage(n, toc);
  return c ? c.title : null;
}

async function loadAllRatios(pdf, concurrency = 8) {
  const ratios = new Array(pdf.numPages);
  let next = 0;
  const worker = async () => {
    while (next < pdf.numPages) {
      const n = next++;
      const p = await pdf.getPage(n + 1);
      const vp = p.getViewport({ scale: 1 });
      ratios[n] = vp.height / vp.width;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, pdf.numPages) }, worker));
  return ratios;
}

function pageFromOffset(scrollTop, offsets) {
  let lo = 0;
  let hi = offsets.length - 1;
  let best = 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] <= scrollTop) {
      best = mid + 1;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function markVisited(s, n) {
  if (s && !s.readPages.includes(n)) s.readPages.push(n);
}

export async function flattenOutline(pdf) {
  let outline = null;
  try {
    outline = await pdf.getOutline();
  } catch {
    return [];
  }
  if (!Array.isArray(outline)) return [];
  const rows = [];
  const visit = async (items, depth) => {
    for (const item of items) {
      let startPage = 1;
      if (item.dest) {
        try {
          const dest = typeof item.dest === "string" ? await pdf.getDestination(item.dest) : item.dest;
          if (Array.isArray(dest) && dest.length) startPage = (await pdf.getPageIndex(dest[0])) + 1;
        } catch {}
      }
      rows.push({ title: "  ".repeat(depth) + item.title, startPage });
      if (Array.isArray(item.items) && item.items.length) await visit(item.items, depth + 1);
    }
  };
  await visit(outline, 0);
  return rows;
}

export default forwardRef(function PdfReader({ file, book, onSessionEnd, onPagesKnown, onClose, signedIn, onNotice }, ref) {
  const scrollRef = useRef(null);
  const pdfRef = useRef(null);
  const sessionRef = useRef(null);
  const linkServiceRef = useRef(null);
  const drawnRef = useRef(new Map());
  const inflightRef = useRef(new Set());
  const ratiosRef = useRef([]);
  const offsetsRef = useRef([]);
  const pageRef = useRef(1);
  const jumpToRef = useRef(null);
  const endedRef = useRef(false);
  const positionedRef = useRef(false);
  const settlingRef = useRef(false);
  const rafRef = useRef(0);
  const fpRef = useRef(book?.fingerprint);
  fpRef.current = book?.fingerprint;
  const tocPageRef = useRef(null);
  const returnToRef = useRef(null);

  const [numPages, setNumPages] = useState(0);
  const numPagesRef = useRef(0);
  numPagesRef.current = numPages;
  const [ready, setReady] = useState(false);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(0.5);
  const [ratios, setRatios] = useState([]);
  const [pageWidth, setPageWidth] = useState(0);
  const [pageHeights, setPageHeights] = useState([]);
  const [sessionStats, setSessionStats] = useState({ seconds: 0, read: 0 });
  const [sessionState, setSessionState] = useState("idle");
  const [resizeTick, setResizeTick] = useState(0);
  const lastHeightRef = useRef(0);

  const toc = useMemo(() => (Array.isArray(book?.toc) ? book.toc : []), [book]);

  const endSession = useCallback(() => {
    const s = sessionRef.current;
    if (!s || endedRef.current) return;
    endedRef.current = true;
    s.endedAt = new Date().toISOString();
    storage.clearSession().catch(() => {});
    onSessionEnd({ ...s, readPages: [...s.readPages], fingerprint: fpRef.current });
    sessionRef.current = null;
    setSessionStats({ seconds: 0, read: 0 });
    setSessionState("idle");
    endedRef.current = false;
  }, [onSessionEnd]);

  const rolloverPending = useCallback(
    async (pdf) => {
      const pending = await storage.getPendingSession();
      if (pending && pending.sessionId && !pending.endedAt && !pending.paused) {
        pending.endedAt = new Date().toISOString();
        onSessionEnd({ ...pending, readPages: [...(pending.readPages || [])], fingerprint: fpRef.current });
        storage.clearSession().catch(() => {});
      }
    },
    [onSessionEnd]
  );

  const skipUnmountEndRef = useRef(false);

  const pause = useCallback(() => {
    const s = sessionRef.current;
    if (s && !s.paused) {
      s.paused = true;
      s.pausedAt = new Date().toISOString();
      s.bookKey = fpRef.current;
      storage.saveSession(s).catch(() => {});
      setSessionState("paused");
    }
    skipUnmountEndRef.current = true;
  }, []);

  const startSession = useCallback(() => {
    if (!signedIn) {
      onNotice?.("Sign in to start a reading session");
      return;
    }
    const s = sessionRef.current;
    if (s && s.paused) {
      delete s.paused;
      delete s.pausedAt;
      storage.saveSession(s).catch(() => {});
      setSessionState("running");
      return;
    }
    if (s) return;
    sessionRef.current = createSession();
    setSessionStats({ seconds: 0, read: 0 });
    storage.saveSession(sessionRef.current).catch(() => {});
    setSessionState("running");
  }, [signedIn, onNotice]);

  const markCurrent = useCallback(
    (n) => {
      if (settlingRef.current) return;
      const clamped = Math.max(1, Math.min(n, numPages || 1));
      pageRef.current = clamped;
      if (clamped !== page) setPage(clamped);
      markVisited(sessionRef.current, clamped);
      const fp = fpRef.current;
      if (fp) storage.saveLastPage(fp, clamped);
    },
    [numPages, page]
  );

  const load = useCallback(
    async (fileToLoad) => {
      setReady(false);
      const buf = await fileToLoad.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
      await rolloverPending(pdf);
      pdfRef.current = pdf;
      const r = await loadAllRatios(pdf);
      ratiosRef.current = r;
      setRatios(r);
      setNumPages(pdf.numPages);
      if (onPagesKnown) onPagesKnown(pdf.numPages);
      const fp = fpRef.current;
      const saved = fp ? storage.getLastPage(fp) : 1;
      const initial = Math.max(1, Math.min(saved, pdf.numPages));
      pageRef.current = initial;
      setPage(initial);
      positionedRef.current = false;
      endedRef.current = false;
      sessionRef.current = null;
      setSessionStats({ seconds: 0, read: 0 });
      const pending = await storage.getPendingSession();
      if (pending && pending.paused && pending.bookKey === fp && pending.sessionId) {
        sessionRef.current = pending;
        setSessionState("paused");
        setSessionStats({
          seconds: Object.values(pending.secondsPerPage || {}).reduce((a, b) => a + b, 0),
          read: (pending.readPages || []).length,
        });
      } else {
        setSessionState("idle");
      }
      setReady(true);
    },
    [rolloverPending, onPagesKnown]
  );

  useEffect(() => {
    let alive = true;
    load(file).catch((err) => {
      console.error("pdf load failed", err);
      setReady(false);
      onSessionEnd && onSessionEnd({ ...createSession(), sessionId: "load-failure", deviceId: storage.getDeviceId(), readPages: [] });
    });
    return () => {
      alive = false;
      pdfRef.current?.destroy().catch(() => {});
      pdfRef.current = null;
    };
  }, [file, load]);

  useEffect(() => {
    if (!ready || ratios.length === 0) return;
    const scroll = scrollRef.current;
    if (!scroll) return;
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = Math.max(1, Math.floor(scroll.clientWidth * zoom));
    const heights = ratios.map((r) => Math.max(1, Math.round(r * cssWidth)));
    const offsets = [0];
    for (let i = 0; i < heights.length; i++) offsets.push(offsets[i] + heights[i]);
    offsetsRef.current = offsets;
    const total = offsets[offsets.length - 1];
    if (lastHeightRef.current > 0 && total !== lastHeightRef.current) {
      scroll.scrollTop *= total / lastHeightRef.current;
    }
    lastHeightRef.current = total;
    setPageWidth(cssWidth);
    setPageHeights(heights);
    const lo = Math.max(1, pageRef.current - WINDOW_BEFORE);
    const hi = Math.min(numPages, pageRef.current + WINDOW_AFTER);
    const drawKey = `${cssWidth}:${dpr}`;
    for (let n = 1; n <= numPages; n++) {
      const el = scroll.querySelector(`[data-page="${n}"]`);
      if (!el) continue;
      const canvas = el.querySelector("canvas");
      if (!canvas) continue;
      if (n >= lo && n <= hi) {
        if (drawnRef.current.get(n) !== drawKey && !inflightRef.current.has(n)) {
          inflightRef.current.add(n);
          const textLayer = el.querySelector(".text-layer");
          const annotationLayerEl = el.querySelector(".annotation-layer");
          drawCanvas(pdfRef.current, n, canvas, textLayer, annotationLayerEl, cssWidth, dpr).finally(() =>
            inflightRef.current.delete(n)
          );
          drawnRef.current.set(n, drawKey);
        }
      } else if (drawnRef.current.has(n)) {
        canvas.width = 1;
        canvas.height = 1;
        const textLayer = el.querySelector(".text-layer");
        if (textLayer) {
          textLayer.innerHTML = "";
          textLayer.style.removeProperty("--scale-factor");
        }
        const annotationLayerEl = el.querySelector(".annotation-layer");
        if (annotationLayerEl) {
          annotationLayerEl.innerHTML = "";
          annotationLayerEl.style.removeProperty("--scale-factor");
        }
        drawnRef.current.delete(n);
      }
    }
  }, [ready, page, numPages, zoom, resizeTick, ratios]);

  useEffect(() => {
    if (!ready || pageHeights.length === 0 || positionedRef.current) return;
    const scroll = scrollRef.current;
    const offsets = offsetsRef.current;
    if (!scroll || offsets.length === 0) return;
    positionedRef.current = true;
    settlingRef.current = true;
    const targetTop = offsets[Math.max(0, Math.min(pageRef.current - 1, pageHeights.length - 1))] ?? 0;
    requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = targetTop;
      settlingRef.current = false;
    });
  }, [ready, pageHeights, pageWidth]);

  const onResize = useCallback(() => setResizeTick((t) => t + 1), []);

  useEffect(() => {
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [onResize]);

  function drawCanvas(pdf, n, canvas, textLayer, annotationLayerEl, cssWidth, dpr) {
    const skip = () => Promise.resolve();
    if (!pdf || !canvas || !textLayer || !annotationLayerEl) return skip();
    return pdf
      .getPage(n)
      .then(async (pdfPage) => {
        if (pdfRef.current !== pdf) return;
        const base = pdfPage.getViewport({ scale: 1 });
        const scale = (cssWidth * dpr) / base.width;
        const viewport = pdfPage.getViewport({ scale });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${viewport.width / dpr}px`;
        await pdfPage.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
        textLayer.style.setProperty("--scale-factor", cssWidth / base.width);
        const tl = new pdfjsLib.TextLayer({
          container: textLayer,
          textContentSource: await pdfPage.getTextContent(),
          viewport,
        });
        await tl.render();
        const annotations = await pdfPage.getAnnotations();
        const links = annotations.filter((d) => d.annotationType === LINK_ANNOTATION);
        annotationLayerEl.innerHTML = "";
        if (links.length) {
          annotationLayerEl.style.setProperty("--scale-factor", cssWidth / base.width);
          await new pdfjsLib.AnnotationLayer({
            div: annotationLayerEl,
            page: pdfPage,
            viewport,
          }).render({
            annotations: links,
            linkService: linkServiceRef.current,
            downloadManager: null,
            imageResourcesPath: "",
            renderForms: false,
            enableScripting: false,
            hasJSActions: false,
          });
        }
      })
      .catch((err) => {
        if (!(err instanceof DOMException)) console.error("page draw failed", n, err);
      });
  }

  const onScroll = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      const scroll = scrollRef.current;
      const offsets = offsetsRef.current;
      if (!scroll || offsets.length === 0 || settlingRef.current) return;
      const n = pageFromOffset(scroll.scrollTop, offsets);
      if (n !== pageRef.current) markCurrent(n);
    });
  }, [markCurrent]);

  const tocStartPage = toc.length ? Number(toc[0].startPage) || 1 : null;
  useEffect(() => {
    tocPageRef.current = tocStartPage;
    returnToRef.current = null;
  }, [tocStartPage]);

  const jumpTo = useCallback(
    (n) => {
      const target = Math.max(1, Math.min(n, numPages || 1));
      const from = pageRef.current;
      if (tocPageRef.current != null && from === tocPageRef.current && target !== tocPageRef.current) {
        tocPageRef.current = from;
      }
      const offsets = offsetsRef.current;
      if (!scrollRef.current || offsets.length === 0) return markCurrent(target);
      scrollRef.current.scrollTop = offsets[target - 1] ?? 0;
      markCurrent(target);
    },
    [markCurrent, numPages]
  );

  const toggleToc = useCallback(() => {
    const tocPage = tocPageRef.current;
    if (tocPage == null) return;
    if (pageRef.current === tocPage) {
      jumpTo(Math.max(1, returnToRef.current ?? 1));
    } else {
      returnToRef.current = pageRef.current;
      jumpTo(tocPage);
    }
  }, [jumpTo]);

  const getOutline = useCallback(async () => {
    return flattenOutline(pdfRef.current);
  }, []);

  const resetSession = useCallback(() => {
    sessionRef.current = null;
    setSessionStats({ seconds: 0, read: 0 });
    setSessionState("idle");
  }, []);

  useImperativeHandle(ref, () => ({ jumpTo, pause, startSession, resetSession, getOutline }), [jumpTo, pause, startSession, resetSession, getOutline]);
  jumpToRef.current = jumpTo;

  if (!linkServiceRef.current) {
    linkServiceRef.current = {
      eventBus: null,
      addLinkAttributes: (link, url, newWindow = false) => {
        // Only honor safe URI schemes. A crafted PDF can put `javascript:` or
        // `data:` in a link annotation; assigning it to href would run it in
        // this origin when clicked. Anything else is rendered as a dead link.
        if (/^(https?:|ftps?:|mailto:)/i.test((url || "").trim())) {
          link.href = url;
        } else {
          link.removeAttribute("href");
        }
        link.rel = "noopener";
        if (newWindow) link.target = "_blank";
        else link.removeAttribute("target");
      },
      getDestinationHash: () => "",
      getAnchorUrl: () => "",
      executeSetOCGState: () => {},
      executeNamedAction: (action) => {
        if (action === "FirstPage") jumpToRef.current?.(1);
        else if (action === "LastPage") jumpToRef.current?.(numPagesRef.current);
      },
      goToDestination: async (dest) => {
        const pdf = pdfRef.current;
        if (!pdf) return;
        try {
          if (typeof dest === "string") dest = await pdf.getDestination(dest);
          if (!Array.isArray(dest) || dest.length === 0) return;
          const idx = await pdf.getPageIndex(dest[0]);
          if (idx >= 0) jumpToRef.current?.(idx + 1);
        } catch (err) {
          console.error("go to destination failed", err);
        }
      },
    };
  }

  useEffect(() => {
    if (!ready || sessionState !== "running") return;
    const interval = setInterval(() => {
      const s = sessionRef.current;
      if (!s || s.paused) return;
      const p = pageRef.current;
      s.secondsPerPage[p] = (s.secondsPerPage[p] || 0) + 1;
      markVisited(s, p);
      setSessionStats({
        seconds: Object.values(s.secondsPerPage).reduce((a, b) => a + b, 0),
        read: s.readPages.length,
      });
      storage.saveSession(s).catch(() => {});
    }, 1000);
    return () => clearInterval(interval);
  }, [ready, sessionState]);

  useEffect(() => {
    const onKey = (e) => {
      const t = e.target;
      const interactive =
        t instanceof HTMLElement &&
        (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.tagName === "BUTTON" || t.isContentEditable);
      if (interactive) return;
      if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") {
        e.preventDefault();
        jumpTo(pageRef.current + 1);
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        jumpTo(pageRef.current - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [jumpTo]);

  useEffect(() => {
    const onHide = () => {
      const s = sessionRef.current;
      if (document.hidden && s && !s.paused) endSession();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [endSession]);

  useEffect(() => {
    return () => {
      if (skipUnmountEndRef.current) return;
      endSession();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sessionClock = fmtClock(sessionStats.seconds);
  const zoomPct = Math.round(zoom * 100);
  const cssW = pageWidth;
  const atToc = tocPageRef.current != null && page === tocPageRef.current;
  const chapter = ready ? chapterRefFor(page, toc) : null;

  const toolbarSlot = document.getElementById("reader-toolbar-slot");
  const toolbar = (
    <div className="reader-toolbar">
      <button onClick={() => jumpTo(page - 1)} disabled={page <= 1}>‹ Prev</button>
      <span className="page-indicator">
        Page {page} / {numPages || "…"}
        <input
          type="range"
          min={1}
          max={numPages || 1}
          value={page}
          onChange={(e) => jumpTo(Number(e.target.value))}
        />
        <input
          type="number"
          min={1}
          max={numPages || 1}
          value={page}
          onChange={(e) => jumpTo(Number(e.target.value))}
        />
      </span>
      <button onClick={() => jumpTo(page + 1)} disabled={page >= numPages}>Next ›</button>
      <span className="zoom-group">
        Zoom
        <button onClick={() => setZoom((z) => clampZoom(z - 0.25))}>−</button>
        <input
          type="range"
          min={50}
          max={300}
          step={10}
          value={zoomPct}
          onChange={(e) => setZoom(Number(e.target.value) / 100)}
        />
        <button onClick={() => setZoom((z) => clampZoom(z + 0.25))}>+</button>
        <span className="zoom-pct">{zoomPct}%</span>
      </span>
      <span className="session-stats">Session: {sessionClock} · {sessionStats.read} pages visited</span>
      <button className="session-btn session-start" onClick={startSession} disabled={sessionState !== "idle" && sessionState !== "paused"}>
        {sessionState === "paused" ? "Resume session" : "Start session"}
      </button>
      <button className="session-btn session-pause" onClick={pause} disabled={sessionState !== "running"}>Pause session</button>
      <button className="end-session" onClick={() => { endSession(); skipUnmountEndRef.current = true; onClose?.(); }} disabled={sessionState === "idle"}>End session</button>
    </div>
  );

  return (
    <div className="reader">
      {toolbarSlot ? createPortal(toolbar, toolbarSlot) : null}
      {!ready && <div className="reader-loading">Loading PDF…</div>}
      {ready && tocPageRef.current != null && chapter && (
        <button
          className="toc-badge"
          onClick={toggleToc}
          title={atToc ? "Back to last read page" : `Go to table of contents (p${tocPageRef.current})`}
        >
          {atToc ? "↩ " : "☰ "}
          {chapter}
        </button>
      )}
      <div className="reader-canvas" ref={scrollRef} onScroll={onScroll}>
        {ready &&
          Array.from({ length: numPages }, (_, i) => {
            const n = i + 1;
            return (
              <div
                key={n}
                data-page={n}
                className="pdf-page"
                style={{ height: pageHeights[n - 1] || "auto", width: cssW || undefined }}
              >
                <div className="pdf-frame">
                  <canvas />
                  <div className="text-layer" />
                  <div className="annotation-layer" />
                </div>
              </div>
            );
          })}
      </div>
    </div>
  );
});

function clampZoom(z) {
  return Math.max(0.5, Math.min(3, Math.round(z * 4) / 4));
}