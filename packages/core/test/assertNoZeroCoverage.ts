import { readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

interface CoverageMetric {
  total: number;
  covered: number;
}

interface CoverageEntry {
  lines: CoverageMetric;
}

const packageRoot = resolve(import.meta.dirname, "..");
const summaryPath = resolve(packageRoot, "coverage/coverage-summary.json");
const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as Record<string, CoverageEntry>;
const productionEntries = Object.entries(summary)
  .filter(([path]) => path !== "total")
  .map(([path, entry]) => ({ path: relative(packageRoot, path).split(sep).join("/"), entry }))
  .filter(({ path }) => path.startsWith("src/"));

if (productionEntries.length === 0) {
  throw new Error("Coverage summary contains no package production source");
}

const zeroCovered = productionEntries
  .filter(({ entry }) => entry.lines.total > 0 && entry.lines.covered === 0)
  .map(({ path }) => path)
  .sort();

if (zeroCovered.length > 0) {
  throw new Error(`Package production files with zero covered lines:\n${zeroCovered.join("\n")}`);
}

console.log("core coverage no-zero source check ok");
