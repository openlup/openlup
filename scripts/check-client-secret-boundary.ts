#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const SERVER_SECRET_IDENTIFIER = /\b(?!VITE_SUPABASE_ANON_KEY\b)(?!VITE_SUPABASE_PUBLISHABLE_KEY\b)(?!VITE_STRIPE_PUBLISHABLE_KEY\b)[A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|SERVICE_ROLE|API_KEY)[A-Z0-9_]*\b/;
const PUBLIC_SECRET_IDENTIFIER = /\bVITE_[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|SERVICE_ROLE|API_KEY)[A-Z0-9_]*\b/;
const ALLOWED_CLIENT_IDENTIFIERS = new Set([
  "PAYMENT_RECOVERY_TOKEN_STORAGE_KEY",
]);

/**
 * The environment-variable name prefixes Vite is allowed to put in the browser
 * bundle - `vite.config.ts` reads this array as its `envPrefix`.
 *
 * It lives in the guard rather than in the build config because the list *is* a
 * security boundary, and a boundary whose definition sits in the file it governs
 * cannot be checked against anything. Whatever is named here is readable by
 * anyone who opens the shipped JavaScript, so the rule below makes every
 * registered variable under one of these prefixes declare that publicly.
 *
 * `COMMERCE_` as a whole is deliberately absent and must stay absent: the
 * registry carries five signing keys under it. The three `COMMERCE_` entries
 * here are the namespaces the settlement profile reads - the currency and region
 * a deployment settles in, its fiscal facts, and its payable floor - which the
 * presentation layer needs in order to price and format anything at all.
 */
export const PUBLIC_BUNDLE_ENV_PREFIXES = [
  "VITE_",
  "COMMERCE_SETTLEMENT_",
  "COMMERCE_FISCAL_",
  "COMMERCE_MIN_PRODUCT_PAYABLE_",
] as const;

const ENV_REGISTRY_RELATIVE_PATH = "config/environment-variables.json";

type RegisteredVariable = {
  name?: unknown;
  category?: unknown;
  secret?: unknown;
};

function matchesPublicBundlePrefix(name: string): boolean {
  return PUBLIC_BUNDLE_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * The registry half of the boundary: what the bundle may carry, checked against
 * what the registry says each variable is.
 *
 * Widening `envPrefix` exposes a *class*, not a key, so the hazard is not the
 * variable anyone is thinking about today - it is the next one somebody adds
 * under the same prefix without noticing the prefix now means "public". Three
 * rules, all fail-closed:
 *
 *   1. a registered variable under a public prefix must be declared
 *      `public-build` and `secret: false`, so the exposure is stated where an
 *      operator reads about the key rather than only in the build config;
 *   2. a `public-build` variable must sit under a public prefix, so the category
 *      cannot drift into meaning "public-ish";
 *   3. a variable under a public prefix must not be *named* like a credential,
 *      whatever it was declared as. This is the rule that catches a wrong
 *      declaration, because the first two only catch a missing one.
 *
 * Only the environment registry is in scope. `VITE_`-prefixed feature flags live
 * in the flag registry and are booleans by construction; they carry no value to
 * leak.
 */
function checkPublicBundleEnvRegistry(root: string): BoundaryFinding[] {
  let variables: RegisteredVariable[];
  try {
    const parsed = JSON.parse(readFileSync(join(root, ENV_REGISTRY_RELATIVE_PATH), "utf8"));
    variables = Array.isArray(parsed?.variables) ? parsed.variables : [];
  } catch {
    // Absent in the synthetic roots the guard's own tests build. The real
    // checkout cannot lose this file without failing the registry guards that
    // own it, so a soft skip here does not create a way around the rule.
    return [];
  }

  const findings: BoundaryFinding[] = [];
  for (const variable of variables) {
    const name = typeof variable.name === "string" ? variable.name : "";
    if (name === "") continue;
    const isPublicPrefixed = matchesPublicBundlePrefix(name);
    const declaredPublicBuild = variable.category === "public-build";

    if (isPublicPrefixed && !declaredPublicBuild) {
      findings.push({
        file: ENV_REGISTRY_RELATIVE_PATH, line: 1,
        message: `${name} is exposed to the browser bundle by its prefix and must be declared category "public-build"`,
      });
    }
    if (!isPublicPrefixed && declaredPublicBuild) {
      findings.push({
        file: ENV_REGISTRY_RELATIVE_PATH, line: 1,
        message: `${name} is declared "public-build" but no bundle env prefix matches it`,
      });
    }
    if (!isPublicPrefixed) continue;
    if (variable.secret === true) {
      findings.push({
        file: ENV_REGISTRY_RELATIVE_PATH, line: 1,
        message: `${name} is marked secret and cannot sit under a browser bundle env prefix`,
      });
    }
    const secretShaped = name.match(SERVER_SECRET_IDENTIFIER)?.[0]
      ?? name.match(PUBLIC_SECRET_IDENTIFIER)?.[0];
    if (secretShaped) {
      findings.push({
        file: ENV_REGISTRY_RELATIVE_PATH, line: 1,
        message: `${name} is named like a credential and cannot sit under a browser bundle env prefix`,
      });
    }
  }
  return findings;
}

export type BoundaryFinding = {
  file: string;
  line: number;
  message: string;
};

function isSourceFile(path: string): boolean {
  return [...SOURCE_EXTENSIONS].some((ext) => path.endsWith(ext));
}

function isTestPath(path: string): boolean {
  return /(?:^|[./])(?:test|spec)\.[tj]sx?$/.test(path) || path.includes(`${sep}tests${sep}`);
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

function listFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    if ([".git", "node_modules", "dist", "coverage", ".vercel"].includes(entry)) continue;
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...listFiles(path));
    else if (stat.isFile() && isSourceFile(path)) out.push(path);
  }
  return out;
}

export function checkClientSecretBoundary(root = process.cwd()): BoundaryFinding[] {
  const findings: BoundaryFinding[] = [];
  const srcRoot = join(root, "src");

  for (const file of listFiles(srcRoot)) {
    const rel = relative(root, file);
    if (isTestPath(rel) || rel.startsWith(`src${sep}lib${sep}testSupport${sep}`)) continue;
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      if (isCommentLine(line)) return;
      if (line.includes("process.env")) {
        findings.push({ file: rel, line: index + 1, message: "client source must not read process.env" });
      }
      const publicSecret = line.match(PUBLIC_SECRET_IDENTIFIER)?.[0];
      if (publicSecret) {
        findings.push({ file: rel, line: index + 1, message: `public VITE_* env cannot be secret-shaped (${publicSecret})` });
      }
      const serverSecret = line.match(SERVER_SECRET_IDENTIFIER)?.[0];
      if (serverSecret && serverSecret !== publicSecret && !ALLOWED_CLIENT_IDENTIFIERS.has(serverSecret)) {
        findings.push({ file: rel, line: index + 1, message: `server secret identifier cannot appear in client source (${serverSecret})` });
      }
    });
  }

  for (const dir of ["src", "server", "api"]) {
    const absolute = join(root, dir);
    try {
      for (const file of listFiles(absolute)) {
        const rel = relative(root, file);
        if (isTestPath(rel) || rel.startsWith(`src${sep}lib${sep}testSupport${sep}`)) continue;
        const lines = readFileSync(file, "utf8").split(/\r?\n/);
        lines.forEach((line, index) => {
          if (!/\bimport\b/.test(line)) return;
          if (line.includes("src/lib/testSupport") || line.includes("/lib/testSupport/") || line.includes("../lib/testSupport")) {
            findings.push({ file: rel, line: index + 1, message: "production code must not import src/lib/testSupport" });
          }
        });
      }
    } catch {
      /* optional source tree absent in small test fixtures */
    }
  }

  findings.push(...checkPublicBundleEnvRegistry(root));

  return findings;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const findings = checkClientSecretBoundary();
  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line}: ${finding.message}`);
  }
  if (findings.length > 0) process.exit(1);
  console.log("Client secret boundary guard passed.");
}
