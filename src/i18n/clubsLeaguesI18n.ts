import { TRANSLATIONS } from './core';
import type { AppLanguage, TranslationSchema } from './types';

export type ClubLeagueLang = AppLanguage;
export type ClubLeagueCopy = TranslationSchema['clubLeagues'];

export const CLUB_LEAGUE_COPY: Record<ClubLeagueLang, ClubLeagueCopy> = {
  en: TRANSLATIONS.en.clubLeagues,
  ar: TRANSLATIONS.ar.clubLeagues,
};
