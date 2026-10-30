import { describe, expect, it } from "vitest";
import { marketResources } from "./marketResources.js";

describe("unmounted market message data", () => {
  it("has matching nonempty keys in both languages without selecting a fallback", () => {
    const keys = Object.keys(marketResources.en).sort();
    expect(keys).toEqual(["lookup", "manual", "optionalAddress", "unsupported"]);
    expect(Object.keys(marketResources.pl).sort()).toEqual(keys);
    for (const messages of Object.values(marketResources)) {
      for (const message of Object.values(messages)) expect(message.trim().length).toBeGreaterThan(0);
    }
    expect(marketResources).not.toHaveProperty("unknown");
  });
});
