import { useEffect, useState } from "react";
import api from "./api";
import { Skeleton, SkeletonList } from "./Skeleton";

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString();
}

function sortUsers(list) {
  return [...list].sort((a, b) => {
    if (a.role === "super_admin") return -1;
    if (b.role === "super_admin") return 1;
    return a.username.localeCompare(b.username, undefined, { sensitivity: "base" });
  });
}

export default function AdminPage({ onAccountDeleted }) {
  const [pending, setPending] = useState([]);
  const [retired, setRetired] = useState([]);
  const [users, setUsers] = useState([]);
  const [notice, setNotice] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [role, setRole] = useState(null);
  const [showTransfer, setShowTransfer] = useState(false);

  // Per-section loading flags. `loading` drives the skeleton; `loaded` records
  // that a section has resolved once, so a refresh triggered by an action keeps
  // the rows already on screen instead of flashing a skeleton and jumping.
  const [roleLoading, setRoleLoading] = useState(true);
  const [pendingLoading, setPendingLoading] = useState(true);
  const [retiredLoading, setRetiredLoading] = useState(true);
  const [usersLoading, setUsersLoading] = useState(false);
  const [loaded, setLoaded] = useState({ pending: false, retired: false, users: false });

  const skeleton = (section, loading) => loading && !loaded[section];

  // The signed-in admin's role (boolean is_admin only, per public contract).
  // Fetched in parallel with the catalog sections; it only gates the super-admin
  // bits further down.
  useEffect(() => {
    let alive = true;
    api.adminRole()
      .then((r) => { if (alive) setRole(r.role); })
      .catch((e) => { if (alive) setNotice(e.message); })
      .finally(() => { if (alive) setRoleLoading(false); });
    return () => { alive = false; };
  }, []);

  // Catalog review + retired catalog, requested together and settled
  // independently: one slow (or failing) section never holds up the other.
  useEffect(() => {
    let alive = true;
    const settle = (section) => () => {
      if (!alive) return;
      if (section === "pending") setPendingLoading(false);
      else setRetiredLoading(false);
      setLoaded((l) => ({ ...l, [section]: true }));
    };
    setPendingLoading(true);
    setRetiredLoading(true);
    api.pendingBooks()
      .then((p) => { if (alive) setPending(p); })
      .catch((e) => { if (alive) setNotice(e.message); })
      .then(settle("pending"));
    api.retiredBooks()
      .then((r) => { if (alive) setRetired(r); })
      .catch((e) => { if (alive) setNotice(e.message); })
      .then(settle("retired"));
    return () => { alive = false; };
  }, [refreshKey]);

  // Super-admin only, so it can't join the batch above — it waits on the role.
  useEffect(() => {
    if (role !== "super_admin") return;
    let alive = true;
    setUsersLoading(true);
    api.adminUsers()
      .then((u) => { if (alive) setUsers(sortUsers(u)); })
      .catch((e) => { if (alive) setNotice(e.message); })
      .then(() => {
        if (!alive) return;
        setUsersLoading(false);
        setLoaded((l) => ({ ...l, users: true }));
      });
    return () => { alive = false; };
  }, [role, refreshKey]);

  const isSuper = role === "super_admin";

  const act = async (fn, okMsg) => {
    try {
      await fn();
      setNotice(okMsg);
      setRefreshKey((k) => k + 1);
    } catch (e) {
      setNotice(e.message);
    }
  };

  const bind = (fp) =>
    act(() => api.bindBook(fp.fingerprint_id), `Bound "${fp.title}".`);

  const reactivate = (w) =>
    act(() => api.reactivateBook(w.id), `Reactivated "${w.title}".`);

  const changeRole = (u, role) =>
    act(() => api.setUserRole(u.id, role), `${u.username} is now ${role}.`);

  const deleteAccount = () => {
    if (!window.confirm("Delete your account and reading history permanently? This cannot be undone.")) return;
    api
      .deleteMe()
      .then(() => onAccountDeleted && onAccountDeleted())
      .catch((e) => setNotice(e.message));
  };

  return (
    <section className="admin-page">
      {notice && <div className="notice" onClick={() => setNotice("")}>{notice}</div>}
      <header className="library-top">
        <h1>Control Panel</h1>
      </header>

      <section className="panel settings-section catalog-review" aria-busy={pendingLoading || undefined}>
        <h2>Catalog review <span className="muted">(pending uploads)</span></h2>
        {skeleton("pending", pendingLoading) ? (
          <SkeletonList rows={3} />
        ) : pending.length === 0 ? (
          <p className="hint">No fingerprints waiting for review.</p>
        ) : (
          <ul className="admin-list">
            {pending.map((fp) => (
              <li key={fp.fingerprint_id} className="admin-row">
                <div className="admin-row-main">
                  <strong>{fp.title || "Untitled"}</strong>
                  {fp.author && <span className="muted">{fp.author}</span>}
                  <span className="muted">by {fp.username}</span>
                  <span className="muted">{fp.edition != null ? `edition ${fp.edition}` : ""} · {fp.page_count != null ? `${fp.page_count} pages` : ""}</span>
                  <span className="muted">{fmtTime(fp.created_at)}</span>
                </div>
                <button className="primary" onClick={() => bind(fp)}>Bind</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel settings-section retired-section" aria-busy={retiredLoading || undefined}>
        <h2>Retired Catalog <span className="muted">(hidden, histories kept)</span></h2>
        {skeleton("retired", retiredLoading) ? (
          <SkeletonList rows={2} />
        ) : retired.length === 0 ? (
          <p className="hint">No retired works.</p>
        ) : (
          <ul className="admin-list">
            {retired.map((w) => (
              <li key={w.id} className="admin-row">
                <div className="admin-row-main">
                  <strong>{w.title || w.slug}</strong>
                  <span className="muted">/{w.slug}</span>
                </div>
                <button onClick={() => reactivate(w)}>Reactivate</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {isSuper && (
        <section className="panel settings-section users-section" aria-busy={usersLoading || undefined}>
          <h2>Roles</h2>
          {skeleton("users", usersLoading) ? (
            <SkeletonList rows={3} avatar />
          ) : (
            <ul className="admin-list">
              {users.map((u) => (
                <li key={u.id} className="admin-row admin-user-row">
                  <div className="admin-row-main admin-user-main">
                    {u.avatar_url && <img className="user-avatar admin-user-avatar" src={u.avatar_url} alt="" />}
                    <div className="admin-user-id">
                      <strong>{u.display_name || u.username}</strong>
                      <span className="muted">@{u.username}</span>
                    </div>
                  </div>
                  <div className="admin-row-actions">
                    <span className={`role-chip ${u.role === "super_admin" ? "role-admin" : `role-${u.role}`}`}>
                      {u.role === "super_admin" ? "admin" : u.role}
                    </span>
                    {u.role !== "super_admin" && (
                      <select
                        value={u.role}
                        onChange={(e) => changeRole(u, e.target.value)}
                        aria-label={`Role for ${u.username}`}
                      >
                        <option value="member">member</option>
                        <option value="admin">admin</option>
                      </select>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="panel settings-section danger-zone" aria-busy={roleLoading || undefined}>
        <h2>Account</h2>
        {roleLoading ? (
          <div className="danger-row">
            <Skeleton className="skeleton-line-grow" />
            <Skeleton className="skeleton-line-action" />
          </div>
        ) : isSuper ? (
          <>
            <div className="danger-row">
              <span>
                You are the Super Admin. Hand over ownership to someone else before you can delete
                your account.
              </span>
              <button className="danger" disabled title="Transfer ownership first">Delete my account</button>
            </div>
            <div className="danger-row">
              <span>Transfer ownership — you'll become an ordinary admin.</span>
              <button className="danger" onClick={() => setShowTransfer(true)}>Transfer ownership</button>
            </div>
          </>
        ) : (
          <div className="danger-row">
            <span>Delete your account and all reading history. This cannot be undone.</span>
            <button className="danger" onClick={deleteAccount}>Delete my account</button>
          </div>
        )}
      </section>

      {showTransfer && (
        <div className="admin-modal-overlay" onClick={() => setShowTransfer(false)}>
          <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
            <div className="admin-modal-header">
              <strong>Transfer ownership</strong>
              <button onClick={() => setShowTransfer(false)} title="Close">✕</button>
            </div>
            <div className="admin-modal-body">
              <p>Ah, the crown! Handing it off is still on our shelf — right between "fix the heatmap" and "read more books".</p>
              <p className="muted">We're working on it. Until then the throne has only one seat, and it's yours. Pat yourself on the back, Super Admin.</p>
            </div>
            <div className="admin-modal-footer">
              <button className="primary" onClick={() => setShowTransfer(false)}>Got it</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}