import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "./api";

export default function BookInfo({ slug, thumb }) {
  const [book, setBook] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    api
      .getBookBySlug(slug)
      .then((b) => { if (alive) { setBook(b); setLoading(false); } })
      .catch((err) => { if (alive) { setError(err.message); setLoading(false); } });
    return () => { alive = false; };
  }, [slug]);

  if (loading) {
    return (
      <section className="book-info">
        <div className="book-info-card">
          <p className="muted">Loading…</p>
        </div>
      </section>
    );
  }

  if (error || !book) {
    return (
      <section className="book-info">
        <div className="book-info-card">
          <p className="muted">{error || "Book not found"}</p>
        </div>
      </section>
    );
  }

  return (
    <section className="book-info">
      <div className="book-info-card">
        <div className="book-info-head">
          {thumb && <img className="book-info-cover" src={thumb} alt="" />}
          <div className="book-info-details">
            <h1 className="book-info-title">{book.title}</h1>
            {book.author && <p className="book-info-author">{book.author}</p>}
            <div className="book-info-meta">
              {book.edition != null && <span>Edition {book.edition}</span>}
              {book.page_count != null && <span>{book.page_count} pages</span>}
              {book.pending ? <span className="pending-tag">pending review</span> : null}
            </div>
            {book.pending ? <p className="muted">This book is waiting for an admin to confirm it in the shared catalog — you can still read it.</p> : null}
          </div>
        </div>
        <Link className="primary" to={"/read/" + slug}>
          Read on this device
        </Link>
      </div>
    </section>
  );
}
