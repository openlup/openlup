import { z } from "../../validation/zod.js";
import {
  applyBlockingIssues,
  fieldIssue,
  type FieldValidationIssue,
  makeFieldResult,
  normalizeText,
  optionalByDefault,
  resolveFieldMode,
  type FieldValidationMode,
  type FieldSchema,
  type FieldValidationOptions,
  type FieldValidationResult,
} from "./modes.js";

export const supportedCountryIsoCodes = [
  "AT", "BE", "BG", "CH", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR",
  "GB", "GR", "HR", "HU", "IE", "IS", "IT", "LI", "LT", "LU", "LV", "MT",
  "NL", "NO", "PL", "PT", "RO", "SE", "SI", "SK", "US",
] as const;

export type SupportedCountryIsoCode = (typeof supportedCountryIsoCodes)[number];
export type CountryLabelLocale = "en" | "pl";

type CountryLabels = Readonly<Record<CountryLabelLocale, string>>;

export type CountryOption = Readonly<{
  iso: SupportedCountryIsoCode;
  label: CountryLabels;
  legacyLabel: CountryLabels;
}>;

const countryLabelsByLocale: Record<SupportedCountryIsoCode, CountryLabels> = {
  AT: { en: "Austria", pl: "Austria" },
  BE: { en: "Belgium", pl: "Belgia" },
  BG: { en: "Bulgaria", pl: "Bułgaria" },
  CH: { en: "Switzerland", pl: "Szwajcaria" },
  CY: { en: "Cyprus", pl: "Cypr" },
  CZ: { en: "Czechia", pl: "Czechy" },
  DE: { en: "Germany", pl: "Niemcy" },
  DK: { en: "Denmark", pl: "Dania" },
  EE: { en: "Estonia", pl: "Estonia" },
  ES: { en: "Spain", pl: "Hiszpania" },
  FI: { en: "Finland", pl: "Finlandia" },
  FR: { en: "France", pl: "Francja" },
  GB: { en: "United Kingdom", pl: "Wielka Brytania" },
  GR: { en: "Greece", pl: "Grecja" },
  HR: { en: "Croatia", pl: "Chorwacja" },
  HU: { en: "Hungary", pl: "Węgry" },
  IE: { en: "Ireland", pl: "Irlandia" },
  IS: { en: "Iceland", pl: "Islandia" },
  IT: { en: "Italy", pl: "Włochy" },
  LI: { en: "Liechtenstein", pl: "Liechtenstein" },
  LT: { en: "Lithuania", pl: "Litwa" },
  LU: { en: "Luxembourg", pl: "Luksemburg" },
  LV: { en: "Latvia", pl: "Łotwa" },
  MT: { en: "Malta", pl: "Malta" },
  NL: { en: "Netherlands", pl: "Holandia" },
  NO: { en: "Norway", pl: "Norwegia" },
  PL: { en: "Poland", pl: "Polska" },
  PT: { en: "Portugal", pl: "Portugalia" },
  RO: { en: "Romania", pl: "Rumunia" },
  SE: { en: "Sweden", pl: "Szwecja" },
  SI: { en: "Slovenia", pl: "Słowenia" },
  SK: { en: "Slovakia", pl: "Słowacja" },
  US: { en: "United States", pl: "Stany Zjednoczone" },
};

export const countryOptions: readonly CountryOption[] = supportedCountryIsoCodes.map<CountryOption>((iso) => ({
  iso,
  label: countryLabelsByLocale[iso],
  legacyLabel: countryLabelsByLocale[iso],
}));

const legacyCountryLabels: Record<SupportedCountryIsoCode, string[]> = {
  AT: [countryLabelsByLocale.AT.en],
  BE: [countryLabelsByLocale.BE.en, countryLabelsByLocale.BE.pl],
  BG: [countryLabelsByLocale.BG.en, countryLabelsByLocale.BG.pl],
  CH: [countryLabelsByLocale.CH.en, countryLabelsByLocale.CH.pl],
  CY: [countryLabelsByLocale.CY.en, countryLabelsByLocale.CY.pl],
  CZ: [countryLabelsByLocale.CZ.en, "Czech Republic", countryLabelsByLocale.CZ.pl],
  DE: [countryLabelsByLocale.DE.en, countryLabelsByLocale.DE.pl],
  DK: [countryLabelsByLocale.DK.en, countryLabelsByLocale.DK.pl],
  EE: [countryLabelsByLocale.EE.en],
  ES: [countryLabelsByLocale.ES.en, countryLabelsByLocale.ES.pl],
  FI: [countryLabelsByLocale.FI.en, countryLabelsByLocale.FI.pl],
  FR: [countryLabelsByLocale.FR.en, countryLabelsByLocale.FR.pl],
  GB: [countryLabelsByLocale.GB.en, "UK", "Great Britain", countryLabelsByLocale.GB.pl],
  GR: [countryLabelsByLocale.GR.en, countryLabelsByLocale.GR.pl],
  HR: [countryLabelsByLocale.HR.en, countryLabelsByLocale.HR.pl],
  HU: [countryLabelsByLocale.HU.en, countryLabelsByLocale.HU.pl, "Wegry"],
  IE: [countryLabelsByLocale.IE.en, countryLabelsByLocale.IE.pl],
  IS: [countryLabelsByLocale.IS.en, countryLabelsByLocale.IS.pl],
  IT: [countryLabelsByLocale.IT.en, countryLabelsByLocale.IT.pl, "Wlochy"],
  LI: [countryLabelsByLocale.LI.en],
  LT: [countryLabelsByLocale.LT.en, countryLabelsByLocale.LT.pl],
  LU: [countryLabelsByLocale.LU.en, countryLabelsByLocale.LU.pl],
  LV: [countryLabelsByLocale.LV.en, countryLabelsByLocale.LV.pl, "Lotwa"],
  MT: [countryLabelsByLocale.MT.en],
  NL: [countryLabelsByLocale.NL.en, "The Netherlands", countryLabelsByLocale.NL.pl],
  NO: [countryLabelsByLocale.NO.en, countryLabelsByLocale.NO.pl],
  PL: [countryLabelsByLocale.PL.pl, countryLabelsByLocale.PL.en],
  PT: [countryLabelsByLocale.PT.en, countryLabelsByLocale.PT.pl],
  RO: [countryLabelsByLocale.RO.en, countryLabelsByLocale.RO.pl],
  SE: [countryLabelsByLocale.SE.en, countryLabelsByLocale.SE.pl],
  SI: [countryLabelsByLocale.SI.en, countryLabelsByLocale.SI.pl, "Slowenia"],
  SK: [countryLabelsByLocale.SK.en, countryLabelsByLocale.SK.pl, "Slowacja"],
  US: [countryLabelsByLocale.US.en, "USA", "United States of America", countryLabelsByLocale.US.pl],
};

const supportedIsoSet = new Set<string>(supportedCountryIsoCodes);
const legacyLabelToIso = new Map<string, SupportedCountryIsoCode>(
  supportedCountryIsoCodes.flatMap((iso) => [
    [keyForCountryLabel(iso), iso],
    ...legacyCountryLabels[iso].map((label) => [keyForCountryLabel(label), iso] as const),
  ]),
);

export function normalizeCountryIso(value: unknown): string | null {
  const raw = normalizeText(value);
  if (!raw) return null;

  const upper = raw.toUpperCase();
  if (/^[A-Z]{2}$/.test(upper)) return upper;

  return legacyLabelToIso.get(keyForCountryLabel(raw)) ?? null;
}

export function countryLabelForIso(value: unknown, locale: CountryLabelLocale = "en"): string | null {
  const iso = normalizeCountryIso(value);
  if (!iso || !isSupportedCountryIso(iso)) return null;
  return countryLabelsByLocale[iso][locale];
}

export function legacyCountryLabelForIso(value: unknown, locale: CountryLabelLocale = "en"): string | null {
  const iso = normalizeCountryIso(value);
  if (!iso || !isSupportedCountryIso(iso)) return null;
  return countryLabelsByLocale[iso][locale];
}

export function isSupportedCountryIso(value: unknown): value is SupportedCountryIsoCode {
  const iso = normalizeCountryIso(value);
  return iso !== null && supportedIsoSet.has(iso);
}

export function isPolandCountry(value: unknown): boolean {
  return normalizeCountryIso(value) === "PL";
}

export function validateCountryField(
  value: unknown,
  options: FieldValidationOptions = {},
): FieldValidationResult<string> {
  const mode = resolveFieldMode(options.mode);
  const required = optionalByDefault(options.required);
  const raw = normalizeText(value);
  const iso = normalizeCountryIso(raw);
  const issues: FieldValidationIssue[] = [];

  if (!raw && required) {
    issues.push(fieldIssue("required", "forms:fields.country.required", mode));
  } else if (raw && (!iso || !supportedIsoSet.has(iso))) {
    issues.push(fieldIssue("invalid", "forms:fields.country.invalid", mode));
  }

  return makeFieldResult(iso ?? raw, issues);
}

export function countryFieldSchema(options: FieldValidationOptions = {}): FieldSchema<string> {
  return z
    .unknown()
    .transform((value) => validateCountryField(value, options))
    .superRefine((result, ctx) => applyBlockingIssues(ctx, result.issues))
    .transform((result) => result.value);
}

export function countrySchemaForMode(mode: FieldValidationMode): FieldSchema<string> {
  return countryFieldSchema({ mode });
}

function keyForCountryLabel(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");
}
