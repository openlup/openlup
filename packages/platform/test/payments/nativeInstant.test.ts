import { expect, it } from "vitest";
import { nativeInstant as paymentInstant } from "../../src/payments/nativeInstant.js";
import { nativeInstant as subscriptionInstant } from "../../src/subscriptions/nativeInstant.js";
const copies = [paymentInstant, subscriptionInstant];
import { postgresTimestampTzToRfc3339 } from "../../src/data/postgresGateway.js";

it.each([
  ["2026-10-30T12:00:00Z", "2026-10-30T12:00:00.000000Z"],
  ["2026-10-30T12:00:00.000Z", "2026-10-30T12:00:00.000000Z"],
  ...["1", "12", "123", "1234", "12345", "123456"].map(fraction =>
    [`2026-10-30T12:00:00.${fraction}Z`, `2026-10-30T12:00:00.${fraction.padEnd(6, "0")}Z`]),
  ["2026-10-30T12:00:00.999999Z", "2026-10-30T12:00:00.999999Z"],
  ["2026-10-30T14:00:00.123456+02:00", "2026-10-30T12:00:00.123456Z"],
  ["2026-10-30T07:00:00.123999-05:00", "2026-10-30T12:00:00.123999Z"],
  ["2026-01-01T00:00:00.999999+00:01", "2025-12-31T23:59:00.999999Z"],
  ["2024-03-01T00:00:00.000001+00:01", "2024-02-29T23:59:00.000001Z"],
  ["1969-12-31T23:59:59.999999Z", "1969-12-31T23:59:59.999999Z"],
])("canonicalizes %s without rounding the fraction", (input, expected) => {
  expect(copies.map(canonical => canonical(input))).toEqual([expected, expected]);
  expect(copies.map(canonical => canonical(expected))).toEqual([expected, expected]);
});
it.each([
  ["2026-10-30 21:00:00.123456+09", "2026-10-30T12:00:00.123456Z"],
  ["2026-01-01 00:00:00.999999+09", "2025-12-31T15:00:00.999999Z"],
  ["2026-12-31 23:59:59.123456-05", "2027-01-01T04:59:59.123456Z"],
])("accepts the gateway's lossless RFC3339 output %s", (input, expected) => {
  expect(copies.map(canonical => canonical(postgresTimestampTzToRfc3339(input)))).toEqual([expected, expected]);
});
it.each(["2026-02-30T00:00:00Z", "2026-10-30T24:00:00Z", "2026-10-30T12:00:60Z",
  "2026-10-30T12:00:00.1234567Z", "2026-10-30 12:00:00+00", "2026-10-30T12:00:00",
  "2026-10-30T12:00:00+24:00", "2026-10-30T12:00:00+01:60", "not-a-time", "infinity"])("refuses %s", value => {
  const refusals = copies.map(canonical => {
    try { canonical(value); return null; }
    catch (error) { return { name: (error as Error).name, message: (error as Error).message }; }
  });
  expect(refusals).toEqual(Array(2).fill({ name: "Error", message: "native_instant_invalid" }));
});
