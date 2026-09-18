import { describe, expect, it } from "vitest";
import {
  productAccentColor,
  productDisplayLabel,
  resolveLaunchProductSlug,
} from "./catalogProductDisplay";

describe("product display registry", () => {
  it("resolves launch product labels without leaking raw slugs", () => {
    expect(resolveLaunchProductSlug("Venison + EntoPro™ Recipe")).toBe("venison");
    expect(productDisplayLabel("venison", "pl")).toBe("Dziczyzna + EntoPro™");
    expect(productDisplayLabel("lamb", "en")).toBe("Lamb + EntoPro™");
  });

  it("keeps account accents aligned for known launch products", () => {
    expect(productAccentColor("venison")).toBe("#8B1A4A");
    expect(productAccentColor("unknown")).toBeNull();
  });
});
