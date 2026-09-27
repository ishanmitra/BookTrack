// Loading placeholders for content that is still being fetched. Every block
// reserves roughly the footprint of the content it stands in for, so a section
// holds its height when the real data lands instead of shifting the page.

export function Skeleton({ className = "" }) {
  return <span className={`skeleton ${className}`.trim()} aria-hidden="true" />;
}

export function SkeletonList({ rows = 3, avatar = false }) {
  return (
    <div className="skeleton-list" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <div className="skeleton-row" key={i}>
          {avatar && <Skeleton className="skeleton-avatar" />}
          <div className="skeleton-row-main">
            <Skeleton />
            <Skeleton className="skeleton-line-short" />
          </div>
          <Skeleton className="skeleton-line-action" />
        </div>
      ))}
    </div>
  );
}
