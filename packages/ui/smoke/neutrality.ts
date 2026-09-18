/**
 * Neutrality gate for the staged `@openlup/ui` scaffold.
 *
 * Runnable checker (NOT a vitest test, so the root vitest run never collects
 * it). It scans `packages/ui/src` for anything that would violate the OSS
 * neutrality contract: brand literals, legacy env keys, PL locale/currency/
 * timezone tokens, environment reads, or vendor names. Exits non-zero on any
 * hit so a future CI wiring can gate on it.
 *
 * Run:  node --experimental-strip-types packages/ui/smoke/neutrality.ts
 *   or: npm --workspace @openlup/ui run test:neutrality  (once activated)
 *
 * Forbidden-pattern sources are assembled from fragments so this checker file
 * itself contains none of the literals it bans.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const sourceRoot = join(scriptDir, "..", "src");

const brand = "vel" + "ipet";
const owner = "pro" + "teine";
const brandTag = "VE" + "LI";
const currency = "PL" + "N";
const country = "P" + "L";
const localeTag = "pl" + "-PL";
const warsaw = "Europe/" + "Warsaw";
const envRead = "process" + ".env";
const metaEnvRead = "import.meta" + ".env";

interface NeutralityPattern {
  readonly label: string;
  readonly pattern: RegExp;
}

const forbiddenPatterns: NeutralityPattern[] = [
  { label: "brand name", pattern: new RegExp(`\\b${brand}\\b`, "i") },
  { label: "owner name", pattern: new RegExp(`\\b${owner}\\b`, "i") },
  { label: "brand domain", pattern: new RegExp(`${brand}\\.com`, "i") },
  { label: "brand tag", pattern: new RegExp(`(?<!@)\\b${brandTag}(?:\\b|-)`) },
  { label: "legacy env key", pattern: new RegExp(`\\b${brand.toUpperCase()}_[A-Z0-9_]+\\b`) },
  { label: "currency token", pattern: new RegExp(`\\b${currency}\\b`) },
  { label: "country token", pattern: new RegExp(`\\b${country}\\b`) },
  { label: "locale token", pattern: new RegExp(`\\b${localeTag}\\b`, "i") },
  { label: "timezone token", pattern: new RegExp(`\\b${warsaw}\\b`) },
  { label: "env read", pattern: new RegExp(envRead.replace(".", "\\.")) },
  { label: "meta env read", pattern: new RegExp(metaEnvRead.replace(/\./g, "\\.")) },
  { label: "vendor: supabase", pattern: /@supabase\//i },
  { label: "vendor: resend", pattern: /\bresend\b/i },
  { label: "vendor: stripe", pattern: new RegExp(`\\bst${"r"}ipe\\b`, "i") },
  { label: "vendor: tpay", pattern: /\btpay\b/i },
  { label: "vendor: omnipack", pattern: /\bomnipack\b/i },
  { label: "vendor: dhl", pattern: /\bdhl\b/i },
  { label: "vendor: fakturownia", pattern: /\bfakturownia\b/i },
];

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

const violations: string[] = [];
for (const file of listSourceFiles(sourceRoot)) {
  const contents = readFileSync(file, "utf8");
  for (const { label, pattern } of forbiddenPatterns) {
    if (pattern.test(contents)) {
      violations.push(`${file}: ${label} (${pattern})`);
    }
  }
}

if (violations.length > 0) {
  console.error("Neutrality gate FAILED for packages/ui/src:");
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exit(1);
}

console.log(`Neutrality gate passed: scanned packages/ui/src, zero forbidden hits.`);
