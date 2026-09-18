import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(process.env.COVERAGE_REPO_ROOT || process.cwd());
const summaryPath = path.resolve(
  process.env.COVERAGE_SUMMARY_PATH
    || path.join(process.env.VITEST_COVERAGE_DIR || "coverage", "coverage-summary.json"),
);
const exemptionsPath = path.resolve(
  process.env.BACKEND_COVERAGE_EXEMPTIONS_PATH
    || path.join(repoRoot, "config/backend-coverage-exemptions.json"),
);

if (!fs.existsSync(summaryPath)) {
  console.error(`${path.relative(process.cwd(), summaryPath) || summaryPath} not found. Run coverage first.`);
  process.exit(1);
}

const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
if (!fs.existsSync(exemptionsPath)) {
  console.error(`${path.relative(repoRoot, exemptionsPath) || exemptionsPath} not found.`);
  process.exit(1);
}
const exemptions = JSON.parse(fs.readFileSync(exemptionsPath, "utf8"));
if (exemptions.schemaVersion !== 1 || !Array.isArray(exemptions.thinEntrypointRules) || !Array.isArray(exemptions.baselineDebt)) {
  console.error("Backend coverage exemptions must use schemaVersion 1 with thinEntrypointRules and baselineDebt arrays.");
  process.exit(1);
}

const thinRules = exemptions.thinEntrypointRules.map((rule) => ({
  ...rule,
  pattern: new RegExp(rule.pathPattern),
}));
const baselineDebt = new Map(exemptions.baselineDebt.map((entry) => [entry.path, entry]));

function relativeFile(file) {
  const absolute = path.resolve(file);
  return absolute.startsWith(`${repoRoot}${path.sep}`)
    ? path.relative(repoRoot, absolute).split(path.sep).join("/")
    : file.split(path.sep).join("/");
}

function fileLines(file) {
  const absolute = path.join(repoRoot, file);
  return fs.existsSync(absolute) ? fs.readFileSync(absolute, "utf8").split(/\r?\n/).length : Number.POSITIVE_INFINITY;
}

function thinExemption(file) {
  return thinRules.find((rule) => rule.pattern.test(file) && fileLines(file) <= rule.maxLines);
}

const today = new Date().toISOString().slice(0, 10);
for (const [file, entry] of baselineDebt) {
  if (!entry.owner || !entry.reason || !/^\d{4}-\d{2}-\d{2}$/.test(entry.expires || "")) {
    console.error(`Invalid baseline coverage debt entry: ${file}`);
    process.exit(1);
  }
  if (entry.expires < today) {
    console.error(`Expired backend coverage debt: ${file} (${entry.expires})`);
    process.exit(1);
  }
  if (!fs.existsSync(path.join(repoRoot, file))) {
    console.error(`Stale backend coverage debt path: ${file}`);
    process.exit(1);
  }
}

const ignored = [
  /\.test\./,
  /\.spec\./,
  /src\/test\//,
  /src\/vite-env\.d\.ts$/,
  /src\/integrations\/supabase\/types\.ts$/,
  /src\/components\/ui\//,
  // pet-personalizer: feature module, tests planned as follow-up.
  /src\/pages\/pet-personalizer\//,
  /src\/components\/pet-personalizer\//,
  /src\/lib\/pet-personalizer\//,
  /src\/types\/pet-personalizer\.ts$/,
];

const zeroLineFiles = Object.entries(summary)
  .filter(([file]) => file !== "total")
  .map(([file, data]) => ({
    file: relativeFile(file),
    lines: data.lines?.pct ?? 0,
    totalLines: data.lines?.total ?? 0,
  }))
  .filter(({ file, totalLines }) => totalLines > 0 && !ignored.some((re) => re.test(file)))
  .filter(({ lines }) => lines === 0)
  .map(({ file }) => ({ file, exempt: thinExemption(file) || baselineDebt.get(file) }))
  .filter(({ exempt }) => !exempt)
  .map(({ file }) => file)
  .sort();

const coveredFiles = new Set(Object.entries(summary)
  .filter(([file]) => file !== "total")
  .filter(([, data]) => (data.lines?.total ?? 0) > 0 && (data.lines?.pct ?? 0) > 0)
  .map(([file]) => relativeFile(file)));
const staleDebt = [...baselineDebt.keys()].filter((file) => coveredFiles.has(file));

if (staleDebt.length > 0) {
  console.error("Covered backend files still have baseline-debt exemptions; remove them:");
  for (const file of staleDebt) console.error(`- ${file}`);
  process.exit(1);
}

if (zeroLineFiles.length > 0) {
  console.error("Files with 0% line coverage are not allowed:");
  for (const file of zeroLineFiles) console.error(`- ${file}`);
  process.exit(1);
}

console.log("No ungoverned 0% line coverage files found.");
