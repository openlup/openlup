import { describe, expect, it } from "vitest";
import { FLAVOUR_HEX, flavourView, resolveFlavourSlug } from "./flavour";

describe("resolveFlavourSlug", () => {
  it("maps PL and EN recipe names to flavour slugs", () => {
    expect(resolveFlavourSlug("Jagnięcina")).toBe("lamb");
    expect(resolveFlavourSlug("Indyk")).toBe("turkey");
    expect(resolveFlavourSlug("Łosoś")).toBe("salmon");
    expect(resolveFlavourSlug("Lamb")).toBe("lamb");
    expect(resolveFlavourSlug("beef")).toBe("beef");
  });

  it("returns null for unknown / empty (no fabricated mapping)", () => {
    expect(resolveFlavourSlug(null)).toBeNull();
    expect(resolveFlavourSlug("Topper")).toBeNull();
    expect(resolveFlavourSlug("")).toBeNull();
  });
});

describe("flavourView", () => {
  it("returns image + brand colour SoT for a known flavour", () => {
    const view = flavourView("Jagnięcina", "Labrador");
    expect(view.slug).toBe("lamb");
    expect(view.color).toBe(FLAVOUR_HEX.lamb);
    expect(view.image).toBeTruthy();
  });

  it("uses localized display labels for known raw EN recipe names", () => {
    const view = flavourView("Venison + EntoPro™ Recipe", null, "pl");
    expect(view.slug).toBe("venison");
    expect(view.label).toBe("Dziczyzna");
  });

  it("does NOT fabricate an image for an unresolved flavour", () => {
    const view = flavourView("Topper", null);
    expect(view.slug).toBeNull();
    expect(view.image).toBeNull();
  });
});
