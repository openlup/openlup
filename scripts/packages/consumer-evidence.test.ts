import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { consumerEvidence } from "./consumer-evidence.mjs";

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

it.each(["core", "outbox", "platform"])("maps every %s export directly from its existing smoke evidence", name => {
  const directory = `../../packages/${name}/`;
  const manifest = read(directory + "package.json"), gates = read(directory + "release-gates.json");
  const rows = consumerEvidence(manifest, gates);
  expect(rows.map(row => row.specifier)).toEqual(Object.keys(manifest.exports).map(path => manifest.name + (path === "." ? "" : path.slice(1))));
  for (const [index, subpath] of Object.keys(manifest.exports).entries()) {
    expect(rows[index].packageSmokeEvidence).toEqual(gates.packageSurface[subpath].packageSmokeEvidence);
    expect(rows[index].sourceCheck.args.slice(4)).toEqual(gates.packageSurface[subpath].packageSmokeEvidence);
    expect(rows[index].sourceCheck.workingDirectory).toBe(`packages/${name}`);
    expect(rows[index].consumerCheck).toEqual({ executable: "node", args: ["--input-type=module", "--eval", `await import(${JSON.stringify(rows[index].specifier)});`] });
    expect(rows[index].doesNotProve).toContain("Behavioural conformance");
  }
});

it("executes a projected consumer command through Node", () => {
  const rows = consumerEvidence(read("../../packages/outbox/package.json"), read("../../packages/outbox/release-gates.json"));
  expect(rows[0].specifier).toBe("@openlup/outbox");
  // Execute a projected command against the built public workspace artifact.
  expect(() => execFileSync(rows[0].consumerCheck.executable, rows[0].consumerCheck.args, { timeout: 10_000 })).not.toThrow();
});

it("refuses missing mappings and unrepresented smoke evidence", () => {
  const manifest = { name: "@openlup/example", exports: { ".": {} } };
  expect(() => consumerEvidence(manifest, { packageSurface: {} })).toThrow("export_mismatch");
  expect(() => consumerEvidence(manifest, { packageSurface: { ".": { packageSmokeEvidence: [] } } })).toThrow("smoke_evidence_required");
});
