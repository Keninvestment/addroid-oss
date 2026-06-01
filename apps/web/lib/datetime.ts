import { languageToLocale, resolveAddroidLanguage } from "@addroid/config";

const DEFAULT_LOCALE = languageToLocale(resolveAddroidLanguage());
const FALLBACK_TIME_ZONE = "UTC";

export interface DateTimeFormatOptions {
  locale?: string;
  timeZone?: string | null;
  includeTimeZoneName?: boolean;
}

export function isValidTimeZone(timeZone: string | null | undefined): timeZone is string {
  if (!timeZone || typeof timeZone !== "string") return false;
  const trimmed = timeZone.trim();
  if (!trimmed) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed });
    return true;
  } catch {
    return false;
  }
}

export function resolveDisplayTimeZone(
  ...candidates: Array<string | null | undefined>
): string {
  const runtimeCandidates = [
    process.env.ADDROID_UI_TIMEZONE,
    process.env.ADDROID_USER_TIMEZONE,
    process.env.TZ,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    FALLBACK_TIME_ZONE,
  ];
  for (const candidate of [...candidates, ...runtimeCandidates]) {
    if (isValidTimeZone(candidate)) return candidate.trim();
  }
  return FALLBACK_TIME_ZONE;
}

export function resolveDisplayLocale(locale?: string | null): string {
  if (locale?.trim()) return locale.trim();
  if (process.env.ADDROID_UI_LOCALE?.trim()) return process.env.ADDROID_UI_LOCALE.trim();
  return DEFAULT_LOCALE;
}

export function formatDateTime(
  value: Date | string | number | null | undefined,
  options: DateTimeFormatOptions = {}
): string {
  if (value === null || value === undefined) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const timeZone = resolveDisplayTimeZone(options.timeZone);
  return new Intl.DateTimeFormat(resolveDisplayLocale(options.locale), {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
    ...(options.includeTimeZoneName === false ? {} : { timeZoneName: "short" }),
  }).format(date);
}

export function formatDateOnly(
  value: Date | string | number | null | undefined,
  options: DateTimeFormatOptions = {}
): string {
  if (value === null || value === undefined) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(resolveDisplayLocale(options.locale), {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: resolveDisplayTimeZone(options.timeZone),
  }).format(date);
}

export function formatStoredDateOnly(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value.slice(0, 10);
  if (Number.isNaN(value.getTime())) return "—";
  return value.toISOString().slice(0, 10);
}

export function formatIsoUtc(value: Date | string | number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toISOString().replace("T", " ").replace(/\..+$/, "Z");
}
