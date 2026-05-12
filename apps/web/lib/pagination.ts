export type PaginationSearchParams = Record<string, string | string[] | undefined>;

export const DEFAULT_HISTORY_PAGE_SIZE = 10;

export interface PaginationState {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  skip: number;
  take: number;
  from: number;
  to: number;
}

export function getPaginationState(
  searchParams: object | undefined,
  pageParam: string,
  total: number,
  pageSize = DEFAULT_HISTORY_PAGE_SIZE
): PaginationState {
  const safeTotal = Math.max(0, total);
  const safePageSize = Math.max(1, pageSize);
  const totalPages = Math.max(1, Math.ceil(safeTotal / safePageSize));
  const params = searchParams as PaginationSearchParams | undefined;
  const requestedPage = readPage(params?.[pageParam]);
  const page = Math.min(requestedPage, totalPages);
  const skip = (page - 1) * safePageSize;
  const visibleCount = Math.max(0, Math.min(safePageSize, safeTotal - skip));
  return {
    page,
    pageSize: safePageSize,
    total: safeTotal,
    totalPages,
    skip,
    take: safePageSize,
    from: safeTotal === 0 ? 0 : skip + 1,
    to: safeTotal === 0 ? 0 : skip + visibleCount,
  };
}

export function paginationLabel(state: PaginationState, itemLabel = "件"): string {
  if (state.total === 0) return `0 ${itemLabel}`;
  return `${state.from}-${state.to} / ${state.total} ${itemLabel}`;
}

function readPage(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return 1;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}
