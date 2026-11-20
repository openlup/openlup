import { z } from "zod";
import type { runSettingsCommand } from "./settingsCommand.js";

type SettingsDatabase = NonNullable<Parameters<NonNullable<Parameters<typeof runSettingsCommand>[2]>["bind"]>[0]["database"]>;

export function admitDatabaseUrl(input: string): SettingsDatabase | { path: string[]; hint: string } {
  const path = ["database-url"];
  const url = URL.parse(input);
  if (!url || url.href !== input) return { path,
    hint: "Supply a canonical postgres:// or postgresql:// URL with a host, username and database. Use matching brackets for IPv6 and omit the port or use a port from 1 to 65535. Remove whitespace and dot segments." };
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return { path, hint: "Use the postgres:// or postgresql:// scheme." };
  if (!url.hostname.startsWith("[") && !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.?$/u.test(url.hostname)) {
    return { path, hint: "Use one lowercase DNS name, IPv4 address or bracketed IPv6 address for the host. Replace an escaped, socket or comma-separated host with one TCP host." };
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
  if (url.href.includes("#")) return { path, hint: "Remove the fragment from the PostgreSQL URL." };
  if (url.href.includes("?") && !["?sslmode=disable", "?sslmode=require", "?sslmode=verify-full"].includes(url.search)) {
    return { path, hint: "Use no query or a single sslmode set to disable, require or verify-full. If your provider needs another option, use a provider URL that works with verified TLS under Node's trust store." };
  }
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  return {
    host, port, user, password: password || (() => ""), database,
    ssl: url.search === "?sslmode=require" || url.search === "?sslmode=verify-full" ? { rejectUnauthorized: true, host } : false,
    // Truthy no-op startup values prevent pg from inheriting process connection defaults.
    sslnegotiation: "postgres", options: " ", replication: "false", client_encoding: "utf8",
    application_name: "openlup settings", connectionTimeoutMillis: 0,
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
