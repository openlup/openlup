/** Refresh derived bindings only in a reviewed release-preparation change. The catalog stays authored. */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { SOURCE_RELEASE_CONTRACT_PATH, deriveSourceReleaseContract } from "./oss-source-release-contract.ts";
import { liveSourceInventory, publicInventoryVerdict } from "./oss-published-tree-check.ts";

/** Plan and validate before any write; replacing the one snapshot is atomic per file. */
export function prepareSourceRelease(root: string, mode: "--write" | "--check", log: (line: string) => void = console.log): boolean {
  if (!publicInventoryVerdict(root, log)) throw new Error("source release preparation refuses invalid live inventory or migration manifest");
  const path = join(root, SOURCE_RELEASE_CONTRACT_PATH);
  const current = readFileSync(path, "utf8");
  const planned = deriveSourceReleaseContract((file) => existsSync(join(root, file)) ? readFileSync(join(root, file)) : undefined, liveSourceInventory(root)).contents;
  if (mode === "--check") {
    if (current !== planned) throw new Error("source snapshot stale: contract differs byte-for-byte; run scripts/source-release-preparation.ts --write at release prep");
    return false;
  }
  if (current === planned) return false;
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, planned, { flag: "wx", mode: 0o644 });
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  log(`refreshed ${SOURCE_RELEASE_CONTRACT_PATH}`);
  return true;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 1 || (args[0] !== "--write" && args[0] !== "--check")) throw new Error("usage: source-release-preparation.ts --write | --check");
    prepareSourceRelease(process.cwd(), args[0]);
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
