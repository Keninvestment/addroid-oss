export const SUPPORTED_ADDROID_LANGUAGES = ["ja", "en"] as const;

export type AddroidLanguage = (typeof SUPPORTED_ADDROID_LANGUAGES)[number];
export type AddroidLanguagePreference = AddroidLanguage | "auto";

export interface ResolveAddroidLanguageOptions {
  preference?: string | null;
  env?: NodeJS.ProcessEnv;
  acceptLanguage?: string | null;
  fallback?: AddroidLanguage;
}

const DEFAULT_LANGUAGE: AddroidLanguage = "ja";

export function normalizeAddroidLanguagePreference(
  value: string | null | undefined
): AddroidLanguagePreference | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase().replace("_", "-");
  if (!normalized) return null;
  if (normalized === "auto") return "auto";
  if (normalized === "ja" || normalized.startsWith("ja-")) return "ja";
  if (normalized === "en" || normalized.startsWith("en-")) return "en";
  return null;
}

export function resolveAddroidLanguage(
  options: ResolveAddroidLanguageOptions = {}
): AddroidLanguage {
  const fallback = options.fallback ?? DEFAULT_LANGUAGE;
  const explicit = normalizeAddroidLanguagePreference(options.preference);
  if (explicit && explicit !== "auto") return explicit;
  const env = options.env ?? process.env;
  for (const candidate of [
    env.ADDROID_LANG,
    env.ADDROID_LANGUAGE,
    env.ADDROID_UI_LANGUAGE,
    env.ADDROID_UI_LOCALE,
  ]) {
    const parsed = normalizeAddroidLanguagePreference(candidate);
    if (parsed && parsed !== "auto") return parsed;
  }
  const fromAcceptLanguage = detectLanguageFromAcceptLanguage(options.acceptLanguage);
  if (fromAcceptLanguage) return fromAcceptLanguage;
  const fromEnv = detectLanguageFromEnv(env);
  if (fromEnv) return fromEnv;
  return fallback;
}

export function detectLanguageFromEnv(
  env: NodeJS.ProcessEnv = process.env
): AddroidLanguage | null {
  for (const candidate of [env.LC_ALL, env.LC_MESSAGES, env.LANG]) {
    const parsed = normalizeAddroidLanguagePreference(candidate);
    if (parsed && parsed !== "auto") return parsed;
  }
  return null;
}

export function detectLanguageFromAcceptLanguage(
  value: string | null | undefined
): AddroidLanguage | null {
  if (!value?.trim()) return null;
  const candidates = value
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const qualityParam = params.find((param) => param.trim().startsWith("q="));
      const quality = qualityParam
        ? Number.parseFloat(qualityParam.split("=")[1] ?? "1")
        : 1;
      return { tag, quality: Number.isFinite(quality) ? quality : 1 };
    })
    .filter((item) => item.tag)
    .sort((a, b) => b.quality - a.quality);
  for (const candidate of candidates) {
    const parsed = normalizeAddroidLanguagePreference(candidate.tag);
    if (parsed && parsed !== "auto") return parsed;
  }
  return null;
}

export function languageToLocale(language: AddroidLanguage): string {
  return language === "en" ? "en-US" : "ja-JP";
}

export function languageToHtmlLang(language: AddroidLanguage): string {
  return language === "en" ? "en" : "ja";
}

export function languageLabel(language: AddroidLanguage): string {
  return language === "en" ? "English" : "日本語";
}

export type AddroidMessageDictionary = Record<AddroidLanguage, Record<string, string>>;

export function translateMessage(
  dictionary: AddroidMessageDictionary,
  language: AddroidLanguage,
  key: string,
  values: Record<string, string | number | null | undefined> = {}
): string {
  const template = dictionary[language]?.[key] ?? dictionary.ja?.[key] ?? key;
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) => {
    const value = values[name];
    return value === undefined || value === null ? match : String(value);
  });
}
