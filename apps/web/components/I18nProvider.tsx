"use client";

import { createContext, useContext, type ReactNode } from "react";
import { webLiteral, webT, type WebLanguage } from "../lib/i18n";

const I18nContext = createContext<WebLanguage>("ja");

export function I18nProvider({
  language,
  children,
}: {
  language: WebLanguage;
  children: ReactNode;
}) {
  return <I18nContext.Provider value={language}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const language = useContext(I18nContext);
  return {
    language,
    literal: (value: string) => webLiteral(language, value),
    t: (key: string, values?: Record<string, string | number | null | undefined>) =>
      webT(language, key, values),
  };
}
