import { useCallback } from 'react';
import { useGameStore } from '../store/useGameStore';
import {
  applyDocumentLocale,
  formatLastSeenLocalized,
  formatLocalizedDate,
  formatLocalizedDateTime,
  formatLocalizedDuration,
  formatLocalizedNumber,
  getActiveRuntimeLanguage,
  getDirectionForLanguage,
  tLang,
} from './core';
import type { AppLanguage, TextDirection, TranslationParams } from './types';

export * from './types';
export * from './validation';
export * from './core';

export function t(key: string, params?: TranslationParams, langOverride?: AppLanguage): string {
  const lang = langOverride ?? useGameStore.getState().language ?? getActiveRuntimeLanguage();
  return tLang(lang, key, params);
}

export interface TranslationHookResult {
  lang: AppLanguage;
  language: AppLanguage;
  dir: TextDirection;
  isRtl: boolean;
  setLanguage: (lang: AppLanguage) => void;
  t: (key: string, params?: TranslationParams) => string;
  formatNumber: (value: number) => string;
  formatDate: (ms: number) => string;
  formatDateTime: (ms: number) => string;
  formatDuration: (sec: number) => string;
  formatLastSeen: (ms: number | null) => string;
}

export function useTranslation(): TranslationHookResult {
  const lang = useGameStore((s) => s.language);
  const setLanguage = useGameStore((s) => s.setLanguage);
  const dir = getDirectionForLanguage(lang);

  const translate = useCallback(
    (key: string, params?: TranslationParams) => tLang(lang, key, params),
    [lang],
  );

  const formatNumber = useCallback(
    (value: number) => formatLocalizedNumber(value, lang),
    [lang],
  );

  const formatDate = useCallback(
    (ms: number) => formatLocalizedDate(ms, lang),
    [lang],
  );

  const formatDateTime = useCallback(
    (ms: number) => formatLocalizedDateTime(ms, lang),
    [lang],
  );

  const formatLastSeen = useCallback(
    (ms: number | null) => formatLastSeenLocalized(ms, lang),
    [lang],
  );

  return {
    lang,
    language: lang,
    dir,
    isRtl: dir === 'rtl',
    setLanguage,
    t: translate,
    formatNumber,
    formatDate,
    formatDateTime,
    formatDuration: formatLocalizedDuration,
    formatLastSeen,
  };
}

export const useI18n = useTranslation;

// Keep document locale synced on store load in browser environments
if (typeof document !== 'undefined') {
  applyDocumentLocale(useGameStore.getState().language);
}
