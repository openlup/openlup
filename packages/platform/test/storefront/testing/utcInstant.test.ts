import { expect, it } from "vitest";
import { UTC_INSTANT_MAX_MS, utcInstant } from "../../../src/storefront/testing/utcInstant.js";

const iso = (ms: number) => new Date(ms).toISOString();

it("equals toISOString across its whole domain (T1)", () => {
  // A deterministic sweep: 10,000 instants spread over the domain with an irregular stride.
  const stride = Math.floor(UTC_INSTANT_MAX_MS / 10_000);
  for (let index = 0; index < 10_000; index += 1) {
    const ms = Math.min(UTC_INSTANT_MAX_MS, index * stride + ((index * 7_919_993) % 86_400_000));
    expect(utcInstant(ms), String(ms)).toBe(iso(ms));
  }
});

it("equals toISOString at the edges, leap days and the turns of 1999 to 2001 (T1)", () => {
  const edges = [0, 1, 999, 86_399_999, 86_400_000, UTC_INSTANT_MAX_MS];
  for (const year of [1972, 2000, 2004, 2096, 2400, 9996]) edges.push(Date.UTC(year, 1, 29), Date.UTC(year, 1, 29, 23, 59, 59, 999), Date.UTC(year, 2, 1));
  for (const year of [2100, 2200]) edges.push(Date.UTC(year, 1, 28, 23, 59, 59, 999), Date.UTC(year, 2, 1));
  for (const year of [1999, 2000, 2001]) edges.push(Date.UTC(year + 1, 0, 1) - 1, Date.UTC(year + 1, 0, 1));
  expect(edges.every((value) => value >= 0)).toBe(true);
  for (const ms of edges) expect(utcInstant(ms), String(ms)).toBe(iso(ms));
  expect(utcInstant(UTC_INSTANT_MAX_MS)).toBe("9999-12-31T23:59:59.999Z");
});

it("refuses values outside integer milliseconds 0 to the end of 9999 (T1)", () => {
  // 28 February 1900 lies before the epoch, so it is outside the domain.
  for (const ms of [Date.UTC(1900, 1, 28), -1, 1.5, UTC_INSTANT_MAX_MS + 1, Number.NaN, Number.POSITIVE_INFINITY, "0" as unknown as number]) {
    expect(() => utcInstant(ms), String(ms)).toThrow(/^storefront_run_input_invalid: /);
  }
});
