export type SearchParamValue = string | string[] | undefined;

export function firstSearchParam(value: SearchParamValue): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

export function firstSearchParamOrNull(value: SearchParamValue): string | null {
  return firstSearchParam(value) ?? null;
}
