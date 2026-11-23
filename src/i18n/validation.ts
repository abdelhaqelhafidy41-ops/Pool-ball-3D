import type { AppLanguage, PluralForms, TranslationSchema, TranslationTree } from './types';

export interface DictionaryValidationReport {
  ok: boolean;
  totalKeysEn: number;
  totalKeysAr: number;
  missingInAr: string[];
  missingInEn: string[];
  emptyValues: Array<{ lang: AppLanguage; key: string }>;
  placeholderMismatches: Array<{
    key: string;
    enPlaceholders: string[];
    arPlaceholders: string[];
  }>;
  mixedScriptSuspicious: Array<{ lang: AppLanguage; key: string; value: string }>;
}

const PLACEHOLDER_REGEX = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

function isPluralObject(val: unknown): val is PluralForms {
  return (
    typeof val === 'object' &&
    val !== null &&
    !Array.isArray(val) &&
    typeof (val as PluralForms).one === 'string' &&
    typeof (val as PluralForms).other === 'string'
  );
}

export function flattenTranslationTree(
  tree: TranslationTree | TranslationSchema,
  prefix = '',
  out: Record<string, string> = {},
): Record<string, string> {
  for (const [key, value] of Object.entries(tree)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') {
      out[fullKey] = value;
    } else if (isPluralObject(value)) {
      for (const formKey of ['zero', 'one', 'two', 'few', 'many', 'other'] as const) {
        const formVal = value[formKey];
        if (typeof formVal === 'string') {
          out[`${fullKey}.${formKey}`] = formVal;
        }
      }
    } else if (typeof value === 'object' && value !== null) {
      flattenTranslationTree(value as TranslationTree, fullKey, out);
    }
  }
  return out;
}

export function extractPlaceholders(template: string): string[] {
  const found = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER_REGEX)) {
    if (match[1]) found.add(match[1]);
  }
  return Array.from(found).sort();
}

export function validateTranslationDictionaries(
  enDict: TranslationTree | TranslationSchema,
  arDict: TranslationTree | TranslationSchema,
): DictionaryValidationReport {
  const flatEn = flattenTranslationTree(enDict);
  const flatAr = flattenTranslationTree(arDict);

  // Strip plural sub-key suffix when comparing logical keys so Arabic can use zero/two/few/many cleanly
  const normalizePluralLogicalKey = (k: string) =>
    k.replace(/\.(zero|one|two|few|many|other)$/, '');

  const logicalEn = new Set(Object.keys(flatEn).map(normalizePluralLogicalKey));
  const logicalAr = new Set(Object.keys(flatAr).map(normalizePluralLogicalKey));

  const missingInAr = Array.from(logicalEn).filter((k) => !logicalAr.has(k)).sort();
  const missingInEn = Array.from(logicalAr).filter((k) => !logicalEn.has(k)).sort();

  const emptyValues: Array<{ lang: AppLanguage; key: string }> = [];
  for (const [k, v] of Object.entries(flatEn)) {
    if (!v.trim()) emptyValues.push({ lang: 'en', key: k });
  }
  for (const [k, v] of Object.entries(flatAr)) {
    if (!v.trim()) emptyValues.push({ lang: 'ar', key: k });
  }

  // Check placeholder consistency for every shared logical key
  const placeholderMismatches: DictionaryValidationReport['placeholderMismatches'] = [];
  for (const [k, enVal] of Object.entries(flatEn)) {
    const arVal = flatAr[k];
    if (typeof arVal !== 'string') continue;
    const enPh = extractPlaceholders(enVal);
    const arPh = extractPlaceholders(arVal);
    const isImplicitCountPluralSubkey = /\.(zero|one|two)$/.test(k);
    const enCheck = isImplicitCountPluralSubkey ? enPh.filter((p) => p !== 'count') : enPh;
    const arCheck = isImplicitCountPluralSubkey ? arPh.filter((p) => p !== 'count') : arPh;
    if (enCheck.length !== arCheck.length || enCheck.some((p, i) => p !== arCheck[i])) {
      placeholderMismatches.push({
        key: k,
        enPlaceholders: enPh,
        arPlaceholders: arPh,
      });
    }
  }

  // Detect English entries containing Arabic script (except explicit bilingual language label)
  const mixedScriptSuspicious: DictionaryValidationReport['mixedScriptSuspicious'] = [];
  const allowedBilingualKeys = new Set([
    'meta.languageNameAr',
    'meta.switchToArabic',
    'meta.languageNameEn',
    'meta.switchToEnglish',
    'settings.languageSectionTitle',
  ]);
  for (const [k, v] of Object.entries(flatEn)) {
    if (allowedBilingualKeys.has(k)) continue;
    if (/[\u0600-\u06FF]/.test(v)) {
      mixedScriptSuspicious.push({ lang: 'en', key: k, value: v });
    }
  }

  return {
    ok:
      missingInAr.length === 0 &&
      missingInEn.length === 0 &&
      emptyValues.length === 0 &&
      placeholderMismatches.length === 0 &&
      mixedScriptSuspicious.length === 0,
    totalKeysEn: logicalEn.size,
    totalKeysAr: logicalAr.size,
    missingInAr,
    missingInEn,
    emptyValues,
    placeholderMismatches,
    mixedScriptSuspicious,
  };
}

const runtimeMissingKeys = new Set<string>();

export function recordMissingTranslationKey(lang: AppLanguage, key: string): void {
  const token = `${lang}:${key}`;
  if (!runtimeMissingKeys.has(token)) {
    runtimeMissingKeys.add(token);
  }
}

export function getRecordedMissingTranslationKeys(): string[] {
  return Array.from(runtimeMissingKeys).sort();
}

export function clearRecordedMissingTranslationKeys(): void {
  runtimeMissingKeys.clear();
}
