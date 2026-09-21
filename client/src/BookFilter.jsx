import { Fragment, useEffect, useMemo, useRef, useState } from "react";

const RECENT_KEY = "book-tracker:recent-book-filter";
const RECENT_LIMIT = 5;

// Searchable combobox over the profile's per-book stats. Replaces the plain
// <select> so the session log stays filterable once the library grows past a
// couple of books. Filtering is local — no API round-trip. The last 5 chosen
// books are remembered (localStorage) and shown as a "Recent" section.
function loadRecentSlugs() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((s) => s && typeof s === "string") : [];
  } catch {
    return [];
  }
}

export default function BookFilter({ books = [], value = "", onChange }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [recentSlugs, setRecentSlugs] = useState(loadRecentSlugs);
  const rootRef = useRef(null);

  const bySlug = useMemo(() => new Map(books.map((b) => [b.slug, b])), [books]);

  const recentBooks = useMemo(
    () => recentSlugs.map((s) => bySlug.get(s)).filter(Boolean).slice(0, RECENT_LIMIT),
    [recentSlugs, bySlug]
  );

  const trimmedQuery = query.trim();
  const hasQuery = trimmedQuery.length > 0;

  const results = useMemo(() => {
    const q = trimmedQuery.toLowerCase();
    if (!q) return [];
    return books.filter((b) => {
      const title = (b.title || b.slug || "").toLowerCase();
      const slug = (b.slug || "").toLowerCase();
      return title.includes(q) || slug.includes(q);
    });
  }, [books, trimmedQuery]);

  // Sections are stacked in the listbox. When typing, search results come
  // first with the recent books pinned beneath; with an empty query the
  // recents lead and the remaining catalog follows.
  const sections = useMemo(() => {
    if (hasQuery) {
      const out = [];
      if (results.length) out.push({ label: null, items: results });
      const recentBelow = recentBooks.filter((r) => !results.some((x) => x.slug === r.slug));
      if (recentBelow.length) out.push({ label: "Recent", items: recentBelow });
      return out;
    }
    if (recentBooks.length) {
      const recent = new Set(recentBooks.map((b) => b.slug));
      const rest = books.filter((b) => !recent.has(b.slug));
      const out = [{ label: "Recent", items: recentBooks }];
      if (rest.length) out.push({ label: "All books", items: rest });
      return out;
    }
    return [{ label: null, items: books }];
  }, [hasQuery, results, recentBooks, books]);

  const nav = useMemo(() => sections.flatMap((s) => s.items), [sections]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    setActive((a) => Math.min(Math.max(0, a), Math.max(0, nav.length - 1)));
  }, [nav.length]);

  const selected = books.find((b) => b.slug === value) || null;
  const label = selected ? selected.title || selected.slug || "Book" : "All books";

  const remember = (slug) => {
    setRecentSlugs((prev) => {
      const next = [slug, ...prev.filter((s) => s !== slug)].slice(0, RECENT_LIMIT);
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  };

  const choose = (b) => {
    onChange(b.slug ?? "");
    if (b.slug) remember(b.slug);
    setOpen(false);
    setQuery("");
    setActive(0);
  };

  const onKeyDown = (e) => {
    if (!open && (e.key === "ArrowDown" || e.key === "Enter")) {
      e.preventDefault();
      setQuery("");
      setActive(0);
      setOpen(true);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, nav.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (nav[active]) choose(nav[active]);
    } else if (e.key === "Escape") {
      setOpen(false);
      setQuery("");
    }
  };

  const clear = () => {
    onChange("");
    setQuery("");
    setOpen(false);
    setActive(0);
  };

  let navIndex = -1;

  return (
    <div className="book-filter" ref={rootRef}>
      <div className="book-filter-box">
        <svg className="book-filter-icon" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
          <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10.8 10.8 L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <input
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls="book-filter-list"
          aria-label="Filter by book"
          className="book-filter-input"
          value={open ? query : label}
          onFocus={() => setOpen(true)}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); setActive(0); }}
          onKeyDown={onKeyDown}
          placeholder="Search books"
        />
        {value && (
          <button type="button" className="book-filter-clear" onClick={clear} aria-label="Clear book filter">✕</button>
        )}
      </div>
      {open && (
        <ul id="book-filter-list" className="book-filter-list" role="listbox">
          {hasQuery && results.length === 0 && (
            <li className="book-filter-empty">No books match “{trimmedQuery}”</li>
          )}
          {sections.map((section, si) => (
            <Fragment key={si}>
              {section.label && <li className="book-filter-head">{section.label}</li>}
              {section.items.map((b) => {
                navIndex += 1;
                const idx = navIndex;
                return (
                  <li
                    key={b.book_id ?? b.slug}
                    role="option"
                    aria-selected={idx === active}
                    className={"book-filter-option" + (idx === active ? " active" : "") + (b.slug === value ? " chosen" : "")}
                    onMouseEnter={() => setActive(idx)}
                    onMouseDown={(e) => { e.preventDefault(); choose(b); }}
                  >
                    <span className="book-filter-title">{b.title || b.slug || "Book"}</span>
                    <span className="muted">{b.sessions} session{b.sessions === 1 ? "" : "s"}</span>
                  </li>
                );
              })}
            </Fragment>
          ))}
        </ul>
      )}
    </div>
  );
}