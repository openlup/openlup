import { z } from "../../validation/zod.js";
import { DOG_BREED_LABELS_RAW, POPULAR_DOG_BREED_LABELS_RAW } from "./dogBreedData";
import {
  applyBlockingIssues,
  fieldIssue,
  type FieldValidationIssue,
  makeFieldResult,
  normalizeText,
  optionalByDefault,
  resolveFieldMode,
  type FieldSchema,
  type FieldValidationOptions,
  type FieldValidationResult,
} from "./modes";

export type DogBreedOption = Readonly<{
  label: string;
  value: string;
  aliases: readonly string[];
  popular: boolean;
}>;

const dogBreedLabels = DOG_BREED_LABELS_RAW.split("|");
const popularDogBreedLabels = POPULAR_DOG_BREED_LABELS_RAW.split("|");
const popularLabelSet = new Set(popularDogBreedLabels);
const polishLetterMap: Record<string, string> = {
  ą: "a",
  ć: "c",
  ę: "e",
  ł: "l",
  ń: "n",
  ó: "o",
  ś: "s",
  ź: "z",
  ż: "z",
};

const dogBreedAliasesByLabel: Record<string, readonly string[]> = {
  "American staffordshire terrier": ["Amstaff"],
  "Bulterier": ["Bull Terrier"],
  "Cavalier king charles spaniel": ["Cavalier King Charles"],
  "Fiński lapphund": ["Finnish Lapphund"],
  "Gryfonik brukselski": ["Griffon Brukselski"],
  "Labrador retriever": ["Labrador"],
  "Malti-poo — (połączenie maltańczyka i pudla)": ["Maltipoo"],
  "Kundelek": ["Mieszaniec", "Mieszanka", "Mieszanka różnych ras", "Mix"],
  "Nowofundland": ["Newfoundland"],
  "Staffordshire Bull Terrier": ["Stafford"],
  "Wyżeł weimarski": ["Weimaraner"],
};

export function normalizeDogBreedText(value: unknown): string {
  const ascii = normalizeText(value)
    .toLowerCase()
    .replace(/[ąćęłńóśźż]/g, (char) => polishLetterMap[char] ?? char)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");

  return ascii
    .replace(/[—–-]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const dogBreedOptions: readonly DogBreedOption[] = dogBreedLabels.map((label) => ({
  label,
  value: normalizeDogBreedText(label),
  aliases: dogBreedAliasesByLabel[label] ?? [],
  popular: popularLabelSet.has(label),
}));

const dogBreedOptionByLabel = new Map(dogBreedOptions.map((option) => [option.label, option]));
const popularOrder = new Map(popularDogBreedLabels.map((label, index) => [label, index]));

export const popularDogBreedOptions: readonly DogBreedOption[] = popularDogBreedLabels
  .map((label) => dogBreedOptionByLabel.get(label))
  .filter((option): option is DogBreedOption => Boolean(option));

const searchIndex = dogBreedOptions.map((option, order) => ({
  option,
  order,
  terms: [option.label, ...option.aliases].map(normalizeDogBreedText),
}));

export function getDogBreedSuggestions(query: string, limit = 12): readonly DogBreedOption[] {
  const normalizedQuery = normalizeDogBreedText(query);
  if (!normalizedQuery) return popularDogBreedOptions.slice(0, limit);

  return searchIndex
    .flatMap((entry) => {
      const score = bestDogBreedMatchScore(entry.terms, normalizedQuery);
      return score === null ? [] : [{ ...entry, score }];
    })
    .sort((a, b) => {
      const scoreDelta = a.score - b.score;
      if (scoreDelta) return scoreDelta;

      const popularDelta = popularRank(a.option) - popularRank(b.option);
      if (popularDelta) return popularDelta;

      return a.order - b.order;
    })
    .slice(0, limit)
    .map((entry) => entry.option);
}

export function validateDogBreedField(
  value: unknown,
  options: FieldValidationOptions = {},
): FieldValidationResult<string> {
  const mode = resolveFieldMode(options.mode);
  const required = optionalByDefault(options.required);
  const breed = normalizeText(value).replace(/\s+/g, " ");
  const issues: FieldValidationIssue[] = [];

  if (!breed && required) {
    issues.push(fieldIssue("required", "forms:fields.dogBreed.required", mode));
  } else if (breed.length > 120) {
    issues.push(fieldIssue("too_long", "forms:fields.dogBreed.tooLong", mode));
  }

  return makeFieldResult(breed, issues);
}

export function dogBreedFieldSchema(options: FieldValidationOptions = {}): FieldSchema<string> {
  return z
    .unknown()
    .transform((value) => validateDogBreedField(value, options))
    .superRefine((result, ctx) => applyBlockingIssues(ctx, result.issues))
    .transform((result) => result.value);
}

function bestDogBreedMatchScore(terms: readonly string[], query: string): number | null {
  let best: number | null = null;

  for (const term of terms) {
    let score: number | null = null;
    if (term === query) score = 0;
    else if (term.startsWith(query)) score = 1;
    else if (term.split(" ").some((part) => part.startsWith(query))) score = 2;
    else if (term.includes(query)) score = 3;

    if (score !== null && (best === null || score < best)) best = score;
  }

  return best;
}

function popularRank(option: DogBreedOption): number {
  return popularOrder.get(option.label) ?? Number.MAX_SAFE_INTEGER;
}
