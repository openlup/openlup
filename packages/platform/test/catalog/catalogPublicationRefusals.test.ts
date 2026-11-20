import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";
import { publicationPriceRefusalReason } from "../../src/catalog/publicationError.js";

it("requires a remedy at the production table for every platform code", () => {
  const file = fileURLToPath(new URL("../../src/catalog/publicationError.ts", import.meta.url));
  const config = fileURLToPath(new URL("../../tsconfig.build.json", import.meta.url));
  const options = { ...ts.getParsedCommandLineOfConfigFile(config, {}, {
    ...ts.sys, onUnRecoverableConfigFileDiagnostic: diagnostic => { throw new Error(String(diagnostic.messageText)); },
  })!.options, noEmit: true, types: ["node"] };
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  const source = readFileSync(file, "utf8");
  const sentinel = "unmapped_refusal_sentinel";
  const extended = source.replace(/(export type PlatformCode\s*=)/u, `$1 "${sentinel}" |`);
  const table = "const publicationRefusals = {";
  const check = (replacement: string) => {
    host.readFile = name => name === file ? replacement : readFile(name);
    return ts.getPreEmitDiagnostics(ts.createProgram([file], options, host));
  };

  const diagnostics = check(extended);
  const missing = diagnostics.find(item => item.file?.fileName === file && item.code === 1360
    && ts.flattenDiagnosticMessageText(item.messageText, "\n").includes(sentinel));
  expect(missing).toBeDefined();
  const line = missing!.file!.getLineAndCharacterOfPosition(missing!.start!).line;
  expect(extended.split("\n")[line]).toContain("satisfies Record<PlatformCode, Remedy>");
  const fixed = extended.replace(table, `${table}\n  ${sentinel}: { fix: "Supply the missing value." },`);
  expect(check(fixed).map(item => ts.flattenDiagnosticMessageText(item.messageText, "\n"))).toEqual([]);
}, 30_000);

it("recognizes every price refusal literal emitted by the SQL claim and apply routines", () => {
  const sql = readFileSync(new URL("../../../../db/platform/migrations/20261123191000_catalog_publication_commands.sql", import.meta.url), "utf8");
  const claim = sql.split("CREATE FUNCTION public.catalog_price_setup_claim(")[1]!.split("\n$$;")[0]!;
  const apply = sql.split("CREATE FUNCTION public.catalog_price_setup_apply_claimed(")[1]!.split("\n$$;")[0]!;
  const caseRefusals = apply.match(/v_refusal\s*:=\s*CASE([\s\S]+?)\bEND;/u)?.[1] ?? "";
  const literals = [
    ...claim.matchAll(/'reason',\s*'([a-z_]+)'/gu),
    ...caseRefusals.matchAll(/\bTHEN\s*'([a-z_]+)'/gu),
    ...apply.matchAll(/\bv_refusal\s*:=\s*'([a-z_]+)'/gu),
  ].map(match => match[1]!);
  expect([...new Set(literals)].sort()).toEqual([...publicationPriceRefusalReason.options].sort());
});
