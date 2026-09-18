import { describe, expect, it } from "vitest";
import {
  UNSUBSCRIBE_LINK_TTL_SECONDS,
  buildUnsubscribeToken,
  buildUnsubscribeUrl,
  verifyUnsubscribeToken,
} from "./unsubscribeToken.js";

const SECRET = "unit-test-unsubscribe-secret-0123456789";

function base64url(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Sign an arbitrary payload the way the builder does, to forge legacy shapes. */
async function signPayload(payloadJson: string, secret: string): Promise<string> {
  const body = base64url(payloadJson);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
  );
  let binary = "";
  for (const b of sig) binary += String.fromCharCode(b);
  return `${body}.${base64url(binary)}`;
}

describe("unsubscribeToken", () => {
  it("round-trips email + purpose", async () => {
    const token = await buildUnsubscribeToken(
      { email: "Pet.Owner@Example.com", purpose: "marketing_newsletter" },
      SECRET,
    );
    const payload = await verifyUnsubscribeToken(token, SECRET);
    expect(payload).toEqual({ email: "Pet.Owner@Example.com", purpose: "marketing_newsletter" });
  });

  it("stamps exp eighteen months (548 days) after issue", async () => {
    const issuedAt = new Date("2026-08-30T12:00:00.000Z");
    const token = await buildUnsubscribeToken(
      { email: "a@b.com", purpose: "marketing_newsletter" },
      SECRET,
      { now: issuedAt },
    );
    const payload = JSON.parse(
      atob(token.split(".")[0].replace(/-/g, "+").replace(/_/g, "/")
        .padEnd(Math.ceil(token.split(".")[0].length / 4) * 4, "=")),
    ) as { exp: number };
    expect(UNSUBSCRIBE_LINK_TTL_SECONDS).toBe(548 * 24 * 60 * 60);
    expect(payload.exp).toBe(Math.floor(issuedAt.getTime() / 1000) + UNSUBSCRIBE_LINK_TTL_SECONDS);
  });

  it("accepts a fresh token before exp and refuses it after", async () => {
    const issuedAt = new Date("2026-08-30T12:00:00.000Z");
    const token = await buildUnsubscribeToken(
      { email: "a@b.com", purpose: "marketing_newsletter" },
      SECRET,
      { now: issuedAt },
    );
    const oneSecondBefore = new Date(
      issuedAt.getTime() + (UNSUBSCRIBE_LINK_TTL_SECONDS - 1) * 1000,
    );
    const oneSecondAfter = new Date(
      issuedAt.getTime() + (UNSUBSCRIBE_LINK_TTL_SECONDS + 1) * 1000,
    );
    expect(await verifyUnsubscribeToken(token, SECRET, { now: oneSecondBefore }))
      .toEqual({ email: "a@b.com", purpose: "marketing_newsletter" });
    expect(await verifyUnsubscribeToken(token, SECRET, { now: oneSecondAfter })).toBeNull();
  });

  // Every link already delivered was minted before `exp` existed. Refusing those
  // would retro-expire an opt-out the recipient was told would keep working.
  it("keeps accepting a legacy token that carries no exp", async () => {
    const legacy = await signPayload(
      '{"e":"legacy@example.com","p":"marketing_newsletter","v":1}',
      SECRET,
    );
    expect(await verifyUnsubscribeToken(legacy, SECRET, { now: new Date("2099-01-01T00:00:00Z") }))
      .toEqual({ email: "legacy@example.com", purpose: "marketing_newsletter" });
  });

  it("rejects a non-numeric or non-finite exp rather than ignoring it", async () => {
    for (const exp of ['"9999999999"', "null", "1e999"]) {
      const forged = await signPayload(
        `{"e":"a@b.com","p":"marketing_newsletter","v":1,"exp":${exp}}`,
        SECRET,
      );
      expect(await verifyUnsubscribeToken(forged, SECRET)).toBeNull();
    }
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await buildUnsubscribeToken({ email: "a@b.com", purpose: "marketing_newsletter" }, SECRET);
    expect(await verifyUnsubscribeToken(token, "other-secret")).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const token = await buildUnsubscribeToken({ email: "a@b.com", purpose: "marketing_newsletter" }, SECRET);
    const [, sig] = token.split(".");
    const forged = `${btoa('{"e":"evil@b.com","p":"marketing_newsletter","v":1}')
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")}.${sig}`;
    expect(await verifyUnsubscribeToken(forged, SECRET)).toBeNull();
  });

  it("rejects malformed tokens and empty inputs", async () => {
    expect(await verifyUnsubscribeToken("", SECRET)).toBeNull();
    expect(await verifyUnsubscribeToken("nodot", SECRET)).toBeNull();
    expect(await verifyUnsubscribeToken(".sigonly", SECRET)).toBeNull();
    const token = await buildUnsubscribeToken({ email: "a@b.com", purpose: "marketing_newsletter" }, SECRET);
    expect(await verifyUnsubscribeToken(token, "")).toBeNull();
  });

  it("adds a localized token to an adapter-resolved endpoint", () => {
    const url = buildUnsubscribeUrl("https://unsubscribe.example.test/opt-out", "tok123", "en");
    expect(url).toBe("https://unsubscribe.example.test/opt-out?token=tok123&lang=en");
    const pl = buildUnsubscribeUrl("https://unsubscribe.example.test/opt-out", "tok123", "pl");
    expect(pl).toBe("https://unsubscribe.example.test/opt-out?token=tok123");
  });

  it("rejects an unsafe endpoint supplied outside the adapter contract", () => {
    expect(() => buildUnsubscribeUrl("http://unsubscribe.example.test/opt-out", "tok123", "en"))
      .toThrow("unsubscribe endpoint URL must be HTTPS");
    expect(() => buildUnsubscribeUrl("https://user:password@unsubscribe.example.test/opt-out", "tok123", "en"))
      .toThrow("unsubscribe endpoint URL must be HTTPS");
    expect(() => buildUnsubscribeUrl("https://unsubscribe.example.test./opt-out", "tok123", "en"))
      .toThrow("trailing-dot hostname");
  });

  // Marketing emails carry Polish diacritics, so their body is quoted-printable
  // encoded. If a transport leaves the `?token=` separator raw at a soft-line-break
  // boundary, a token whose first two chars are BOTH hex digits gets mis-decoded
  // (`=7d` -> `}`) — the dunning/checkout-recovery field bug. The unsubscribe token
  // is structurally immune: it is base64url(JSON) and the payload ALWAYS serializes
  // as `{"e":…`, so the token always begins "ey" (`e` is hex, `y` is not) -> `=ey`
  // is never a valid `=<2 hex>` escape. This guards that invariant against a future
  // payload reshape that could start the token with two hex digits.
  it("token is quoted-printable safe at the ?token= boundary (never =<2 hex>)", async () => {
    const cases: Array<{ email: string; purpose: string }> = [
      { email: "a@b.com", purpose: "marketing_newsletter" },
      { email: "Pet.Owner@Example.com", purpose: "product_updates" },
      { email: "zzz999@xyz.dev", purpose: "x" },
      { email: "0@0.io", purpose: "0" },
    ];
    for (const c of cases) {
      const token = await buildUnsubscribeToken(c, SECRET);
      expect(token.startsWith("ey")).toBe(true);
      // First two chars after `?token=` must not both be hex digits.
      expect(/^[0-9A-Fa-f]{2}/.test(token)).toBe(false);
    }
  });
});
