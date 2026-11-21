import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveLatest, type Pack } from "./released-api-baseline.ts";
import { checkReleasedApi } from "./released-api-check.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const entry = { name: "@openlup/platform", directory: "packages/platform", publish: true };
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));

function fixturePack(
  declarations: string, version = "1.3.0", runtime?: string, peer?: Record<string, string>, subpath = runtime === undefined ? "." : "./payments",
): Pack {
  const path = mkdtempSync(join(tmpdir(), "released-api-fixture-"));
  roots.push(path);
  const write = (file: string, text: string) => {
    const target = join(path, "package", file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  };
  const base = subpath === "./catalog" ? "dist/catalog/sql" : "dist/index";
  write("package.json", JSON.stringify({
    name: entry.name, version, type: "module", peerDependencies: peer,
    exports: { [subpath]: { types: `./${base}.d.ts`, import: `./${base}.js` } },
  }));
  write("release-gates.json", JSON.stringify({ packageSurface: { [subpath]: { maturity: "stable" } } }));
  write(`${base}.d.ts`, declarations);
  write(`${base}.js`, runtime ?? "export {};");
  const archive = join(path, "fixture.tgz");
  execFileSync("tar", ["-czf", archive, "-C", path, "package"]);
  return { path: archive };
}

const run = (before: string, after: string) =>
  checkReleasedApi(root, [entry], [fixturePack(after)], [fixturePack(before)]);
const gateway = "export declare class PgGatewayClient { private readonly client; query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>; }";
const binding = "export interface DataBindingDependencies { createSupabaseClient(url: string, key: string): object; }";
const tuple = "export declare const CATALOG_MIGRATIONS: readonly [1, 2, /** @experimental */ 3];";

describe("released TypeScript surface", () => {
  it.each([
    ["#824 optional member", binding, binding.replace("Client(", "Client?("), /DataBindingDependencies\.createSupabaseClient/],
    ["#824 query implementation", gateway, gateway.replace("query(", "query<Row extends Record<string, unknown>>(").replace("rows: Record<string, unknown>[]", "rows: Row[]"), /PgGatewayClient\.query/],
    ["#811 fixed tuple length", tuple, tuple.replace("3]", "3, /** @experimental */ 4]"), /CATALOG_MIGRATIONS/],
    ["type-only re-export", "export declare class Entry {}", "declare class Entry {} export type { Entry };", /Entry: no longer exports a value/],
    ["method bivariance", "export interface Port { read(key: string | number): object }", "export interface Port { read(key: string): object }", /Port\.read: no longer accepts released call arguments/],
    ["removed call argument", "export declare function read(key: string, scope?: string): object;", "export declare function read(key: string): object;", /read: no longer accepts released call arguments/],
    ["lost result variant", "export declare function read(): Promise<{ kind: 'found'; id: string } | { kind: 'missing' }>;", "export declare function read(): Promise<{ kind: 'found'; id: string }>;", /read: lost one or more released variants/],
    ["changed result variant", "export declare function read(): 'ready' | 'held';", "export declare function read(): string;", /read: lost one or more released variants/],
  ])("refuses %s", async (_, before, after, expected) => {
    await expect(run(before, after)).rejects.toThrow(expected);
  });

  it("allows an additive bridge, a wider input, and additions to an open result union", async () => {
    const before = `
      export interface Input { id: string }
      export type Result = { kind: "ready"; value: number } | { kind: "held" };
      export declare function read(input: Input): Promise<Result>;
      export interface Port { read(input: Input): Promise<Result> }
    `;
    const after = `
      export interface Input { id: string; label?: string }
      export type Result = { kind: "ready"; value: number } | { kind: "held" } | { kind: "new" };
      /** @deprecated Use readNext. */
      export declare function read(input: Input | string): Promise<Result>;
      export declare function readNext(input: Input): Promise<Result>;
      export interface Port { read(input: Input): Promise<Result> }
    `;
    await expect(run(before, after)).resolves.toBeGreaterThan(0);
  });

  it("keeps the identity of a nominal brand while comparing its public shape", async () => {
    const before = "declare const key: unique symbol; export interface Branded { readonly [key]: true; label: string; }";
    await expect(run(before, before.replace("label: string", "label: string; count?: number"))).resolves.toBeGreaterThan(0);
    await expect(run(before, before.replace("label: string", "label: number"))).rejects.toThrow(/Branded/);
  });

  it("refuses the #822 runtime change with the same exported types", async () => {
    const declaration = "export declare function terminalAmountMismatch(attempt: object, readback: object): string | null;";
    const released = fixturePack(declaration, "1.2.0", "export function terminalAmountMismatch() { return null; }");
    const candidate = fixturePack(declaration, "1.3.0", `
      export function terminalAmountMismatch(_, readback) {
        return readback.capturedAmountBasis ? null : "provider_capture_amount_unconfirmed";
      }
    `);
    await expect(checkReleasedApi(root, [entry], [candidate], [released])).rejects.toThrow(
      /@openlup\/platform@1\.2\.0 — @openlup\/platform\/payments → terminalAmountMismatch: released readback outcome changed from null to "provider_capture_amount_unconfirmed"/u,
    );
    await expect(checkReleasedApi(root, [entry], [released], [released])).resolves.toBeGreaterThan(0);
  });
});

describe("append-only registry", () => {
  const row = (id: string, value: number) => `{ readonly id: "${id}"; readonly value: ${value} }`;
  const first = row("first", 1), second = row("second", 2), third = row("third", 3);
  const declaration = (entries: string[], tagged = true) =>
    `${tagged ? "/** @appendOnly */\n" : ""}export declare const CATALOG_MIGRATIONS: readonly [${entries.join(", ")}];`;
  const pack = (text: string, version: string) => fixturePack(text, version, undefined, undefined, "./catalog");

  function check(entries: string[], note = "", version = "1.4.0", tagged = true, releasedTagged = true) {
    const directory = mkdtempSync(join(tmpdir(), "released-api-registry-"));
    roots.push(directory);
    mkdirSync(join(directory, entry.directory, "changes"), { recursive: true });
    mkdirSync(join(directory, "node_modules"));
    writeFileSync(join(directory, entry.directory, "CHANGELOG.md"), "## [Unreleased]\n");
    if (note) writeFileSync(join(directory, entry.directory, "changes/registry.md"), note);
    return checkReleasedApi(directory, [entry], [pack(declaration(entries, tagged), version)],
      [pack(declaration([first, second], releasedTagged), "1.3.0")]);
  }

  it("allows a documented tail append in a minor and before the minor bump", async () => {
    const note = "Migration: In 1.4.0, append `third` to `CATALOG_MIGRATIONS`.";
    await expect(check([first, second, third], note)).resolves.toBeGreaterThan(0);
    await expect(check([first, second, third], note, "1.3.0", true, false)).resolves.toBeGreaterThan(0);
  });

  it("requires a Migration line naming every new entry and an explicit pre-bump target", async () => {
    await expect(check([first, second, third], "Added `third`."))
      .rejects.toThrow(/appended third without a Migration: line/u);
    await expect(check([first, second, third, row("fourth", 4)], "Migration: Add `third`."))
      .rejects.toThrow(/appended fourth without a Migration: line/u);
    await expect(check([first, second, third], "Migration: Add `third`.", "1.3.0"))
      .rejects.toThrow(/starting with In 1\.4\.0/u);
  });

  it.each([
    ["reorder", [second, first, third], /changed or removed released entry at index 0/u],
    ["removal", [first], /changed or removed released entry at index 1/u],
    ["edit", [first, row("second", 9), third], /changed or removed released entry at index 1/u],
    ["incompatible new entry", [first, second, '{ readonly id: "third" }'], /incompatible value field/u],
  ])("refuses a registry %s", async (_, entries, message) => {
    await expect(check(entries, "Migration: Add `third`.")).rejects.toThrow(message);
  });

  it("refuses patch appends and removing a released tag", async () => {
    await expect(check([first, second, third], "Migration: In 1.4.0, append `third`.", "1.3.1"))
      .rejects.toThrow(/appended entries in 1\.3\.1; move the append to a minor release/u);
    await expect(check([first, second], "", "1.4.0", false)).rejects.toThrow(/must keep its tagged readonly tuple/u);
  });

  it("refuses an append-only tag on a candidate-only unlisted declaration", async () => {
    const before = pack(declaration([first, second]), "1.3.0");
    const after = pack(declaration([first, second]) + "\n/** @appendOnly */\nexport declare const OTHER: readonly [];", "1.4.0");
    await expect(checkReleasedApi(root, [entry], [after], [before])).rejects.toThrow(/@appendOnly is reserved for @openlup\/platform\/catalog → CATALOG_MIGRATIONS/u);
  });
});

describe("authorized major removals", () => {
  it("requires an exact entry for each export and a published deprecation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "released-api-policy-"));
    roots.push(directory);
    mkdirSync(join(directory, entry.directory, "changes"), { recursive: true });
    mkdirSync(join(directory, "node_modules"));
    writeFileSync(join(directory, entry.directory, "CHANGELOG.md"), "## [2.0.0]\n");
    const before = "/** @deprecated Use next. */\nexport declare const old: string;\n/** @deprecated Use next. */\nexport declare const other: string;";
    const after = "export declare const next: string;";
    const released = fixturePack(before), major = fixturePack(after, "2.0.0"), minor = fixturePack(after, "1.4.0");
    const fragment = join(directory, entry.directory, "changes/removal.md");
    const removal = (name: string) => `### Stable API removal\nSubpath: @openlup/platform\nSymbol: ${name}\nBridge minor: 1.3\nTarget major: 2\nUpgrade action: Import next.\n`;
    const check = (candidate: Pack, authorizedMajor?: string, baseline = released) => checkReleasedApi(directory, [entry], [candidate], [baseline], authorizedMajor);
    await expect(check(major, "2")).rejects.toThrow(/→ old:/u);
    writeFileSync(fragment, removal("old"));
    await expect(check(major, "2")).rejects.toThrow(/^Stable API break against @openlup\/platform@1\.3\.0 — @openlup\/platform → other:/u);
    writeFileSync(fragment, removal("old") + "\n" + removal("other"));
    await expect(check(major)).rejects.toThrow(/→ old:/u);
    await expect(check(minor, "2")).rejects.toThrow(/→ old:/u);
    await expect(check(major, "2", fixturePack(before.replaceAll("@deprecated", "@remarks")))).rejects.toThrow(/→ old:/u);
    await expect(check(major, "2")).resolves.toBeGreaterThan(0);
  });
});

describe("baseline refusal", () => {
  const names = ["@openlup/core", "@openlup/platform", "@openlup/outbox"];
  const reply = (version: string, name: string) => Response.json({
    name, version, dist: {
      integrity: `sha512-${"A".repeat(86)}==`,
      tarball: `https://registry.npmjs.org/${name}/-/${name.split("/")[1]}-${version}.tgz`,
    },
  });
  it("resolves every latest once and refuses partial publication", async () => {
    const requested: string[] = [];
    const mock: typeof fetch = async input => {
      const pathname = new URL(String(input)).pathname;
      requested.push(pathname);
      const name = decodeURIComponent(pathname.slice(1)).replace(/\/latest$/u, "");
      return reply(name.endsWith("/platform") ? "1.4.0" : "1.3.0", name);
    };
    await expect(resolveLatest(names, mock)).rejects.toThrow(/mixed set.*Check npm's latest tags/u);
    expect(requested).toEqual(names.map(name => `/${name.replace("/", "%2f")}/latest`));
    await expect(resolveLatest(names, async () => new Response(null, { status: 404 }))).rejects.toThrow(/missing @openlup\/core@latest/u);
  });

  it("refuses missing local packs and incoherent peer pins", async () => {
    const pack = fixturePack("export declare const current: string;");
    const mixed = fixturePack("export declare const current: string;", "1.3.0", undefined, { "@openlup/core": "1.2.0" });
    await expect(checkReleasedApi(root, [entry], [pack], [])).rejects.toThrow(/missing or extra packs/u);
    await expect(checkReleasedApi(root, [entry], [pack], [mixed])).rejects.toThrow(/mixed peer pins.*@openlup\/core@1\.2\.0/u);
  });
});
