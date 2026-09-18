import { createHash } from "node:crypto";
import { validateSiteRouteManifest } from "./site-routes.mjs";
import { isValidPublicSecurityRoute, validateSourceReleaseContract } from "./oss-source-release-contract.ts";
import { carriesPrivateOperationalCoordinate, projectOperationalCoordinates } from "./oss-public-coordinate-detector.ts";
import { activateProjectedCoordinates, type PublicCoordinateProfile } from "./oss-neutralization-projection.ts";
import type { ProjectionWrite } from "./oss-publication-contract.ts";
export { carriesPrivateOperationalCoordinate } from "./oss-public-coordinate-detector.ts";
export {
  EXPLICIT_PUBLIC_PROJECTION_PATHS,
  PROJECTED_AGENTS_PATH,
  assertExplicitPublicProjectionWrites,
  projectPublicAgentGuide,
  projectPublicCorePackageConsumerAudit,
  projectPublicTestSetup,
} from "./oss-publication-contract.ts";
export type { ExplicitPublicProjectionPath, ProjectionWrite } from "./oss-publication-contract.ts";
function publicCoordinateDetectorLines(profile?: PublicCoordinateProfile): string[] { const repository = profile?.repository ?? "https://openlup.invalid/repository"; return ['import { createHash } from "node:crypto";', '', 'const digest = (contents: string): string => "sha256-" + createHash("sha256").update(contents).digest("hex");', `const exact: Array<[string, string]> = [[["https://github.com/example", "app"].join("/"), ${JSON.stringify(repository)}], [["An adopter conformance", "test"].join(" "), "Adopters SHOULD add a conformance test that"]];`, 'const descriptor = JSON.stringify({ exact });', 'export const NEUTRALIZATION_RULESET_DIGEST = digest(descriptor);', 'export function projectOperationalCoordinates(source: string, _path = ""): { contents: string; matches: number } { let contents = source; let matches = 0; for (const [value, replacement] of exact) { const count = contents.split(value).length - 1; if (count > 0) { contents = contents.split(value).join(replacement); matches += count; } } return { contents, matches }; }', 'export function carriesPrivateOperationalCoordinate(contents: string, _path = ""): boolean { return exact.some(([value]) => contents.includes(value)); }']; }
export function projectPublicCoordinateDetector(profile?: PublicCoordinateProfile): ProjectionWrite { const contents = `${publicCoordinateDetectorLines(profile).join("\n")}\n`; if (carriesPrivateOperationalCoordinate(contents, "scripts/oss-public-coordinate-detector.ts")) throw new Error("public coordinate detector projection carries a prohibited coordinate"); return { path: "scripts/oss-public-coordinate-detector.ts", contents }; }

export function projectPublicBffRouter(source: string): ProjectionWrite {
  const anchors = [
    'import route4 from "../../server/bff/admin/accounting/e2e-test.js";\n',
    '  { route: "/api/bff/admin/accounting/e2e-test", pattern: new RegExp("^/api/bff/admin/accounting/e2e-test/?$"), params: [], handler: route4 },\n',
    "export const routes: RouteEntry[] = [",
    "export default function bffRouter(req: VercelRequest, res: VercelResponse): Promise<unknown> { return dispatch(routes, req, res); }",
  ];
  if (anchors.some((anchor) => source.split(anchor).length !== 2)) throw new Error("api/bff/[...path].ts: source router anchors drifted");
  const contents = `import type { VercelRequest, VercelResponse } from "../../server/_lib/types/vercel.js";\nimport { dispatch, type RouteEntry } from "../../server/runtime/bffDispatch.js";\n\n/** The bounded public-reference runtime advertises no BFF capability. */\nexport const routes: RouteEntry[] = [];\nexport default function bffRouter(req: VercelRequest, res: VercelResponse): Promise<unknown> { return dispatch(routes, req, res); }\n`;
  return { path: "api/bff/[...path].ts", contents };
}
export const PUBLIC_REFERENCE_SITE_ROUTES_PATH = "config/public-reference-site-routes.json";
export const PROJECTED_SITE_ROUTES_PATH = "config/site-routes.json";
export const PUBLIC_REFERENCE_OCI_DOCKERFILE_PATH = "deploy/oci/public-reference.Dockerfile";
export const PUBLIC_REFERENCE_OCI_COMPOSE_PATH = "deploy/oci/public-reference-compose.yml";
export const PUBLIC_REFERENCE_CAPABILITY_MANIFEST_PATH = "config/public-reference-capability-manifest.json";
export const PROJECTED_OCI_DOCKERFILE_PATH = "Dockerfile";
export const PROJECTED_OCI_COMPOSE_PATH = "docker-compose.yml";
export const PUBLIC_REFERENCE_PR_TEMPLATE_PATH = ".github/public-reference-pull-request-template.md";
export const PROJECTED_PR_TEMPLATE_PATH = ".github/pull_request_template.md";
export const PROJECTED_ENVIRONMENT_VARIABLES_PATH = "config/environment-variables.json";
export const PROJECTED_CODE_OF_CONDUCT_PATH = "CODE_OF_CONDUCT.md";
export const PROJECTED_SECURITY_PATH = "SECURITY.md";
export const PROJECTED_INDEX_DOCUMENT_PATH = "index.html";
export const PUBLIC_REFERENCE_VITE_CONFIG_PATH = "vite.public-reference.config.ts";
export const PROJECTED_VITE_CONFIG_PATH = "vite.config.ts";
const DEPLOYMENT_EVIDENCE_FIELDS = ["Staging URL", "Preview URL", "Preview class", "Supabase target", "Provider mode", "Smoke evidence", "Data mutation risk", "Production deploy owner"] as const;
type DigestProjection<Path extends string = string> = { path: Path; contents: string; digest: string };
export type PublicTreeProjection = DigestProjection<typeof PROJECTED_SITE_ROUTES_PATH>;
export type PublicPullRequestTemplateProjection = DigestProjection<typeof PROJECTED_PR_TEMPLATE_PATH>;
export type PublicReferenceOciProjection = { dockerfile: DigestProjection<typeof PROJECTED_OCI_DOCKERFILE_PATH>; compose: DigestProjection<typeof PROJECTED_OCI_COMPOSE_PATH>; capability: DigestProjection<typeof PUBLIC_REFERENCE_CAPABILITY_MANIFEST_PATH> };
export type PublicPolicyProjection = DigestProjection<typeof PROJECTED_CODE_OF_CONDUCT_PATH | typeof PROJECTED_SECURITY_PATH>;
export type PublicEnvironmentVariablesProjection = DigestProjection<typeof PROJECTED_ENVIRONMENT_VARIABLES_PATH>;
export type PublicViteConfigProjection = DigestProjection<typeof PROJECTED_VITE_CONFIG_PATH>;
export const projectPublicDatabaseTypes = (): ProjectionWrite => ({ path: "src/integrations/supabase/types.ts", contents: `/** Unbound adopter seam. Replace with generated database types before enabling database adapters. */\nexport type Database = Record<string, any>;\nexport type Tables<Name extends string> = any;\n` });

export function projectPublicViteConfig(source: string): PublicViteConfigProjection {
  const required = ["publicReferenceViteConfig", "public-reference-import-closure", "src/public-reference", "export default defineConfig"];
  const forbidden = ["localBffPlugin", "deployment-overlay", "loadEnv(", "src/overlays/"];
  if (required.some((value) => !source.includes(value)) || forbidden.some((value) => source.includes(value))) throw new Error(`${PUBLIC_REFERENCE_VITE_CONFIG_PATH}: not a closed public-reference-only Vite config`);
  const contents = `export { publicReferenceViteConfig } from "./${PUBLIC_REFERENCE_VITE_CONFIG_PATH}";\nexport { default } from "./${PUBLIC_REFERENCE_VITE_CONFIG_PATH}";\n`;
  return { path: PROJECTED_VITE_CONFIG_PATH, contents, digest: digest(contents) };
}

/** Validate the exact private forwards omitted from a materialized public baseline. */
export function validateExactFlattenMigrationExclusions(
  flattenPrefix: string,
  families: Array<{ id: string; excludePrefixes?: unknown }>,
  rawExcluded: unknown,
  rawReasons: unknown,
  catalogLabel: string,
): string[] {
  const matches = families.filter((family) => family.id === "schema-forward-migrations");
  if (matches.length !== 1) throw new Error(`${catalogLabel}: expected exactly one schema-forward-migrations family`);
  const excluded = Array.isArray(rawExcluded) ? rawExcluded.filter((item): item is string => typeof item === "string") : [];
  if (new Set(excluded).size !== excluded.length) throw new Error(`${catalogLabel}: duplicate exact migration exclusion`);
  const reasons = typeof rawReasons === "object" && rawReasons !== null && !Array.isArray(rawReasons)
    ? rawReasons as Record<string, unknown> : {};
  if (JSON.stringify(Object.keys(reasons).sort()) !== JSON.stringify([...excluded].sort())) {
    throw new Error(`${catalogLabel}: excludedMigrationReason must explain exactly every excluded migration`);
  }
  const selectors = matches[0].excludePrefixes;
  const privateSelectors = new Set(Array.isArray(selectors) ? selectors.filter((item): item is string => typeof item === "string") : []);
  for (const path of excluded) {
    const suffix = path.slice(flattenPrefix.length);
    if (!path.startsWith(flattenPrefix) || suffix === "" || suffix.includes("/") || !suffix.endsWith(".sql")) {
      throw new Error(`${catalogLabel}: ${path} is not an exact top-level .sql migration exclusion; broad flatten skips are forbidden`);
    }
    if (!privateSelectors.has(path)) throw new Error(`${catalogLabel}: ${path} is not also an exact private schema-forward-migrations selector`);
    if (typeof reasons[path] !== "string" || reasons[path].trim() === "") throw new Error(`${catalogLabel}: ${path} has no non-empty excluded-migration reason`);
  }
  return excluded.sort();
}

const digest = (contents: string): string => `sha256-${createHash("sha256").update(contents).digest("hex")}`;

function annotatePublicSchemaSentinel(source: string): string {
  const tableHeader = "CREATE TABLE public.commerce_offer_policy_rollout_baselines (\n";
  const constraintName = "commerce_offer_policy_rollout_baselines_baseline_key_check";
  const sentinel = ["legacy", "frozen.v1"].join("_");
  const constraintLine = `    CONSTRAINT ${constraintName} CHECK ((baseline_key = '${sentinel}'::text)),`;
  const completeDump = source.startsWith("--\n-- PostgreSQL database dump\n--");
  const hasKnownShape = source.includes(tableHeader) || source.includes(constraintName);
  if (!completeDump && !hasKnownShape) return source;

  const tableCount = source.split(tableHeader).length - 1;
  const nameCount = source.split(constraintName).length - 1;
  const lineCount = source.split(`${constraintLine}\n`).length - 1;
  const tableStart = source.indexOf(tableHeader);
  const tableEnd = source.indexOf("\n);", tableStart + tableHeader.length);
  if (tableCount !== 1 || nameCount !== 1 || lineCount !== 1 || tableEnd < 0 ||
      !source.slice(tableStart, tableEnd).includes(`${constraintLine}\n`)) {
    throw new Error("flattened public baseline schema sentinel constraint drifted");
  }
  return source.replace(`${constraintLine}\n`, `${constraintLine} -- gitleaks:allow -- public schema sentinel, not a credential\n`);
}

export function projectPublicFlattenedBaseline(source: string, profile?: PublicCoordinateProfile): string {
  const projected = activateProjectedCoordinates(projectOperationalCoordinates(source, "supabase/migrations/00000000000000_platform_schema_baseline.sql").contents, profile);
  if (carriesPrivateOperationalCoordinate(projected, "supabase/migrations/00000000000000_platform_schema_baseline.sql")) throw new Error("flattened public baseline still carries a private operational coordinate");
  return annotatePublicSchemaSentinel(projected);
}
export function projectPublicEnvironmentVariables(source: string, profile?: PublicCoordinateProfile): PublicEnvironmentVariablesProjection {
  let parsed: unknown;
  try { parsed = JSON.parse(source); } catch { throw new Error(`${PROJECTED_ENVIRONMENT_VARIABLES_PATH}: unreadable JSON`); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || !Array.isArray((parsed as Record<string, unknown>).variables)) throw new Error(`${PROJECTED_ENVIRONMENT_VARIABLES_PATH}: expected variables`);
  const variables = ((parsed as Record<string, unknown>).variables as unknown[]).filter((row) => typeof row === "object" && row !== null && !Array.isArray(row) && (row as Record<string, unknown>).category === "public-build").map((row) => { const value = row as Record<string, unknown>; return { ...value, environments: ["local", "production"], requiredIn: Array.isArray(value.requiredIn) ? value.requiredIn.filter((item) => item === "local" || item === "production") : [], source: value.source === "docs/LOCAL_ENVIRONMENT.md" ? "docs/platform/RUNTIME_AND_SELF_HOSTING.md" : value.source }; });
  if (variables.length === 0 || variables.some((row) => { const value = row as Record<string, unknown>; return typeof value.name !== "string" || value.secret !== false || !/^(?:VITE_|COMMERCE_SETTLEMENT_|COMMERCE_FISCAL_|COMMERCE_MIN_PRODUCT_PAYABLE_)/u.test(value.name); })) throw new Error(`${PROJECTED_ENVIRONMENT_VARIABLES_PATH}: invalid public-build subset`);
  const contents = activateProjectedCoordinates(projectOperationalCoordinates(`${JSON.stringify({ schemaVersion: 1, description: "Public-build environment variables for the bounded reference tree.", variables }, null, 2)}\n`, PROJECTED_ENVIRONMENT_VARIABLES_PATH).contents, profile);
  if (carriesPrivateOperationalCoordinate(contents, PROJECTED_ENVIRONMENT_VARIABLES_PATH)) throw new Error(`${PROJECTED_ENVIRONMENT_VARIABLES_PATH}: projected subset carries a private coordinate`);
  return { path: PROJECTED_ENVIRONMENT_VARIABLES_PATH, contents, digest: digest(contents) };
}

function parseCapabilityManifest(source: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error(`${PUBLIC_REFERENCE_CAPABILITY_MANIFEST_PATH}: unreadable JSON cannot be projected`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${PUBLIC_REFERENCE_CAPABILITY_MANIFEST_PATH}: expected an object`);
  }
  const manifest = parsed as Record<string, unknown>;
  const capabilities = manifest.capabilities;
  const refuses = manifest.refuses;
  if (manifest.schemaVersion !== 1 || manifest.runtime !== "public-reference" || !Array.isArray(capabilities) || !Array.isArray(refuses)) {
    throw new Error(`${PUBLIC_REFERENCE_CAPABILITY_MANIFEST_PATH}: expected the bounded public-reference contract`);
  }
  const expected = [
    { id: "reference-catalog", methods: ["GET", "HEAD"], routes: ["/", "/items/field-notes"] },
    { id: "runtime-health", methods: ["GET", "HEAD"], routes: ["/healthz"] },
  ];
  if (JSON.stringify(capabilities) !== JSON.stringify(expected) || JSON.stringify(refuses) !== JSON.stringify(["admin", "api", "bff", "checkout", "cron", "mutation", "subscription"])) {
    throw new Error(`${PUBLIC_REFERENCE_CAPABILITY_MANIFEST_PATH}: capabilities must be the exact bounded public contract`);
  }
  return manifest;
}

export function projectPublicReferenceOci(
  dockerfile: string,
  compose: string,
  capability: string,
): PublicReferenceOciProjection {
  parseCapabilityManifest(capability);
  const images = [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map((match) => match[1]);
  if (images.length !== 2 || images.some((image) => image !== "node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03") || !dockerfile.includes("PUBLIC_REFERENCE_REVISION") || !dockerfile.includes("PUBLIC_REFERENCE_CAPABILITY_DIGEST")) {
    throw new Error(`${PUBLIC_REFERENCE_OCI_DOCKERFILE_PATH}: expected a digest-pinned public revision descriptor`);
  }
  if (dockerfile.includes("serve.node.ts") || dockerfile.includes("docker login") || dockerfile.includes("--push")) {
    throw new Error(`${PUBLIC_REFERENCE_OCI_DOCKERFILE_PATH}: must not name a private runtime or registry write`);
  }
  if (!compose.includes("PUBLIC_REFERENCE_IMAGE") || !compose.includes("pull_policy: never")) {
    throw new Error(`${PUBLIC_REFERENCE_OCI_COMPOSE_PATH}: expected the helper-loaded image launcher`);
  }
  if (/\b(build|context|dockerfile|volumes|depends_on|environment|networks|restart):/.test(compose)) {
    throw new Error(`${PUBLIC_REFERENCE_OCI_COMPOSE_PATH}: local launcher must not build or compose dependencies`);
  }
  return {
    dockerfile: { path: PROJECTED_OCI_DOCKERFILE_PATH, contents: dockerfile, digest: digest(dockerfile) },
    compose: { path: PROJECTED_OCI_COMPOSE_PATH, contents: compose, digest: digest(compose) },
    capability: { path: PUBLIC_REFERENCE_CAPABILITY_MANIFEST_PATH, contents: capability, digest: digest(capability) },
  };
}

export function projectPublicPullRequestTemplate(source: string): PublicPullRequestTemplateProjection {
  if (source.trim() === "") {
    throw new Error(`${PUBLIC_REFERENCE_PR_TEMPLATE_PATH}: an empty template is not a projection`);
  }
  const leaked = DEPLOYMENT_EVIDENCE_FIELDS.filter((field) => source.includes(field));
  if (leaked.length > 0) {
    throw new Error(`${PUBLIC_REFERENCE_PR_TEMPLATE_PATH}: carries this deployment's release-evidence field(s): ${leaked.join(", ")}`);
  }
  if (!source.includes("Signed-off-by:")) {
    throw new Error(`${PUBLIC_REFERENCE_PR_TEMPLATE_PATH}: must state the sign-off the published CI enforces`);
  }
  const required = ["npm ci", "npm test", "npm run build", "npm run oss:published-tree -- --policy", "--inventory", "--typecheck", "README.md", "CONTRIBUTING.md"];
  if (required.some((claim) => !source.includes(claim)) || source.includes("npm run lint") || source.includes("Known Gaps In This Tree")) throw new Error(`${PUBLIC_REFERENCE_PR_TEMPLATE_PATH}: commands or documentation anchors drifted from the public contract`);
  return { path: PROJECTED_PR_TEMPLATE_PATH, contents: source, digest: digest(source) };
}

export function projectPublicSiteRoutes(source: string): PublicTreeProjection {
  let manifest: unknown;
  try {
    manifest = JSON.parse(source);
  } catch {
    throw new Error(`${PUBLIC_REFERENCE_SITE_ROUTES_PATH}: unreadable JSON cannot be projected`);
  }
  const validated = validateSiteRouteManifest(manifest);
  if (validated.siteLifecycle !== "public-reference") {
    throw new Error(`${PUBLIC_REFERENCE_SITE_ROUTES_PATH}: expected a public-reference lifecycle`);
  }
  const contents = `${JSON.stringify(validated, null, 2)}\n`;
  return {
    path: PROJECTED_SITE_ROUTES_PATH,
    contents,
    digest: digest(contents),
  };
}

function publicContact(securityRoute: string, allowFixture = false): string {
  if (!isValidPublicSecurityRoute(securityRoute, allowFixture)) throw new Error("public policy projection requires a valid security email route");
  return securityRoute;
}

export function projectPublicCodeOfConduct(securityRoute: string, allowFixture = false): PublicPolicyProjection {
  const contact = publicContact(securityRoute, allowFixture);
  const contents = `# Code of Conduct\n\nWe expect respectful, constructive participation in this project.\n\nTo report a conduct concern, contact ${contact}.\n`;
  return { path: PROJECTED_CODE_OF_CONDUCT_PATH, contents, digest: digest(contents) };
}

export function projectPublicSecurity(securityRoute: string, allowFixture = false): PublicPolicyProjection {
  const contact = publicContact(securityRoute, allowFixture);
  const primary = allowFixture ? `email ${contact}` : "GitHub Private Vulnerability Reporting for this repository";
  const fallback = allowFixture ? "" : ` If that route is unavailable, email ${contact}.`;
  const contents = `# Security Policy\n\nReport suspected vulnerabilities through ${primary}.${fallback}\nNever open a public issue, pull request, or discussion for a vulnerability report.\n\nPackage security guidance links back to this root policy; packages do not create separate reporting routes.\n`;
  return { path: PROJECTED_SECURITY_PATH, contents, digest: digest(contents) };
}

export function projectPublicPoliciesFromSourceReleaseContract(source: string): PublicPolicyProjection[] {
  validateSourceReleaseContract(source);
  const repository = (JSON.parse(source) as { repository: { securityRoute: string } }).repository;
  const fixture = repository.securityRoute === "security@openlup.invalid"; return [projectPublicCodeOfConduct(repository.securityRoute, fixture), projectPublicSecurity(repository.securityRoute, fixture)];
}

export function projectPublicIndexDocument() {
  const contents = `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><meta name="robots" content="noindex, nofollow" /><title>OpenLup development preview</title></head>
  <body><div id="root"></div><script type="module" src="/src/public-reference/main.tsx"></script></body>
</html>
`;
  return { path: PROJECTED_INDEX_DOCUMENT_PATH, contents, digest: digest(contents) };
}
