import { describe, expect, it } from "vitest";
import { documentNotes, quantityUnit } from "./invoicePresentation.js";

describe("invoice presentation", () => {
  it("falls back to the market default unit and lets a line name its own", () => {
    // A position with no unit prints "(brak)" in the j.m. column of the issued
    // document, so the fallback must never yield an empty value.
    expect(quantityUnit({})).toBe("szt.");
    expect(quantityUnit({ quantityUnit: "  " })).toBe("szt.");
    expect(quantityUnit({ quantityUnit: " kg " })).toBe("kg");
  });

  it("labels the order reference as one note record", () => {
    expect(documentNotes("order_123")).toEqual([
      { kind: "Numer zamówienia", content: "order_123" },
    ]);
  });

  it("truncates a note to the schema limit both halves carry", () => {
    const [note] = documentNotes("o".repeat(300));

    expect(note.content).toHaveLength(256);
    expect(note.kind.length).toBeLessThanOrEqual(256);
  });
});
