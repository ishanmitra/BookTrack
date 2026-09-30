import { useEffect, useState } from "react";
import api from "./api";
import { SkeletonList } from "./Skeleton";

// Search-to-promote for the Roles panel. The panel itself lists only admins, so
// this is how a plain member gets elevated: a name lookup against the member
// pool, then an explicit Promote per match. Promotion is a privileged action, so
// it is a button on a row you can read rather than Enter-to-commit on a
// highlighted result.
const SEARCH_LIMIT = 20;
const MIN_QUERY = 2;
const DEBOUNCE_MS = 200;

export default function PromoteMember({ onPromote, onError }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  // Match ids with a promote in flight, so each row disables only itself.
  const [pending, setPending] = useState(() => new Set());

  const markPending = (id, on) =>
    setPending((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const trimmed = query.trim();
  const canSearch = trimmed.length >= MIN_QUERY;

  useEffect(() => {
    if (!canSearch) {
      setResults([]);
      setSearching(false);
      return;
    }
    let alive = true;
    setSearching(true);
    const timer = setTimeout(() => {
      api
        .adminUsers({ role: "member", q: trimmed, limit: SEARCH_LIMIT })
        .then((rows) => {
          if (alive) setResults(rows);
        })
        .catch((e) => {
          if (!alive) return;
          setResults([]);
          if (onError) onError(e);
        })
        .then(() => {
          if (alive) setSearching(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [trimmed, canSearch, onError]);

  // The search stays open with the row held on Promoting until the PATCH settles,
  // so the user can see the action land rather than have the list vanish under
  // their cursor. A failure keeps the search open — the notice carries the error
  // and the button comes back, so the promote can be retried. On success the
  // clear below unmounts the list in the same render, so there is no frame where
  // a re-enabled button is visible against a list that is about to disappear.
  const promote = async (m) => {
    if (pending.has(m.id)) return;
    markPending(m.id, true);
    const ok = await onPromote(m);
    markPending(m.id, false);
    if (!ok) return;
    setQuery("");
    setResults([]);
  };

  return (
    <div className="promote">
      <div className="promote-box">
        <svg className="promote-icon" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
          <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10.8 10.8 L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <input
          type="text"
          className="promote-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Promote a member by username…"
          aria-label="Search members to promote"
          autoComplete="off"
        />
        {query && (
          <button type="button" className="promote-clear" onClick={() => setQuery("")} aria-label="Clear member search">
            ✕
          </button>
        )}
      </div>
      {canSearch &&
        (searching ? (
          <SkeletonList rows={1} avatar />
        ) : results.length === 0 ? (
          <p className="hint">No members match “{trimmed}”.</p>
        ) : (
          <>
            <ul className="admin-list promote-results">
              {results.map((m) => {
                const busy = pending.has(m.id);
                return (
                  <li key={m.id} className="admin-row admin-user-row">
                    <div className="admin-row-main admin-user-main">
                      {m.avatar_url && <img className="user-avatar admin-user-avatar" src={m.avatar_url} alt="" />}
                      <div className="admin-user-id">
                        <strong>{m.display_name || m.username}</strong>
                        <span className="muted">@{m.username}</span>
                      </div>
                    </div>
                    <button
                      className="primary"
                      onClick={() => promote(m)}
                      disabled={busy}
                      aria-label={`${busy ? "Promoting" : "Promote"} ${m.username}`}
                    >
                      {busy ? "Promoting…" : "Promote"}
                    </button>
                  </li>
                );
              })}
            </ul>
            {results.length >= SEARCH_LIMIT && (
              <p className="hint">Showing the first {SEARCH_LIMIT} — keep typing to narrow.</p>
            )}
          </>
        ))}
    </div>
  );
}
