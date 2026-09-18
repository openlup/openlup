import { describe, expect, it } from "vitest";

import { isInAppBrowser } from "./inAppBrowser";

/**
 * The three positives are real user agents from the 2026-09-02 in-app recon; the
 * two negatives are the browsers the escape hatch sends buyers to, and offering
 * them a way out of the browser they are already in would be nonsense.
 */
const FB_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) [FBAN/FBIOS;FBAV/470.0.0.36.109;FBBV/600296556]";
const FB_ANDROID =
  "Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/470.0.0.29.109;]";
const INSTAGRAM =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 340.0.0.19.109";
const SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

describe("isInAppBrowser", () => {
  it("recognises the three embedded webviews the checkout actually loses buyers in", () => {
    expect(isInAppBrowser(FB_IOS)).toBe(true);
    expect(isInAppBrowser(FB_ANDROID)).toBe(true);
    expect(isInAppBrowser(INSTAGRAM)).toBe(true);
  });

  it("leaves real browsers alone", () => {
    // The Android webview above also contains `Chrome/147`, so a naive check for
    // a real browser would call it one. Only the embedded markers may decide.
    expect(isInAppBrowser(SAFARI)).toBe(false);
    expect(isInAppBrowser(CHROME)).toBe(false);
  });
});
