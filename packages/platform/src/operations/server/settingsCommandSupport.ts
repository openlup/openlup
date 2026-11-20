import { isIPv4 } from "node:net";
import { z } from "zod";
import type { runSettingsCommand } from "./settingsCommand.js";

type SettingsDatabase = NonNullable<Parameters<NonNullable<Parameters<typeof runSettingsCommand>[2]>["bind"]>[0]["database"]>;

export function admitDatabaseUrl(input: string): SettingsDatabase | { path: string[]; hint: string } {
  const path = ["database-url"];
  const url = URL.parse(input);
  if (!url || url.href !== input) return { path,
    hint: "Supply a canonical postgres:// or postgresql:// URL with a host, username and database. Use brackets and lowercase hexadecimal without leading zeros for IPv6, compress the first longest run of two or more zero fields to ::, and write a single zero field as 0. Omit the port or use a port from 1 to 65535 without leading zeros, and write an empty password without the colon. Remove whitespace and dot segments." };
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return { path, hint: "Use the postgres:// or postgresql:// scheme." };
  const dnsName = url.hostname.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.?$/u.test(url.hostname);
  const ipv4Like = /(?:^|\.)(?:[0-9]+|0x[0-9a-f]*)\.?$/u.test(url.hostname);
  if (!url.hostname.startsWith("[") && !(dnsName && (!ipv4Like || isIPv4(url.hostname)))) {
    return { path, hint: url.hostname
      ? "Use one lowercase DNS name, dotted-decimal IPv4 address or bracketed IPv6 address for the host. Replace an escaped, socket or comma-separated host with one TCP host. A DNS name uses only letters, digits, dots and hyphens. Each label must begin and end with a letter or digit. Keep each DNS label to 63 characters and the name to 253 characters, including any trailing dot. The final label cannot be all digits, 0x alone, or 0x followed only by hexadecimal digits. Write IPv4 as four decimal octets from 0 to 255 separated by dots, without leading zeros."
      : "Name the TCP host using the postgresql://user@host/database form." };
  }
  const port = Number(url.port || 5432);
  if (port < 1 || port > 65535) return { path, hint: "Omit the PostgreSQL URL port or use a port from 1 to 65535." };
  if (!url.username) return { path, hint: "Name the PostgreSQL username before @ in the URL." };
  if (!/^\/[^/]+$/u.test(url.pathname)) return { path, hint: "Use one non-empty database path segment after the host and port." };
  const encoding = { path, hint: "Encode the PostgreSQL username, password and database as valid UTF-8 URL components without control characters." };
  let user: string, password: string, database: string;
  try {
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
    database = decodeURIComponent(url.pathname.slice(1));
  } catch { return encoding; }
  if ([user, password, database].some(value => /\p{Cc}/u.test(value))) return encoding;
  if (Buffer.byteLength(user, "utf8") > 63 || Buffer.byteLength(database, "utf8") > 63) {
    return { path, hint: "Use a PostgreSQL username and database name of at most 63 bytes each in UTF-8." };
  }
  if (url.href.includes("#")) return { path, hint: "Remove the fragment from the PostgreSQL URL." };
  if (url.href.includes("?") && !["?sslmode=disable", "?sslmode=require", "?sslmode=verify-full"].includes(url.search)) {
    return { path, hint: "Omit the query or use a single sslmode option written exactly as ?sslmode=disable, ?sslmode=require or ?sslmode=verify-full. If your provider needs another option, use a provider URL that works with verified TLS under Node's trust store." };
  }
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  return {
    host, port, user, password: password || (() => ""), database,
    ssl: url.search === "?sslmode=require" || url.search === "?sslmode=verify-full" ? { rejectUnauthorized: true, host } : false,
  };
}

const locationSchema = z.strictObject({ file: z.string(), symbol: z.string() }).optional();
const fileSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("not-reported") }),
  z.strictObject({ state: z.literal("present"), location: locationSchema, value: z.json() }),
  z.strictObject({ state: z.literal("unreportable"), location: locationSchema, message: z.string() }),
]);
const validationSchema = z.union([
  z.strictObject({ state: z.enum(["valid", "not-validated"]) }),
  z.strictObject({ state: z.literal("invalid"), paths: z.array(z.array(z.string())) }),
]);
const appValidationSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("passed") }),
  z.strictObject({ state: z.literal("not-provided"), hint: z.string().optional() }),
  z.strictObject({ state: z.literal("failed"), message: z.string(), phase: z.literal("load").optional() }),
]);
const checkRow = z.strictObject({ key: z.string().min(1), file: fileSchema, validation: validationSchema,
  effect: z.string(), takesEffect: z.string() });
export const checkResultSchema = z.strictObject({
  schemaVersion: z.literal(1), configuration: z.string().nullable(), state: z.enum(["checked", "invalid", "unknown"]),
  appValidation: appValidationSchema, rows: z.array(z.discriminatedUnion("kind", [
    checkRow.extend({ kind: z.literal("code") }),
    checkRow.extend({ kind: z.literal("installed"), store: z.strictObject({ state: z.literal("not-checked") }), note: z.string() }),
  ])),
});
export type FileValue = z.infer<typeof fileSchema>;
export type Validation = z.infer<typeof validationSchema>;
export type AppValidation = z.infer<typeof appValidationSchema>;
