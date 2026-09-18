import { describe, expect, it } from "vitest";
import {
  dogBreedFieldSchema,
  dogBreedOptions,
  getDogBreedSuggestions,
  normalizeDogBreedText,
  popularDogBreedOptions,
  validateDogBreedField,
} from "./index";

describe("canonical dog breed catalog", () => {
  it("deduplicates the imported catalog and exposes popular breeds", () => {
    expect(dogBreedOptions).toHaveLength(580);
    expect(popularDogBreedOptions).toHaveLength(22);

    const normalizedValues = dogBreedOptions.map((option) => option.value);
    expect(new Set(normalizedValues).size).toBe(normalizedValues.length);
    expect(popularDogBreedOptions[0]?.label).toBe("Border collie");
    expect(popularDogBreedOptions[popularDogBreedOptions.length - 1]?.label).toBe(
      "Yorkshire terrier",
    );
  });

  it("normalizes text for accent-insensitive lookup", () => {
    expect(normalizeDogBreedText("  Wyżeł   węgierski — krótkowłosy ")).toBe(
      "wyzel wegierski krotkowlosy",
    );
  });

  it("returns fast limited suggestions with aliases ranked first", () => {
    expect(getDogBreedSuggestions("", 30)).toHaveLength(22);
    expect(getDogBreedSuggestions("kundelek")[0]?.label).toBe("Kundelek");
    expect(getDogBreedSuggestions("mieszaniec")[0]?.label).toBe("Kundelek");
    expect(getDogBreedSuggestions("labrador")[0]?.label).toBe("Labrador retriever");
    expect(getDogBreedSuggestions("amstaff")[0]?.label).toBe(
      "American staffordshire terrier",
    );
    expect(getDogBreedSuggestions("terrier", 5)).toHaveLength(5);
  });

  it("keeps dog breed validation permissive for custom user text", () => {
    expect(dogBreedFieldSchema().parse("  Kosmiczny pies  ")).toBe("Kosmiczny pies");
    expect(dogBreedFieldSchema().safeParse("").success).toBe(false);
    expect(dogBreedFieldSchema({ required: false }).parse("")).toBe("");

    const longBreed = validateDogBreedField("x".repeat(121));
    expect(longBreed.success).toBe(false);
    expect(longBreed.errors[0]?.messageKey).toBe("forms:fields.dogBreed.tooLong");
  });
});
