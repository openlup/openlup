import { describe, expect, it } from "vitest";
import { APP_SHELL_ASSET_OVERRIDES, applyAppShellAssetOverrides } from "./appShellAssets.js";

describe("app shell asset overrides", () => {
  const markup = '<link href="/platform/favicon.svg"><img src="/platform/share.svg"><img src="/platform/share.svg">';
  it("keeps the selected neutral shell unchanged when no overlay is configured", () => {
    expect(APP_SHELL_ASSET_OVERRIDES).toEqual({});
    expect(applyAppShellAssetOverrides(markup)).toBe(markup);
  });
  it("replaces every occurrence through an explicit adopter overlay", () => {
    const overrides = { "/platform/favicon.svg": "/synthetic/icon.svg", "/platform/share.svg": "/synthetic/share.svg" };
    const expected = '<link href="/synthetic/icon.svg"><img src="/synthetic/share.svg"><img src="/synthetic/share.svg">';
    expect(applyAppShellAssetOverrides(markup, overrides)).toBe(expected);
    expect(applyAppShellAssetOverrides(markup, Object.fromEntries(Object.entries(overrides).reverse()))).toBe(expected);
  });
  it("leaves unrelated assets untouched", () => {
    const untouched = '<link href="/other.svg">';
    expect(applyAppShellAssetOverrides(untouched, { "/platform/favicon.svg": "/synthetic/icon.svg" })).toBe(untouched);
  });
});
