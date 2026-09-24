import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { FIXED_BOX_CONSUMER_MARKER } from "./core-package-consumer-fixed-box-fixture.ts";
import {
  scanNeutralitySource,
  type SourceNeutralityPolicy,
} from "./neutrality-source-scanner.ts";

type ExportEntry = Record<string, string>;

export type CorePackageJson = {
  name: string;
  version: string;
  private?: boolean;
  license?: string;
  publishConfig?: unknown;
  repository?: unknown;
  files?: string[];
  scripts?: Record<string, string>;
  exports: Record<string, ExportEntry>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

type AuditInput = {
  packageRoot: string;
  packageName: string;
  packageJson: CorePackageJson;
  packageReadme: string;
  packFiles: string[];
};

// This policy is intentionally readable: it inspects packed production artifacts,
// not this repository-side audit script or test fixtures.
const forbiddenPackagedContent = [
  { description: "runtime environment access", pattern: /\b(?:process\.env|import\.meta\.env)\b/ },
  {
    description: "downstream provider dependency",
    pattern: /@supabase\/|\b(?:resend|stripe|tpay|omnipack|dhl|fakturownia|openai|gtm|googletagmanager|axiom|svix|calendly)\b|@gmail\b/i,
  },
  { description: "downstream phone country code", pattern: /\+48\b/ },
  { description: "owner-local path", pattern: /\/(?:Users|private\/tmp)\// },
];
const packagedNeutralityPolicy: SourceNeutralityPolicy = {
  productionScope: {
    activeClasses: ["brand", "legacy-env"],
  },
  rules: [
    { id: "packed-brand", category: "brand", mode: "identifier", terms: ["velipet", "proteine", "veli-"] },
    { id: "packed-env", category: "legacy-env", mode: "environment-prefix", terms: ["VELIPET_"] },
  ],
};
const approvedDogfoodEvidence = "A private product currently imports candidate package seams; this does not establish a public platform adopter seam.";
const extensionlessTextPackFiles = new Set(["LICENSE"]);
const approvedPublicSecurityContact = "dev@openlup.com";
const previewChannelVersion = /^0\.[1-9]\d*\.0$/;
const approvedPublishConfig = { access: "public", provenance: true, tag: "preview" };
const approvedRepository = { type: "git", url: "git+https://github.com/openlup/openlup.git", directory: "packages/core" };
const simpleStringLiteralSource = String.raw`["'][A-Za-z0-9._@:/+ -]{1,64}["']`;
const simpleLiteralConcatPattern = new RegExp(
  `${simpleStringLiteralSource}(?:\\s*\\+\\s*${simpleStringLiteralSource}){1,7}`,
  "g",
);
const simpleLiteralArrayJoinPattern = new RegExp(
  `\\[\\s*${simpleStringLiteralSource}(?:\\s*,\\s*${simpleStringLiteralSource}){1,7}\\s*\\]\\s*\\.join\\(\\s*(?:''|"")\\s*\\)`,
  "g",
);
const simpleStringLiteralPattern = /["']([A-Za-z0-9._@:/+ -]{1,64})["']/g;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function packageTargetPath(target: string): string {
  assert(target.startsWith("./"), `package export target must be package-relative: ${target}`);
  return target.slice(2);
}

export function assertCorePackagePortabilityProof(input: AuditInput): void {
  assertPacklist(input.packageJson, input.packFiles);
  assertPublishablePackageAudit(input);
  assertPackagedContent(input);
}

function assertPacklist(packageJson: CorePackageJson, packFiles: string[]): void {
  const packed = new Set(packFiles);
  const requiredFiles = new Set([
    "CHANGELOG.md",
    "CODE_OF_CONDUCT.md",
    "CONTRIBUTING.md",
    "LICENSE",
    "MAINTAINERS.md",
    "README.md",
    "SECURITY.md",
    "package.json",
    "release-gates.json",
  ]);

  for (const [subpath, entry] of Object.entries(packageJson.exports)) {
    requiredFiles.add(packageTargetPath(entry["core-source"]));
    requiredFiles.add(packageTargetPath(entry.node));
    requiredFiles.add(packageTargetPath(entry.types));

    assert(entry.node?.startsWith("./dist/"), `${subpath} node export must point at dist`);
    assert(entry.types?.startsWith("./dist/"), `${subpath} types export must point at dist`);
    assert(entry["core-source"]?.startsWith("./src/"), `${subpath} authoring export must point at packed source`);
  }

  const missingFiles = [...requiredFiles].filter((path) => !packed.has(path)).sort();
  assert(missingFiles.length === 0, `packed core tarball is missing required files: ${missingFiles.join(", ")}`);

  const forbiddenFiles = packFiles.filter(
    (path) =>
      path.startsWith("smoke/") ||
      path.startsWith("docs/") ||
      path.startsWith(".context/") ||
      path === "vitest.config.ts" ||
      path.startsWith("tsconfig."),
  );
  assert(forbiddenFiles.length === 0, `packed core tarball contains non-runtime files: ${forbiddenFiles.join(", ")}`);
}

function assertPublishablePackageAudit({
  packageJson,
  packageReadme,
  packFiles,
}: AuditInput): void {
  assert((packageJson.private ?? false) === false, "core package must be publishable, not private");
  assert(
    previewChannelVersion.test(packageJson.version),
    `core package version must be a preview-channel version 0.<n>.0, not ${packageJson.version}`,
  );
  assert(
    isDeepStrictEqual(packageJson.publishConfig, approvedPublishConfig),
    `core package publishConfig must be exactly ${JSON.stringify(approvedPublishConfig)}`,
  );
  assert(
    isDeepStrictEqual(packageJson.repository, approvedRepository),
    `core package repository must be exactly ${JSON.stringify(approvedRepository)}`,
  );
  assert(packageJson.license === "Apache-2.0", "core package must carry Apache-2.0 license metadata");
  assert(packageJson.files?.includes("LICENSE") === true, "core package files must include LICENSE");
  assert(packageJson.scripts?.prepack === "npm run build", "core package must build before pack");
  assert(packageReadme.includes("| Export | Role | Maturity | Package smoke |"), "README maturity table must identify package smoke evidence");
  assert(packageReadme.includes("| `./subscription` | kernel | candidate |"), "subscription must stay a candidate kernel surface");
  assert(packageReadme.includes("| `./bundle` | kernel | candidate |"), "bundle must stay a candidate kernel surface");
  assert(packageReadme.includes("| `./pricing` | kernel | candidate |"), "pricing must stay a candidate kernel surface");
  assert(FIXED_BOX_CONSUMER_MARKER === "fixed-box packed consumer ok", "fixed-box consumer marker drifted");

  const dependencySpecs = [
    ...Object.values(packageJson.dependencies ?? {}),
    ...Object.values(packageJson.peerDependencies ?? {}),
  ];
  const localDependencySpecs = dependencySpecs.filter((spec) => /^(file:|workspace:|link:)/.test(spec));
  assert(localDependencySpecs.length === 0, `core package dependencies must not use local specs: ${localDependencySpecs.join(", ")}`);

  const packed = new Set(packFiles);
  assert(packed.has("LICENSE"), "packed core tarball must include LICENSE");
  assert(!packFiles.some((file) => file.startsWith("scripts/")), "packed core tarball must not include repo scripts");
}

function assertPackagedContent({ packageRoot, packageName, packFiles }: AuditInput): void {
  const textFiles = packFiles.filter((path) => {
    const isKnownText = extensionlessTextPackFiles.has(path) || /\.(d\.ts|js|json|md|ts)$/.test(path);
    assert(isKnownText, `packed core tarball has an unclassified file; classify it before scanning: ${path}`);
    return isKnownText;
  });
  const violations = textFiles.flatMap((path) => {
    const source = readFileSync(join(packageRoot, path), "utf8")
      .replaceAll(packageName, "PACKAGE_NAME")
      .replaceAll(approvedPublicSecurityContact, "APPROVED_SECURITY_CONTACT");
    const approvedSource = path === "release-gates.json"
      ? normalizeApprovedDogfoodEvidence(source)
      : source;
    const auditableSource = normalizeSimpleLiteralCompositions(approvedSource);
    const semanticViolations = Object.entries(scanNeutralitySource(auditableSource, packagedNeutralityPolicy))
      .filter(([, count]) => count > 0)
      .map(([category]) => `${path}: downstream ${category}`);
    return [
      ...semanticViolations,
      ...forbiddenPackagedContent
      .filter(({ pattern }) => pattern.test(auditableSource))
      .map(({ description }) => `${path}: ${description}`),
    ];
  });

  assert(violations.length === 0, `packed core tarball contains downstream leakage:\n${violations.join("\n")}`);
}

function normalizeSimpleLiteralCompositions(source: string): string {
  const collapse = (expression: string) =>
    [...expression.matchAll(simpleStringLiteralPattern)]
      .map((match) => match[1])
      .join("");
  return source
    .replace(simpleLiteralArrayJoinPattern, collapse)
    .replace(simpleLiteralConcatPattern, collapse);
}

function normalizeApprovedDogfoodEvidence(source: string): string {
  const releaseGates = JSON.parse(source) as {
    evidence?: { dogfoodEvidence?: { meaning?: unknown } };
  };
  const meaning = releaseGates.evidence?.dogfoodEvidence?.meaning;
  assert(
    meaning === approvedDogfoodEvidence,
    "packed release-gates.json dogfood evidence must retain its exact approved wording",
  );
  releaseGates.evidence!.dogfoodEvidence!.meaning = "APPROVED_PRIVATE_DOGFOOD_EVIDENCE";
  return JSON.stringify(releaseGates);
}
