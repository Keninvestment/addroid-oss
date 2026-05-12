import Link from "next/link";
import type { PaginationSearchParams, PaginationState } from "../../lib/pagination";
import { paginationLabel } from "../../lib/pagination";

export function Pagination({
  basePath,
  searchParams,
  pageParam,
  state,
  itemLabel = "件",
}: {
  basePath: string;
  searchParams?: object;
  pageParam: string;
  state: PaginationState;
  itemLabel?: string;
}) {
  if (state.total === 0) return null;
  const canPrev = state.page > 1;
  const canNext = state.page < state.totalPages;
  return (
    <nav className="pagination" aria-label={`${pageParam} pagination`}>
      <span className="pagination__summary">{paginationLabel(state, itemLabel)}</span>
      <div className="pagination__controls">
        {canPrev ? (
          <Link className="btn btn--ghost btn--sm" href={pageHref(basePath, searchParams, pageParam, state.page - 1)}>
            前へ
          </Link>
        ) : (
          <span className="btn btn--ghost btn--sm" aria-disabled="true">
            前へ
          </span>
        )}
        <span className="pagination__page">
          {state.page} / {state.totalPages}
        </span>
        {canNext ? (
          <Link className="btn btn--ghost btn--sm" href={pageHref(basePath, searchParams, pageParam, state.page + 1)}>
            次へ
          </Link>
        ) : (
          <span className="btn btn--ghost btn--sm" aria-disabled="true">
            次へ
          </span>
        )}
      </div>
    </nav>
  );
}

function pageHref(
  basePath: string,
  searchParams: object | undefined,
  pageParam: string,
  page: number
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries((searchParams ?? {}) as PaginationSearchParams)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item);
    } else {
      params.set(key, value);
    }
  }
  if (page <= 1) {
    params.delete(pageParam);
  } else {
    params.set(pageParam, String(page));
  }
  const qs = params.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}
