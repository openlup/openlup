import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const repositoryUrl = "https://github.com/openlup/openlup";
export const publishedPackages = ["core", "outbox", "platform"] as const;

export function readCoreVersion(repositoryRoot: string): string {
  return (JSON.parse(readFileSync(join(repositoryRoot, "packages/core/package.json"), "utf8")) as { version: string }).version;
}

export function repositoryLink(coreVersion: string, path: string, label = path): string {
  return `[${label}](${repositoryUrl}/blob/openlup-core-v${coreVersion}/${path})`;
}

export function markdownTable(headings: string[], rows: string[][]): string {
  const cell = (value: string) => value.replaceAll("|", "&#124;").replace(/\r?\n/g, "<br>");
  return [headings, headings.map(() => "---"), ...rows].map((row) => `| ${row.map(cell).join(" | ")} |\n`).join("");
}

export function renderSqlInventory(name: string, repositoryRoot: string, coreVersion = readCoreVersion(repositoryRoot)): string | undefined {
  const pkg = /^sql:([a-z]+)$/.exec(name)?.[1];
  if (!pkg || pkg === "core" || !(publishedPackages as readonly string[]).includes(pkg)) return undefined;
  const base = `packages/${pkg}/sql`;
  // Include shipped SQL outside the migration manifest. File-name order is distinct from catalogue order.
  const files = readdirSync(join(repositoryRoot, base), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
  return markdownTable(["File"], files.map((file) => [repositoryLink(coreVersion, `${base}/${file}`, `\`${file}\``)]));
}
