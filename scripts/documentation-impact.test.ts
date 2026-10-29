import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { existsSync, chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  assertDocumentationNavigation, documentationSection, markdownHeadings, normalizeDocumentation,
  readDocumentationState, resolveDocumentationOwner, type DocumentationSurface,
} from "./documentation-routing.ts";
import { checkDocumentationImpact, renderDocumentationImpact, renderNoImpactComment, renderNoImpactTrailer, resolveDocumentationBase, type DocumentationObligation } from "./documentation-impact.ts";
import { documentationDigest, readDocumentationCandidate, readDocumentationIndex, readDocumentationObjects, readDocumentationTree, type DocumentationObject } from "./documentation-git.ts";

const fetchMock = vi.hoisted(() => ({ source: "", calls: [] as { args: string[]; options: ExecFileSyncOptions }[] }));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, execFileSync: (command: string, args: string[], options: ExecFileSyncOptions) => {
    if (command === "git" && args.includes("fetch") && args.includes("https://github.com/openlup/openlup.git")) {
      fetchMock.calls.push({ args, options });
      if (!fetchMock.source) throw new Error("simulated public base fetch failure");
      // The test transport alone admits the synthetic file repository; production admits HTTPS only.
      return actual.execFileSync(command, ["-c", "protocol.file.allow=always", ...args.map((arg) => arg === "https://github.com/openlup/openlup.git" ? `file://${fetchMock.source}` : arg)], options);
    }
    return actual.execFileSync(command, args, options);
  } };
});

const directories: string[] = [];
let fixtureSeed: { root: string; base: string } | undefined;
afterEach(() => { vi.unstubAllEnvs(); for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true }); fetchMock.source = ""; fetchMock.calls.length = 0; });
afterAll(() => { if (fixtureSeed) rmSync(fixtureSeed.root, { recursive: true, force: true }); });
function temporary(): string { const path = mkdtempSync(join(tmpdir(), "documentation-guard-")); directories.push(path); return path; }
function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "maintenance.auto=false", "-c", "gc.auto=0", ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function write(root: string, path: string, text: string): void { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); }
function commit(root: string): string {
  git(root, "add", "."); git(root, "-c", "user.name=Documentation Test", "-c", "user.email=test@example.org", "commit", "-qm", "fixture"); return git(root, "rev-parse", "HEAD");
}
const OWNER = "docs/owner.md";
const SOURCE = "src/domains/demo/main.ts";
const ownerText = "# Owner\n\n## Canonical\n\nThe contract preserves replay safety.\n\nUpdated: 2026-09-26\n\n## Other\n\nSeparate guidance.\n";
function fixture(): { root: string; base: string; surfaces: DocumentationSurface[] } {
  const root = temporary();
  const surfaces: DocumentationSurface[] = [
    { id: "repository", when: "Repository contracts and configuration", paths: ["*", "config/**", "src/lib/**"], doc: OWNER, anchor: "#canonical" },
    { id: "domain-demo", when: "The demo domain contract", paths: ["src/domains/demo/**"], doc: OWNER, anchor: "#canonical" },
    { id: "documentation", when: "Public documentation authoring", paths: ["docs/**"], doc: OWNER, anchor: "" },
  ];
  if (fixtureSeed) {
    // Reuse only immutable setup bytes; every case owns its complete tree and .git.
    cpSync(fixtureSeed.root, root, { recursive: true });
    return { root, base: fixtureSeed.base, surfaces };
  }
  git(root, "init", "-q");
  write(root, "README.md", `[Owner](${OWNER})\n`); write(root, OWNER, ownerText);
  write(root, "src/lib/coreDomains.ts", 'export const CORE_DOMAINS = Object.freeze(["demo"] as const);\n');
  write(root, SOURCE, "export const value = 1;\n"); write(root, "src/domains/demo/other.ts", "export const other = 1;\n");
  write(root, "config/doc-routing.json", JSON.stringify({ version: 2, surfaces }));
  const base = commit(root); git(root, "update-ref", "refs/remotes/origin/main", base);
  fixtureSeed = { root: mkdtempSync(join(tmpdir(), "documentation-guard-seed-")), base };
  cpSync(root, fixtureSeed.root, { recursive: true });
  return { root, base, surfaces };
}
function impact(root: string, base: string) { return checkDocumentationImpact(root, readDocumentationState(root), base); }
function sectionUpdate(root: string): void { write(root, OWNER, ownerText.replace("preserves replay safety", "preserves replay safety and refuses reordered events")); }
/** The previous rule's version-2 digest, which also binds the owner section's current text. */
function legacyDigest(root: string, base: string, obligation: DocumentationObligation): string {
  const before = readDocumentationTree(root, base), state = readDocumentationState(root), after = readDocumentationCandidate(root, state.paths);
  const bind = (object: DocumentationObject | undefined) => object ? { mode: object.mode, digest: object.digest } : null;
  const oldSurfaces = JSON.parse(before.get("config/doc-routing.json")!.contents.toString("utf8")).surfaces as DocumentationSurface[];
  return documentationDigest(JSON.stringify({ version: 2, unit: obligation.unit, doc: obligation.doc, anchor: obligation.anchor,
    source: obligation.changedPaths.map(path => ({ path, before: bind(before.get(path)), after: bind(after.get(path)), ownership: {
      before: before.has(path) ? resolveDocumentationOwner({ surfaces: oldSurfaces }, path) : null, after: after.has(path) ? resolveDocumentationOwner(state, path) : null,
    } })), section: documentationDigest(normalizeDocumentation(documentationSection(readFileSync(join(root, OWNER), "utf8"), obligation.anchor))),
  }));
}
function review(root: string, base: string): void {
  const obligation = impact(root, base).obligations.find((row) => row.unit === "domain-demo")!;
  const comment = renderNoImpactComment({ ...obligation, digest: legacyDigest(root, base, obligation) }, "This internal implementation change preserves the documented replay contract.");
  write(root, OWNER, ownerText.replace("## Other", `${comment}\n\n## Other`));
}

describe("production documentation owner routes", () => {
  it("routes multi-contract core, platform and adapter modules to real owner sections", () => {
    const state = readDocumentationState(process.cwd());
    const expected = [
      ["packages/core/src/readiness/schemaProbe.ts", "core-readiness", "#readiness-contract"],
      ["packages/core/src/bundle/contracts.ts", "core-bundle", "#bundle-contracts"],
      ["packages/core/src/catalog/identifiers.ts", "core-catalog", "#catalog-identifiers"],
      ["packages/core/src/inventory/atp.ts", "core-inventory", "#inventory-availability"],
      ["packages/core/src/pricing/pricingBreakdown.ts", "core-pricing", "#price-resolution-and-breakdown"],
      ["packages/core/src/promo/promoEvaluator.ts", "core-promotions", "#promotion-evaluation-and-adjustments"],
      ["packages/core/src/fulfillment/facts.ts", "core-fulfillment", "#fulfillment-fact-and-status-contracts"],
      ["packages/core/src/shipping/shippingResolver.ts", "core-shipping", "#shipping-rule-resolution"],
      ["packages/core/src/company-identity/contracts.ts", "core-company-identity", "#company-identity-lookup-contracts"],
      ["packages/core/src/partners/status.ts", "core-partners", "#partner-lifecycle-contracts"],
      ["packages/core/src/risk/core/evaluator.ts", "core-risk", "#risk-evaluation-contracts"],
      ["packages/core/src/payment/index.ts", "core-payment", "#payment-contracts"],
      ["packages/core/src/testing.ts", "core-testing", "#local-verification-from-source"],
      ["packages/platform/src/scheduler/cronGuard.ts", "platform-scheduler", "#scheduled-jobs"],
      ["packages/platform/src/http/index.ts", "platform-http", "#http-runtime-and-security-contract"],
      ["packages/platform/src/payments/index.ts", "platform-payments", "#payments-prepared-attempts"],
      ["packages/platform/src/invoicing/index.ts", "invoicing-package", "#invoicing-contracts"],
      ["packages/platform/src/identity/index.ts", "identity", ""],
      ["server/adapters/postgres/queryBuilder.ts", "adapter-postgres", "#postgresql-domain-bindings"],
      ["server/adapters/postgres/migrationRunner.ts", "adapter-postgres-install", "#restricted-postgresql-installation-binding"],
      ["server/adapters/postgres/connectedStoreCapture.ts", "adapter-connected-transfer", "#native-retained-store-transfer-preparation"],
      ["server/adapters/s3/transferObjectSource.ts", "adapter-s3", "#s3-object-source-preparation"],
      ["server/adapters/noop_payment/noopPaymentExecutionAdapter.ts", "adapter-payment", "#payment-execution-and-reconciliation"],
      ["server/adapters/noop_shipping/noopShippingAdapter.ts", "adapter-fulfillment", "#fulfillment-execution"],
      ["server/adapters/accounting/testAccountingProvider.ts", "adapter-accounting", "#accounting-document-execution"],
      ["server/adapters/email/adminRoleNotificationPort.ts", "adapter-communications", "#communications-delivery-and-sync"],
      ["server/adapters/node/httpRequestAdapter.ts", "adapter-host-runtime", "#scheduler-and-host-runtime"],
    ] as const;
    for (const [path, unit, anchor] of expected) {
      const owner = resolveDocumentationOwner(state, path);
      expect(owner).toMatchObject({ unit, anchor });
      if (anchor) expect(markdownHeadings(readFileSync(join(process.cwd(), owner.doc), "utf8")).some(heading => heading.anchor === anchor)).toBe(true);
    }
    for (const root of ["packages/core/src", "packages/platform/src"]) {
      for (const module of readdirSync(join(process.cwd(), root), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)) {
        const owner = resolveDocumentationOwner(state, `${root}/${module}/routing-contract.ts`);
        expect(owner.paths.some(selector => selector === `${root}/${module}/**` || selector.startsWith(`${root}/${module}/`))).toBe(true);
      }
    }
    expect(state.surfaces.flatMap(surface => surface.paths)).not.toContain("packages/**");
    expect(state.surfaces.flatMap(surface => surface.paths)).not.toContain("packages/core/**");
    expect(state.surfaces.flatMap(surface => surface.paths)).not.toContain("packages/platform/**");

  });

  it("requires the actual payment capability section after an adapter source change", () => {
    const { root, base, surfaces } = fixture();
    const production = JSON.parse(readFileSync(join(process.cwd(), "config/doc-routing.json"), "utf8")) as { surfaces: DocumentationSurface[] };
    const payment = production.surfaces.find(row => row.id === "adapter-payment")!;
    surfaces.push(payment, { id: "adapter-doc", when: "Adapter README fixture", paths: [payment.doc], doc: payment.doc, anchor: "" });
    write(root, "config/doc-routing.json", JSON.stringify({ version: 2, surfaces }));
    const adapterText = "# Adapters\n\n## Owns\n\nAdapter overview.\n\n## Capability Map\n\nPayment execution overview.\n\n### Payment execution and reconciliation\n\nThe payment adapter translates a selected control action and provider observation.\n";
    write(root, payment.doc, adapterText);
    const sourcePath = "server/adapters/noop_payment/noopPaymentExecutionAdapter.ts";
    write(root, sourcePath, "export const paymentExecution = 1;\n");
    const sourceBase = commit(root);
    write(root, sourcePath, "export const paymentExecution = 2;\n");
    write(root, payment.doc, adapterText.replace("## Owns", "## Owns\n\nAn unrelated adapter overview changed."));
    expect(impact(root, sourceBase).failures).toHaveLength(1);
    write(root, payment.doc, adapterText.replace("### Payment execution and reconciliation", "### Payment execution and reconciliation\n\nThe selected adapter preserves the provider-neutral control boundary."));
    expect(impact(root, sourceBase).failures).toEqual([]);
  });

  it("requires the catalog section when catalog source changes; inventory text cannot answer it", () => {
    const { root, base, surfaces } = fixture();
    const production = JSON.parse(readFileSync(join(process.cwd(), "config/doc-routing.json"), "utf8")) as { surfaces: DocumentationSurface[] };
    const catalog = production.surfaces.find(row => row.id === "core-catalog")!;
    const inventory = production.surfaces.find(row => row.id === "core-inventory")!;
    surfaces.push(catalog, inventory,
      { id: "package-core-doc", when: "Core package README fixture", paths: [catalog.doc], doc: catalog.doc, anchor: "" });
    write(root, "config/doc-routing.json", JSON.stringify({ version: 2, surfaces }));
    const ownerText = "# Core package\n\n## Catalog identifiers\n\nCatalogue identifiers have bounded formats and host-owned membership.\n\n## Inventory availability\n\nAvailability is calculated from supplied stock lines.\n";
    write(root, catalog.doc, ownerText);
    const catalogPath = "packages/core/src/catalog/identifiers.ts";
    write(root, catalogPath, "export const catalogIdentifier = 1;\n");
    write(root, "packages/core/src/inventory/atp.ts", "export const availability = 1;\n");
    const sourceBase = commit(root);
    write(root, catalogPath, "export const catalogIdentifier = 2;\n");
    write(root, catalog.doc, ownerText.replace("## Inventory availability", "## Inventory availability\n\nThe stock calculation retains the single-location result."));
    expect(impact(root, sourceBase).failures).toHaveLength(1);
    write(root, catalog.doc, ownerText.replace("## Catalog identifiers", "## Catalog identifiers\n\nThe identifiers remain open formats; the host read determines membership."));
    expect(impact(root, sourceBase).failures).toEqual([]);
  });

  it("requires the actual scheduler owner section after a core/platform source change", () => {
    const { root, base, surfaces } = fixture();
    const production = JSON.parse(readFileSync(join(process.cwd(), "config/doc-routing.json"), "utf8")) as { surfaces: DocumentationSurface[] };
    const scheduler = production.surfaces.find(row => row.id === "platform-scheduler")!;
    const core = production.surfaces.find(row => row.id === "core-readiness")!;
    surfaces.push(scheduler, core,
      { id: "package-platform-doc", when: "Platform package README fixture", paths: [scheduler.doc], doc: scheduler.doc, anchor: "" },
      { id: "package-core-doc", when: "Core package README fixture", paths: [core.doc], doc: core.doc, anchor: "" });
    write(root, "config/doc-routing.json", JSON.stringify({ version: 2, surfaces }));
    const schedulerText = "# Platform package\n\n## Package surface\n\nPackage export overview.\n\n## Scheduled jobs\n\nThe scheduler binds recurring job contracts and authenticated HTTP execution.\n";
    const coreText = "# Core package\n\n## Readiness contract\n\nReadiness probes the host inventory before admission.\n";
    write(root, scheduler.doc, schedulerText);
    write(root, core.doc, coreText);
    const schedulerPath = "packages/platform/src/scheduler/cronGuard.ts";
    const corePath = "packages/core/src/readiness/schemaProbe.ts";
    write(root, schedulerPath, "export const schedulerSecurityContract = 1;\n");
    write(root, corePath, "export const readinessContract = 1;\n");
    const sourceBase = commit(root);
    write(root, schedulerPath, "export const schedulerSecurityContract = 2;\n");
    write(root, corePath, "export const readinessContract = 2;\n");
    const unrelated = schedulerText.replace("## Package surface", "## Package surface\n\nThis unrelated package surface was edited.");
    write(root, scheduler.doc, unrelated);
    expect(impact(root, sourceBase).failures).toHaveLength(2);
    const updatedScheduler = schedulerText.replace("## Scheduled jobs", "## Scheduled jobs\n\nThe scheduler guard preserves authenticated job admission and its refusal behavior.");
    const updatedCore = coreText.replace("## Readiness contract", "## Readiness contract\n\nThe schema probe retains exact ordered result admission for its caller.");
    write(root, scheduler.doc, updatedScheduler);
    write(root, core.doc, updatedCore);
    expect(impact(root, sourceBase).failures).toEqual([]);
  });
});

describe("public documentation routing", () => {
  it("resolves specific workflow sections and treats reachability as a separate gate", () => {
    const { root, surfaces } = fixture();
    surfaces.push({ id: "workflow", when: "The specific workflow", paths: [SOURCE], doc: OWNER, anchor: "#other" });
    write(root, "config/doc-routing.json", JSON.stringify({ version: 2, surfaces }));
    const state = readDocumentationState(root);
    expect(resolveDocumentationOwner(state, SOURCE).unit).toBe("workflow");
    expect(state.ownersByPath.get(SOURCE)?.anchor).toBe("#other");
    expect(() => assertDocumentationNavigation(state)).not.toThrow();
    write(root, "README.md", "# No owner link\n");
    expect(() => assertDocumentationNavigation(readDocumentationState(root))).toThrow(/unreachable owner/);
  });
  it.each(["new/unowned.ts", ".hidden/unowned.ts"])("refuses untracked unknown path %s", (path) => {
    const { root } = fixture(); write(root, path, "export const unowned = true;\n");
    expect(() => readDocumentationState(root)).toThrow(/unknown path/);
  });
  it("refuses unregistered domains, dead selectors, owner anchors and conflicting owners", () => {
    const { root, surfaces } = fixture();
    write(root, "src/domains/unregistered/value.ts", "export {};\n");
    expect(() => readDocumentationState(root)).toThrow(/unregistered domain/);
    rmSync(join(root, "src/domains/unregistered"), { recursive: true });
    for (const change of [
      { ...surfaces[1]!, paths: ["src/absent/**"] },
      { ...surfaces[1]!, anchor: "#absent" },
      { ...surfaces[1]!, id: "duplicate-owner", anchor: "#other" },
    ]) {
      write(root, "config/doc-routing.json", JSON.stringify({ version: 2, surfaces: [...surfaces, change] }));
      expect(() => readDocumentationState(root)).toThrow(/malformed or duplicate|dead selector|missing owner anchor|conflicting equally/);
    }
    write(root, "config/doc-routing.json", JSON.stringify({ version: 2, surfaces: surfaces.map((row) => ({ ...row, doc: "docs/missing.md" })) }));
    expect(() => readDocumentationState(root)).toThrow(/missing owner/);
  });
  it("refuses materialized and dangling symlink objects", () => {
    const { root } = fixture();
    for (const target of [join(root, SOURCE), join(root, "absent.ts")]) {
      symlinkSync(target, join(root, "src/domains/demo/link.ts"));
      expect(() => readDocumentationState(root)).toThrow(/symlink objects/);
      rmSync(join(root, "src/domains/demo/link.ts"));
    }
  });
  it("finds headings outside fenced examples and bounds each canonical section", () => {
    const text = "# Page\n```md\n## Example\n```\n## Real\nbody\n### Child\nchild\n## Real\nsecond\n";
    expect(markdownHeadings(text).map(({ anchor }) => anchor)).toEqual(["#page", "#real", "#child", "#real-1"]);
    expect(documentationSection(text, "#real")).toContain("child");
    expect(documentationSection(text, "#real")).not.toContain("second");
    const withUnicodeComment = text.replace("## Real", "<!-- 🙂🙂🙂🙂 -->\n\n## Real");
    expect(documentationSection(withUnicodeComment, "#real")).toBe(documentationSection(text, "#real"));
  });
});

describe("attributable source and owner impact", () => {
  it("reads mixed object batches and missing paths while refusing nonliteral specs", () => {
    const { root, base } = fixture(); const blob = git(root, "rev-parse", `${base}:${SOURCE}`), tree = git(root, "rev-parse", `${base}^{tree}`);
    const objects = readDocumentationObjects(root, [base, tree, blob, `${base}:${SOURCE}`, `${base}:missing.md`, "f".repeat(40)]);
    expect(objects[0]?.toString()).toContain(`tree ${tree}\n`); expect(objects[1]?.length).toBeGreaterThan(0);
    expect(objects[2]?.toString()).toBe("export const value = 1;\n"); expect(objects[3]).toEqual(objects[2]);
    expect(objects.slice(4)).toEqual([null, null]); expect(readDocumentationObjects(root, [])).toEqual([]);
    for (const spec of ["HEAD", `${base}^{tree}`, `${base}\n`, `${base}:${SOURCE}\n`, `${base}:../escape`, `${base}:/absolute`, `${base}:`])
      expect(() => readDocumentationObjects(root, [spec])).toThrow(/invalid object spec|invalid repository-relative path/);
  });
  it("uses the same pinned predecessor as native review without changing hosted event precedence", () => {
    const { root, base } = fixture();
    write(root, "src/domains/demo/other.ts", "export const other = 2;\n"); review(root, base); const predecessor = commit(root);
    write(root, SOURCE, "export const value = 2;\n"); review(root, predecessor); commit(root);
    const env = { OPENLUP_STACK_BASE: predecessor };
    expect(impact(root, resolveDocumentationBase(root, { env }).base).failures).toEqual([]);
    expect(impact(root, resolveDocumentationBase(root, { env: {} }).base).failures).toHaveLength(1);
    expect(() => resolveDocumentationBase(root, { env, base })).toThrow('differs');
    const merged = git(root, '-c', 'user.name=Documentation Test', '-c', 'user.email=test@example.org', 'commit-tree', git(root, 'rev-parse', `${predecessor}^{tree}`), '-p', base, '-p', predecessor, '-m', 'merge predecessor');
    git(root, 'update-ref', 'refs/remotes/origin/main', merged);
    expect(impact(root, resolveDocumentationBase(root, { env }).base).failures).toEqual([]);
    expect(impact(root, resolveDocumentationBase(root, { env: {} }).base).failures).toEqual([]);
    expect(() => resolveDocumentationBase(root, { env: { OPENLUP_STACK_BASE: 'bad' } })).toThrow('full commit SHA');
  });
  it("compares actual commit and blob objects despite local replacement refs", () => {
    const { root, base } = fixture(); const originalBlob = git(root, "rev-parse", `${base}:${SOURCE}`);
    write(root, SOURCE, "export const value = 2;\n"); const head = commit(root); const changedBlob = git(root, "rev-parse", `HEAD:${SOURCE}`);
    git(root, "replace", base, head);
    expect(impact(root, base).failures).toHaveLength(1);
    expect(readDocumentationTree(root, base).get(SOURCE)?.contents.toString()).toContain("value = 1");
    git(root, "replace", "-d", base); git(root, "replace", originalBlob, changedBlob);
    expect(readDocumentationTree(root, base).get(SOURCE)?.contents.toString()).toContain("value = 1");
    expect(impact(root, base).failures).toHaveLength(1);
  });
  it("binds inventory, index and ancestry to the selected checkout despite ambient redirects", () => {
    const { root, base } = fixture(); const decoy = fixture().root;
    write(decoy, SOURCE, "export const value = 7;\n"); commit(decoy);
    write(root, "src/domains/demo/new.ts", "export const added = true;\n");
    vi.stubEnv("GIT_DIR", join(decoy, ".git")); vi.stubEnv("GIT_WORK_TREE", decoy); vi.stubEnv("GIT_INDEX_FILE", join(decoy, ".git/index"));
    vi.stubEnv("GIT_CONFIG_COUNT", "1"); vi.stubEnv("GIT_CONFIG_KEY_0", "core.bare"); vi.stubEnv("GIT_CONFIG_VALUE_0", "true");
    expect(readDocumentationState(root).paths).toContain("src/domains/demo/new.ts");
    expect(readDocumentationIndex(root).get(SOURCE)?.contents.toString()).toContain("value = 1");
    expect(resolveDocumentationBase(root, { env: {} }).head).toBe(base);
    expect(impact(root, base).failures).toHaveLength(1);
  });
  it("accepts a clean base and detects staged, unstaged, untracked, deleted and moved sources", () => {
    const { root, base } = fixture(); expect(impact(root, base).obligations).toHaveLength(0);
    write(root, SOURCE, "export const value = 2;\n"); expect(impact(root, base).failures).toHaveLength(1);
    git(root, "add", SOURCE); expect(impact(root, base).failures).toHaveLength(1);
    write(root, "src/domains/demo/new.ts", "export const added = true;\n");
    expect(impact(root, base).obligations[0]?.changedPaths).toContain("src/domains/demo/new.ts");
    rmSync(join(root, SOURCE));
    git(root, "add", "-u", SOURCE);
    expect(impact(root, base).obligations[0]?.changedPaths).toContain(SOURCE);
    renameSync(join(root, "src/domains/demo/other.ts"), join(root, "src/domains/demo/renamed.ts"));
    expect(impact(root, base).obligations[0]?.changedPaths).toContain("src/domains/demo/other.ts");
    sectionUpdate(root); expect(impact(root, base).failures).toEqual([]);
  });
  it.each([
    (text: string) => text.replace("replay safety.", "replay   safety.\n\n"),
    (text: string) => text.replace("2026-09-26", "2026-09-27"),
    (text: string) => text.replace("Separate guidance.", "An unrelated section changed."),
    (text: string) => text.replace("## Other", "<!-- arbitrary acknowledgement -->\n## Other"),
    (text: string) => text.replace("## Other", "<!-- openlup-generated:start -->\nGenerated new source map.\n<!-- openlup-generated:end -->\n## Other"),
    (text: string) => text.replace("## Other", "Source commit: a new generated revision\nProvenance: regenerated today\n## Other"),
    (text: string) => text.replace("The contract preserves replay safety.", "<!-- openlup-generated:start -->\nThe contract preserves replay safety.\n<!-- openlup-generated:end -->"),
    (text: string) => text.replace("Updated: 2026-09-26", "Audit date: 2026-09-27"),
    (text: string) => text.replace("## Canonical", "<!-- 🙂🙂🙂🙂 -->\n\n## Canonical"),
  ])("does not accept cosmetic, unrelated or generated owner changes", (change) => {
    const { root, base } = fixture(); write(root, SOURCE, "export const value = 2;\n"); write(root, OWNER, change(ownerText));
    expect(impact(root, base).failures).toHaveLength(1);
  });
  it("refuses a staged source proposal concealed by restoring worktree bytes", () => {
    const { root, base } = fixture(); write(root, SOURCE, "export const value = 2;\n"); git(root, "add", SOURCE);
    write(root, SOURCE, "export const value = 1;\n");
    expect(() => impact(root, base)).toThrow(/staged source differs/);
    git(root, "add", SOURCE); expect(impact(root, base).obligations).toEqual([]);
  });
  it("allows ordinary branch iteration while refusing a concealed staged revert to its base", () => {
    const { root, base } = fixture(); write(root, SOURCE, "export const value = 2;\n"); sectionUpdate(root); commit(root);
    write(root, SOURCE, "export const value = 3;\n");
    expect(impact(root, base).failures).toEqual([]); // Index equals HEAD, not an unseen staged proposal.
    write(root, SOURCE, "export const value = 1;\n"); git(root, "add", SOURCE);
    write(root, SOURCE, "export const value = 2;\n");
    expect(() => impact(root, base)).toThrow(/staged source differs/);
  });
  it.each(["docs/platform/plans/runtime.ts", "docs/history/runtime.js", "docs/archive/forward.sql"])("keeps executable history path %s subject to impact and index checks", (path) => {
    const { root } = fixture(); const contents = (value: number) => path.endsWith(".sql") ? `select ${value};\n` : `export const value = ${value};\n`;
    write(root, path, contents(1));
    if (!path.endsWith(".sql")) write(root, SOURCE, `import {value} from '../../../${path}'; export {value};\n`);
    const base = commit(root); write(root, path, contents(2));
    expect(impact(root, base).failures).toHaveLength(1);
    git(root, "add", path); write(root, path, contents(1));
    expect(() => impact(root, base)).toThrow(/staged source differs/);
  });
  it("accepts one fresh scoped receipt and refuses stale, moved or malformed comments", () => {
    const { root, base } = fixture(); write(root, SOURCE, "export const value = 2;\n"); review(root, base);
    expect(impact(root, base).obligations[0]?.status).toBe("no-impact");
    const valid = readFileSync(join(root, OWNER), "utf8");
    write(root, SOURCE, "export const value = 3;\n"); expect(impact(root, base).failures).toHaveLength(1);
    write(root, SOURCE, "export const value = 2;\n");
    const marker = /<!-- openlup-doc-impact.*?-->/u.exec(valid)![0];
    write(root, OWNER, valid.replace(marker, "").replace("Separate guidance.", `Separate guidance.\n${marker}`));
    expect(impact(root, base).failures).toHaveLength(1);
    for (const bad of ['<!-- openlup-doc-impact {"unit":"domain-demo"} -->', "<!-- openlup-doc-impact bad JSON -->", "<!-- openlup-doc-impact unterminated"])
      { write(root, OWNER, ownerText.replace("## Other", `${bad}\n## Other`)); expect(impact(root, base).failures.join("\n")).toMatch(/comment|JSON/); }
  });
  it("binds source modes, not the owner prose or the base commit", () => {
    const { root, base } = fixture(); write(root, SOURCE, "export const value = 2;\n"); review(root, base);
    chmodSync(join(root, SOURCE), 0o755); expect(impact(root, base).failures).toHaveLength(1); chmodSync(join(root, SOURCE), 0o644);
    const oldDigest = impact(root, base).obligations[0]!.digest;
    write(root, OWNER, readFileSync(join(root, OWNER), "utf8").replace("preserves replay safety", "preserves a new contract"));
    expect(impact(root, base).obligations[0]!.digest).toBe(oldDigest);
    expect(impact(root, base).obligations[0]?.status).toBe("updated");
    git(root, "-c", "user.name=Documentation Test", "-c", "user.email=test@example.org", "commit", "--allow-empty", "-qm", "new base");
    const nextBase = git(root, "rev-parse", "HEAD"); write(root, OWNER, ownerText); review(root, base);
    expect(impact(root, nextBase).failures).toEqual([]);
  });
  describe("a no-impact answer across a moved base", () => {
    const commitOnly = (root: string, ...paths: string[]) => { git(root, "add", ...paths); git(root, "-c", "user.name=Documentation Test", "-c", "user.email=test@example.org", "commit", "-qm", "base move", "--", ...paths); return git(root, "rev-parse", "HEAD"); };
    const answered = () => { const { root, base } = fixture(); write(root, SOURCE, "export const value = 2;\n"); review(root, base); return { root, base, marked: readFileSync(join(root, OWNER), "utf8") }; };
    it("P1 stays valid when the base gains an unrelated change", () => {
      const { root } = answered(); write(root, "README.md", `[Owner](${OWNER})\n\nAn unrelated base change.\n`);
      const moved = commitOnly(root, "README.md"); expect(impact(root, moved).failures).toEqual([]);
      write(root, "src/domains/demo/other.ts", "export const other = 2;\n");
      const movedAgain = commitOnly(root, "src/domains/demo/other.ts"); expect(impact(root, movedAgain).failures).toEqual([]);
    });
    it("P2 is stale when the base changes a path the answer covers", () => {
      const { root } = answered(); write(root, SOURCE, "export const value = 3;\n"); const moved = commitOnly(root, SOURCE);
      write(root, SOURCE, "export const value = 2;\n"); expect(impact(root, moved).failures).toHaveLength(1);
    });
    it("P3 is stale when the base edits the answered section", () => {
      const { root, marked } = answered(); write(root, OWNER, ownerText.replace("preserves replay safety", "preserves replay safety for every event")); const moved = commitOnly(root, OWNER);
      write(root, OWNER, marked.replace("preserves replay safety", "preserves replay safety for every event")); expect(impact(root, moved).failures).toHaveLength(1);
    });
    it("P4 is not fresh when the same answer is already in the base", () => {
      const { root } = answered(); const moved = commitOnly(root, OWNER); expect(impact(root, moved).failures).toHaveLength(1);
    });
    it("P5 refuses two answers for one unit", () => {
      const { root, marked } = answered(); const comment = /<!-- openlup-doc-impact.*?-->/u.exec(marked)![0];
      write(root, OWNER, marked.replace("Updated: 2026-09-26", `${comment}\n\nUpdated: 2026-09-26`));
      expect(impact(root, git(root, "rev-parse", "HEAD")).failures).toHaveLength(1);
    });
    it("P6 is stale when the base reroutes a covered path", () => {
      const { root, marked } = answered(); const surfaces = JSON.parse(readFileSync(join(root, "config/doc-routing.json"), "utf8")).surfaces as DocumentationSurface[];
      surfaces.push({ id: "domain-demo-main", when: "The demo main entry", paths: [SOURCE], doc: OWNER, anchor: "#canonical" });
      write(root, "config/doc-routing.json", JSON.stringify({ version: 2, surfaces })); const moved = commitOnly(root, "config/doc-routing.json");
      write(root, OWNER, marked); expect(impact(root, moved).failures).toHaveLength(1);
    });
  });
  it("does not read a receipt inside fenced, indented or inline code as a review", () => {
    for (const example of ["```text\n```json\nRECEIPT\n```", "    RECEIPT", "`RECEIPT`", "`first line\nRECEIPT\nlast line`"]) {
      const { root } = fixture();
      write(root, OWNER, ownerText.replace("## Other", `${example.replace("RECEIPT", "")}\n## Other`));
      const exampleBase = commit(root);
      write(root, SOURCE, "export const value = 2;\n");
      const obligation = impact(root, exampleBase).obligations[0]!;
      const comment = renderNoImpactComment({ ...obligation, digest: legacyDigest(root, exampleBase, obligation) }, "The documented replay boundary remains unchanged.");
      write(root, OWNER, ownerText.replace("## Other", `${example.replace("RECEIPT", comment)}\n## Other`));
      expect(impact(root, exampleBase).obligations[0]?.status).toBe("unanswered");
    }
  });
  it("preserves both owners' obligations across a remap without changing source bytes", () => {
    const { root, base, surfaces } = fixture();
    surfaces[1] = { ...surfaces[1]!, anchor: "#other" }; write(root, "config/doc-routing.json", JSON.stringify({ version: 2, surfaces }));
    const result = impact(root, base);
    expect(result.obligations.filter(({ unit }) => unit === "domain-demo").map(({ anchor }) => anchor).sort()).toEqual(["#canonical", "#other"]);
    write(root, OWNER, ownerText.replace("Separate guidance.", "The demo contract now lives in this section."));
    expect(impact(root, base).failures.join("\n")).toContain("#canonical");
    write(root, OWNER, readFileSync(join(root, OWNER), "utf8").replace("preserves replay safety", "moves its canonical explanation to Other"));
    expect(impact(root, base).failures).toEqual([]);
  });
  it("allows the dormant v1 bootstrap and refuses a v2 downgrade", () => {
    const { root, surfaces } = fixture(); write(root, "config/doc-routing.json", JSON.stringify({ version: 1, surfaces: [{ doc: "docs/absent.md" }] }));
    const base = commit(root); write(root, "config/doc-routing.json", JSON.stringify({ version: 2, surfaces })); sectionUpdate(root);
    expect(impact(root, base).failures).toEqual([]);
    write(root, "config/doc-routing.json", JSON.stringify({ version: 1, surfaces }));
    expect(() => readDocumentationState(root)).toThrow(/version 2/);
  });
  it("does not exempt functional guidance merely because a line starts Updated", () => {
    expect(normalizeDocumentation("Updated: replay must refuse duplicate events")).toContain("replay");
  });
});

function commitTrailer(root: string, line: string): string {
  git(root, "-c", "user.name=Documentation Test", "-c", "user.email=test@example.org", "commit", "--allow-empty", "-qm", "doc impact", "-m", line);
  return git(root, "rev-parse", "HEAD");
}
function answer(root: string, base: string, reason = "The documented replay boundary stays correct."): string {
  return commitTrailer(root, renderNoImpactTrailer(impact(root, base).obligations.find(row => row.unit === "domain-demo")!, reason));
}
function merge(root: string, ref: string, message = "merge fixture"): string {
  git(root, "-c", "user.name=Documentation Test", "-c", "user.email=test@example.org", "merge", "--no-ff", "-qm", message, ref);
  return git(root, "rev-parse", "HEAD");
}

describe("commit trailer documentation answers", () => {
  it("accepts every matching non-merge answer and prints every reason and commit", () => {
    const { root, base } = fixture(); write(root, SOURCE, "export const value = 2;\n"); commit(root);
    const first = answer(root, base, "Replay remains unchanged."); const second = answer(root, base, "The refusal boundary also stays correct.");
    const result = impact(root, base); expect(result.failures).toEqual([]);
    expect(result.obligations[0]?.status).toBe("no-impact");
    expect(result.obligations[0]?.answers).toEqual([{ source: "trailer", commit: second, reason: "The refusal boundary also stays correct." }, { source: "trailer", commit: first, reason: "Replay remains unchanged." }]);
    expect(renderDocumentationImpact(result).join("\n")).toContain(`(${first.slice(0, 12)}): "Replay remains unchanged."`);
    expect(renderDocumentationImpact(result).join("\n")).toContain(`(${second.slice(0, 12)}): "The refusal boundary also stays correct."`);
  });
  it("ignores a matching answer in the base history", () => {
    const { root, base } = fixture(); write(root, SOURCE, "export const value = 2;\n"); const line = renderNoImpactTrailer(impact(root, base).obligations[0]!, "Replay stays correct.");
    write(root, SOURCE, "export const value = 1;\n"); const moved = commitTrailer(root, line);
    write(root, SOURCE, "export const value = 2;\n"); commit(root);
    expect(impact(root, moved).obligations[0]?.status).toBe("unanswered");
  });
  it.each([false, true])("ignores answers carried only by a merge (hosted first-parent base: %s)", hosted => {
    const { root, base } = fixture(); git(root, "checkout", "-qb", "topic"); write(root, SOURCE, "export const value = 2;\n"); const topic = commit(root);
    const line = renderNoImpactTrailer(impact(root, base).obligations[0]!, "Replay stays correct.");
    git(root, "checkout", "-qb", "integration", base);
    if (!hosted) { write(root, "README.md", `[Owner](${OWNER})\n\nIndependent prose.\n`); commit(root); }
    const comparison = git(root, "rev-parse", "HEAD"); merge(root, topic, `Merge\n\n${line}`);
    expect(impact(root, comparison).obligations[0]?.status).toBe("unanswered");
  });
  it.each(["trailer", "section"])("keeps a %s answer's binding when main edits owner prose", kind => {
    const { root, base } = fixture(); git(root, "checkout", "-qb", "topic"); write(root, SOURCE, "export const value = 2;\n");
    if (kind === "section") review(root, base);
    commit(root); if (kind === "trailer") answer(root, base);
    const topic = git(root, "rev-parse", "HEAD"); git(root, "checkout", "-qb", "integration", base);
    sectionUpdate(root); const moved = commit(root); merge(root, topic);
    const result = impact(root, moved);
    expect(result.obligations[0]?.status).toBe("no-impact");
    expect(result.failures).toEqual([]);
  });
  it("keeps P1's own-head legacy answer after main adds a heading and paragraph in its section", () => {
    const { root, base } = fixture(); git(root, "checkout", "-qb", "topic"); write(root, SOURCE, "export const value = 2;\n"); commit(root);
    review(root, base); const topic = commit(root);
    expect(impact(root, base).failures).toEqual([]);
    git(root, "checkout", "-qb", "integration", base);
    write(root, OWNER, ownerText.replace("The contract", "### Heading\n\nAdditional guidance from main.\n\nThe contract"));
    const moved = commit(root); merge(root, topic);
    const result = impact(root, moved);
    expect(result.failures).toEqual([]); expect(result.obligations[0]?.status).toBe("no-impact");
    expect(result.obligations[0]?.answers?.[0]?.source).toBe("section");
  }, 15_000);
  it("refuses a legacy digest for section text absent from the candidate and every own commit", () => {
    const { root, base } = fixture(); write(root, SOURCE, "export const value = 2;\n"); commit(root);
    const obligation = impact(root, base).obligations[0]!; sectionUpdate(root);
    const digest = legacyDigest(root, base, obligation);
    write(root, OWNER, ownerText.replace("## Other", `${renderNoImpactComment({ ...obligation, digest }, "Replay stays correct.")}\n\n## Other`)); commit(root);
    const result = impact(root, base); expect(result.obligations[0]?.status).toBe("unanswered"); expect(result.failures).toHaveLength(1);
  }, 15_000);
  it("never takes a legacy digest's section text from a merge commit", () => {
    // Negative plant: the only tree carrying the section text the digest binds is a merge commit's (an evil merge resolution).
    const { root, base } = fixture(); git(root, "checkout", "-qb", "side"); write(root, "README.md", `[Owner](${OWNER})\n\nSide prose.\n`); const side = commit(root);
    git(root, "checkout", "-qb", "topic", base); write(root, SOURCE, "export const value = 2;\n"); commit(root);
    git(root, "-c", "user.name=Documentation Test", "-c", "user.email=test@example.org", "merge", "--no-ff", "--no-commit", "-q", side);
    sectionUpdate(root); const obligation = impact(root, base).obligations.find((row) => row.unit === "domain-demo")!;
    const digest = legacyDigest(root, base, obligation); commit(root);
    expect(git(root, "rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toHaveLength(3);
    write(root, OWNER, ownerText.replace("## Other", `${renderNoImpactComment({ ...obligation, digest }, "Replay stays correct.")}\n\n## Other`)); commit(root);
    const result = impact(root, base); expect(result.obligations.find((row) => row.unit === "domain-demo")?.status).toBe("unanswered");
  }, 15_000);
  it("expires a legacy answer when the change edits its covered source after the record", () => {
    const { root, base } = fixture(); write(root, SOURCE, "export const value = 2;\n"); review(root, base); commit(root);
    expect(impact(root, base).failures).toEqual([]);
    write(root, SOURCE, "export const value = 3;\n"); commit(root);
    const result = impact(root, base); expect(result.obligations[0]?.status).toBe("unanswered"); expect(result.failures).toHaveLength(1);
  }, 15_000);
  it("never accepts the reported version-3 digest in a section comment", () => {
    const { root, base } = fixture(); write(root, SOURCE, "export const value = 2;\n"); commit(root);
    const obligation = impact(root, base).obligations[0]!;
    write(root, OWNER, ownerText.replace("## Other", `${renderNoImpactComment(obligation, "Replay stays correct.")}\n\n## Other`)); commit(root);
    const result = impact(root, base); expect(result.obligations[0]?.status).toBe("unanswered"); expect(result.failures).toHaveLength(1);
  }, 15_000);
  it("expires a legacy answer when moved main changes its covered source despite matching own prose", () => {
    const { root } = fixture(); const source = "export const value = 1;\n\n// Separate implementation.\n// Preserve distance between independent edits.\n\nexport const other = 1;\n";
    write(root, SOURCE, source); const base = commit(root); git(root, "checkout", "-qb", "topic");
    write(root, SOURCE, source.replace("value = 1", "value = 2")); review(root, base); const topic = commit(root);
    expect(impact(root, base).failures).toEqual([]);
    git(root, "checkout", "-qb", "integration", base);
    write(root, SOURCE, source.replace("other = 1", "other = 2")); sectionUpdate(root); const moved = commit(root); merge(root, topic);
    const result = impact(root, moved); expect(result.obligations[0]?.status).toBe("unanswered"); expect(result.failures).toHaveLength(1);
  }, 15_000);
  it.each([false, true])("in a shallow clone checks legacy answers only against current prose (main edited: %s)", changed => {
    const { root, base } = fixture(); git(root, "checkout", "-qb", "topic"); write(root, SOURCE, "export const value = 2;\n");
    review(root, base); const topic = commit(root); git(root, "checkout", "-qb", "integration", base);
    if (changed) sectionUpdate(root); else write(root, "README.md", `[Owner](${OWNER})\n\nIndependent main prose.\n`);
    const moved = commit(root); merge(root, topic);
    const shallow = join(temporary(), "checkout"); git(root, "clone", "-q", "--depth=2", `file://${root}`, shallow);
    expect(git(shallow, "rev-parse", "--is-shallow-repository")).toBe("true");
    const result = impact(shallow, moved); expect(result.obligations[0]?.status).toBe(changed ? "unanswered" : "no-impact");
    if (!changed) { expect(result.failures).toEqual([]); expect(result.obligations[0]?.answers?.[0]?.source).toBe("section"); }
    else expect(result.failures).toHaveLength(1);
  }, 15_000);
  it("escapes Unicode line separators and direction controls in printed reasons", () => {
    const characters = "\u0085\u2028\u2029\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069";
    const lines = renderDocumentationImpact({ base: "a".repeat(40), failures: [], obligations: [{ unit: "domain-demo", doc: OWNER, anchor: "#canonical", changedPaths: [SOURCE], digest: `sha256-${"a".repeat(64)}`, status: "no-impact", answers: [{ source: "section", reason: `Replay${characters}stays correct.` }] }] });
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain('"Replay\\u0085\\u2028\\u2029\\u200e\\u200f\\u202a\\u202b\\u202c\\u202d\\u202e\\u2066\\u2067\\u2068\\u2069stays correct."');
    for (const character of characters) expect(lines[2]).not.toContain(character);
  });
  it("merges independent answers for the same unit without editing a shared line", () => {
    const { root, base } = fixture(); const heads: string[] = [];
    for (const [branch, path] of [["one", SOURCE], ["two", "src/domains/demo/other.ts"]]) {
      git(root, "checkout", "-qb", branch!, base); write(root, path!, "export const value = 2;\n"); commit(root); heads.push(answer(root, base));
    }
    git(root, "checkout", "-qb", "integration", base); let comparison = base;
    for (const head of heads) { const merged = merge(root, head); expect(impact(root, comparison).failures).toEqual([]); comparison = merged; }
    expect(readFileSync(join(root, OWNER), "utf8")).toBe(ownerText);
  });
  it("expires after source edits and accepts a later answer for the new digest", () => {
    const { root, base } = fixture(); write(root, SOURCE, "export const value = 2;\n"); commit(root); answer(root, base);
    write(root, SOURCE, "export const value = 3;\n"); commit(root); expect(impact(root, base).obligations[0]?.status).toBe("unanswered");
    answer(root, base); expect(impact(root, base).failures).toEqual([]);
  });
  it.each(["source", "routing"])("expires when the base changes the covered path's %s", kind => {
    const { root, base, surfaces } = fixture(); write(root, SOURCE, "export const value = 2;\n"); const line = renderNoImpactTrailer(impact(root, base).obligations[0]!, "Replay stays correct.");
    write(root, SOURCE, "export const value = 1;\n");
    if (kind === "source") write(root, SOURCE, "export const value = 3;\n");
    else { surfaces[1] = { ...surfaces[1]!, anchor: "#other" }; write(root, "config/doc-routing.json", JSON.stringify({ version: 2, surfaces })); }
    const moved = commit(root);
    if (kind === "routing") { surfaces[1] = { ...surfaces[1]!, anchor: "#canonical" }; write(root, "config/doc-routing.json", JSON.stringify({ version: 2, surfaces })); }
    write(root, SOURCE, "export const value = 2;\n"); commit(root); commitTrailer(root, line);
    const obligation = impact(root, moved).obligations.find(row => row.unit === "domain-demo" && row.anchor === "#canonical")!;
    expect(obligation.status).toBe("unanswered"); expect(line).not.toContain(obligation.digest);
  });
  it.each(["unit", "digest"])("ignores a %s mismatch", field => {
    const { root, base } = fixture(); write(root, SOURCE, "export const value = 2;\n"); commit(root);
    const obligation = impact(root, base).obligations[0]!;
    commitTrailer(root, renderNoImpactTrailer({ ...obligation, [field]: field === "unit" ? "other-unit" : `sha256-${"0".repeat(64)}` }, "Replay stays correct."));
    expect(impact(root, base).obligations[0]?.status).toBe("unanswered");
  });
  it.each(["bad JSON", "null", "[]", '{"unit":"domain-demo"}', JSON.stringify({ unit: "bad_unit", digest: `sha256-${"0".repeat(64)}`, reason: "why" }), JSON.stringify({ unit: "domain-demo", digest: "bad", reason: "why" }), JSON.stringify({ unit: "domain-demo", digest: `sha256-${"0".repeat(64)}`, reason: " " }), JSON.stringify({ unit: "domain-demo", digest: `sha256-${"0".repeat(64)}`, reason: "why", extra: true })])("reports a malformed trailer with its commit: %s", value => {
    const { root, base } = fixture(); write(root, SOURCE, "export const value = 2;\n"); commit(root); const sha = commitTrailer(root, `OpenLup-Doc-Impact: ${value}`);
    const result = impact(root, base); expect(result.failures.join("\n")).toContain(`malformed OpenLup-Doc-Impact trailer in ${sha.slice(0, 12)}:`);
    expect(renderDocumentationImpact(result).filter(line => line.startsWith(`documentation: malformed OpenLup-Doc-Impact trailer in ${sha.slice(0, 12)}:`))).toHaveLength(1);
  });
  it("reads only exact column-zero keys and refuses a malformed record even when no answer is needed", () => {
    const { root, base } = fixture(); write(root, SOURCE, "export const value = 2;\n"); commit(root);
    const line = renderNoImpactTrailer(impact(root, base).obligations[0]!, "Replay stays correct.");
    commitTrailer(root, ` ${line}\n${line.replace("OpenLup", "Openlup")}\nOther: ${line}`);
    expect(impact(root, base).obligations[0]?.status).toBe("unanswered");
    commitTrailer(root, "OpenLup-Doc-Impact: {\"unit\": \u001b[31m}"); sectionUpdate(root);
    const result = impact(root, base); expect(result.obligations[0]?.status).toBe("updated");
    expect(result.failures).toEqual([expect.stringMatching(/^malformed OpenLup-Doc-Impact trailer in [0-9a-f]{12}: invalid JSON$/u)]);
  });
  it("accepts a CRLF record and prints a legacy section record's reason", () => {
    const { root, base } = fixture(); write(root, SOURCE, "export const value = 2;\n"); commit(root);
    commitTrailer(root, `${renderNoImpactTrailer(impact(root, base).obligations[0]!, "Replay stays correct.")}\r`);
    expect(impact(root, base).failures).toEqual([]);
    const legacy = fixture(); write(legacy.root, SOURCE, "export const value = 2;\n"); review(legacy.root, legacy.base);
    expect(impact(legacy.root, legacy.base).failures).toEqual([]);
    expect(impact(legacy.root, legacy.base).obligations[0]?.answers?.[0]?.source).toBe("section");
    expect(renderDocumentationImpact(impact(legacy.root, legacy.base)).join("\n")).toContain('(section record): "This internal implementation change preserves the documented replay contract."');
  });
  it("refuses to read trailers in a shallow range", () => {
    const { root, base } = fixture(); write(root, SOURCE, "export const value = 2;\n"); commit(root); answer(root, base);
    const shallow = join(temporary(), "checkout"); git(root, "clone", "-q", "--depth=3", `file://${root}`, shallow);
    expect(git(shallow, "rev-parse", "--is-shallow-repository")).toBe("true");
    expect(impact(shallow, base).failures.join("\n")).toContain("this checkout is shallow, so no trailer could be read: fetch complete history");
  });
  it("renders the exact trailer format and refuses empty or multiline reasons", () => {
    const obligation = { unit: "domain-demo", digest: `sha256-${"a".repeat(64)}` };
    expect(renderNoImpactTrailer(obligation, 'Replay "stays" correct.')).toBe(`OpenLup-Doc-Impact: ${JSON.stringify({ ...obligation, reason: 'Replay "stays" correct.' })}`);
    for (const reason of ["", " \t", "why\nmore", "why\rmore", "why\u2028more", "why\u2029more"]) expect(() => renderNoImpactTrailer(obligation, reason)).toThrow(/reason/);
  });
});

function hostedEvent(root: string, base: string, eventName = "push", extra: Record<string, unknown> = {}): NodeJS.ProcessEnv {
  const head = git(root, "rev-parse", "HEAD"); const eventPath = join(temporary(), "event.json");
  writeFileSync(eventPath, JSON.stringify({ repository: { full_name: "openlup/openlup", private: false }, before: base, after: head, ...extra }));
  return { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "openlup/openlup", GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: eventPath, GITHUB_SHA: head, PATH: process.env.PATH };
}
function mergeGroupEvent(root: string, base: string, patch: Record<string, unknown> = {}): NodeJS.ProcessEnv {
  const head = git(root, "rev-parse", "HEAD"); const ref = "refs/heads/gh-readonly-queue/main/pr-1-fixture";
  return { ...hostedEvent(root, base, "merge_group", { action: "checks_requested", merge_group: {
    base_sha: base, base_ref: "refs/heads/main", head_sha: head, head_ref: ref,
    head_commit: { id: head, tree_id: git(root, "rev-parse", "HEAD^{tree}") }, ...patch,
  } }), GITHUB_REF: ref };
}

describe("strict documentation base attribution", () => {
  it.each(["rewrite", "header", "included-header", "remote-alias"])("refuses effective %s configuration before public fallback transport", (setting) => {
    const { root, base } = fixture(); write(root, SOURCE, "export const value = 2;\n"); commit(root);
    const shallow = join(temporary(), "checkout"); git(root, "clone", "-q", "--depth=1", `file://${root}`, shallow);
    if (setting === "rewrite") git(shallow, "config", `url.file://${root}.insteadOf`, "https://github.com/openlup/openlup.git");
    else if (setting === "header") git(shallow, "config", "http.https://github.com/openlup/.extraHeader", "Authorization: SyntheticDocumentationFixture");
    else if (setting === "remote-alias") git(shallow, "config", "remote.https://github.com/openlup/openlup.git.url", `file://${root}`);
    else {
      const included = join(temporary(), "transport.gitconfig");
      writeFileSync(included, '[http "https://github.com/openlup/"]\n extraHeader = Authorization: SyntheticDocumentationFixture\n');
      git(shallow, "config", "include.path", included);
    }
    fetchMock.source = root;
    expect(() => resolveDocumentationBase(shallow, { env: hostedEvent(shallow, base) })).toThrow(/transport or credential configuration/);
    expect(fetchMock.calls).toHaveLength(0);
  });
  it("uses a local merge base, refuses unknown/nonancestor bases and never silently skips", () => {
    const { root, base } = fixture(); expect(resolveDocumentationBase(root, { env: {} }).base).toBe(base);
    expect(() => resolveDocumentationBase(root, { base: "HEAD", env: {} })).toThrow(/full commit SHA/);
    expect(() => resolveDocumentationBase(root, { base: "f".repeat(40), env: {} })).toThrow();
    git(root, "checkout", "--orphan", "unrelated"); git(root, "rm", "-rf", "."); write(root, "unrelated.txt", "unrelated\n"); const other = commit(root);
    git(root, "checkout", "-q", "--detach", base);
    expect(() => resolveDocumentationBase(root, { base: other, env: {} })).toThrow(/not an ancestor/);
    git(root, "update-ref", "-d", "refs/remotes/origin/main"); expect(() => resolveDocumentationBase(root, { env: {} })).toThrow();
  });
  it("prioritizes valid public hosted events over a caller override and rejects identity drift", () => {
    const { root, base } = fixture(); write(root, SOURCE, "export const value = 2;\n"); commit(root);
    const env = hostedEvent(root, base);
    expect(resolveDocumentationBase(root, { base: "f".repeat(40), env }).provenance).toBe("push");
    for (const patch of [{ GITHUB_REPOSITORY: "foreign/repository" }, { GITHUB_SHA: base }, { GITHUB_EVENT_NAME: "workflow_dispatch" }])
      expect(() => resolveDocumentationBase(root, { env: { ...env, ...patch } })).toThrow(/identity|event/);
    const privateEnv = hostedEvent(root, base, "push", { repository: { full_name: "openlup/openlup", private: true } });
    expect(() => resolveDocumentationBase(root, { env: privateEnv })).toThrow(/public OpenLup/);
  });
  it("validates the actual PR merge parents", () => {
    const { root, base } = fixture(); git(root, "checkout", "-qb", "topic"); write(root, SOURCE, "export const value = 2;\n"); const source = commit(root);
    git(root, "checkout", "-qb", "merge", base); git(root, "-c", "user.name=Documentation Test", "-c", "user.email=test@example.org", "merge", "--no-ff", "-qm", "merge fixture", "topic");
    const env = hostedEvent(root, base, "pull_request", { pull_request: { base: { sha: base }, head: { sha: source }, merge_commit_sha: git(root, "rev-parse", "HEAD") } });
    expect(resolveDocumentationBase(root, { env }).provenance).toBe("pull-request");
    git(root, "checkout", "-q", "--detach", source); env.GITHUB_SHA = source;
    expect(() => resolveDocumentationBase(root, { env })).toThrow(/base\/head merge/);
  });
  describe("the pull-request identity fence", () => {
    function merged() {
      const { root, base } = fixture(); git(root, "checkout", "-qb", "topic"); write(root, SOURCE, "export const value = 2;\n"); const source = commit(root);
      git(root, "checkout", "-qb", "merge", base); git(root, "-c", "user.name=Documentation Test", "-c", "user.email=test@example.org", "merge", "--no-ff", "-qm", "merge fixture", "topic");
      return { root, base, source, merge: git(root, "rev-parse", "HEAD") };
    }
    const pullRequest = (root: string, base: string, source: string, mergeCommit: string) => hostedEvent(root, base, "pull_request", { pull_request: { base: { sha: base }, head: { sha: source }, merge_commit_sha: mergeCommit } });
    it("F1 accepts exact parents when the payload's merge_commit_sha lags", () => {
      const { root, base, source } = merged(); expect(resolveDocumentationBase(root, { env: pullRequest(root, base, source, base) }).provenance).toBe("pull-request");
    });
    it("F2 refuses swapped parents", () => {
      const { root, base, source } = merged(); const swapped = git(root, "-c", "user.name=Documentation Test", "-c", "user.email=test@example.org", "commit-tree", git(root, "rev-parse", "HEAD^{tree}"), "-p", source, "-p", base, "-m", "swapped");
      git(root, "checkout", "-q", "--detach", swapped); expect(() => resolveDocumentationBase(root, { env: pullRequest(root, base, source, swapped) })).toThrow(/base\/head merge/);
    });
    it("F3 refuses a one-parent checkout", () => {
      const { root, base, source } = merged(); git(root, "checkout", "-q", "--detach", source); expect(() => resolveDocumentationBase(root, { env: pullRequest(root, base, source, source) })).toThrow(/base\/head merge/);
    });
    it("F4 refuses a first parent other than the event base", () => {
      const { root, source, merge } = merged(); expect(() => resolveDocumentationBase(root, { env: pullRequest(root, source, source, merge) })).toThrow(/base\/head merge/);
    });
    it("F5 refuses a checkout other than GITHUB_SHA", () => {
      const { root, base, source, merge } = merged(); const env = pullRequest(root, base, source, merge); env.GITHUB_SHA = source;
      expect(() => resolveDocumentationBase(root, { env })).toThrow(/hosted checkout identity/);
    });
  });
  it("attributes a complete merge batch to its exact event base, head, ref and checkout", () => {
    const { root, base } = fixture(); write(root, SOURCE, "export const value = 2;\n"); commit(root);
    write(root, "src/domains/demo/other.ts", "export const other = 2;\n"); const head = commit(root);
    const env = mergeGroupEvent(root, base);
    expect(resolveDocumentationBase(root, { base: head, env })).toEqual({ base, head, provenance: "merge-group" });
    expect(fetchMock.calls).toEqual([]);
    write(root, SOURCE, "export const value = 3;\n"); commit(root);
    expect(() => resolveDocumentationBase(root, { env })).toThrow(/checkout identity/);
  });
  it.each([
    { base_sha: undefined }, { base_sha: "invalid" }, { base_sha: "0".repeat(40) },
    { base_ref: undefined }, { base_ref: "refs/heads/other" },
    { head_sha: undefined }, { head_sha: "f".repeat(40) },
    { head_ref: undefined }, { head_ref: "refs/heads/main" },
    { head_commit: undefined }, { head_commit: { id: "f".repeat(40), tree_id: "a".repeat(40) } },
  ])("refuses missing or malformed merge-group attribution %j before transport", (patch) => {
    const { root, base } = fixture(); write(root, SOURCE, "export const value = 2;\n"); commit(root);
    expect(() => resolveDocumentationBase(root, { env: mergeGroupEvent(root, base, patch) })).toThrow(/merge-group checkout/);
    expect(fetchMock.calls).toEqual([]);
  });
  it("refuses missing group/action/ref, wrong tree, empty range and unrelated base", () => {
    const { root, base } = fixture(); write(root, SOURCE, "export const value = 2;\n"); const head = commit(root);
    const env = mergeGroupEvent(root, base);
    const original = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH!, "utf8"));
    for (const patch of [{ action: undefined }, { action: "destroyed" }, { merge_group: undefined }]) {
      writeFileSync(env.GITHUB_EVENT_PATH!, JSON.stringify({ ...original, ...patch }));
      expect(() => resolveDocumentationBase(root, { env })).toThrow(/merge-group checkout/);
    }
    writeFileSync(env.GITHUB_EVENT_PATH!, JSON.stringify(original));
    for (const patch of [{ GITHUB_REF: undefined }, { GITHUB_REF: "refs/heads/gh-readonly-queue/main/pr-2-fixture" }])
      expect(() => resolveDocumentationBase(root, { env: { ...env, ...patch } })).toThrow(/merge-group checkout/);
    const wrongTree = mergeGroupEvent(root, base, { head_commit: { id: head, tree_id: "f".repeat(40) } });
    expect(() => resolveDocumentationBase(root, { env: wrongTree })).toThrow(/merge-group checkout/);
    expect(() => resolveDocumentationBase(root, { env: mergeGroupEvent(root, head) })).toThrow(/merge-group checkout/);
    const badRef = "refs/heads/gh-readonly-queue/main/../fixture";
    expect(() => resolveDocumentationBase(root, { env: { ...mergeGroupEvent(root, base, { head_ref: badRef }), GITHUB_REF: badRef } })).toThrow(/ref is malformed/);
    git(root, "checkout", "--orphan", "unrelated"); git(root, "rm", "-rf", "."); write(root, "other.txt", "other\n"); const other = commit(root);
    git(root, "checkout", "-q", "--detach", head);
    expect(() => resolveDocumentationBase(root, { env: mergeGroupEvent(root, other) })).toThrow(/not an observed ancestor/);
    expect(fetchMock.calls).toEqual([]);
  });
  it("fetches a missing shallow CI base with no credentials, refs or FETCH_HEAD; failure refuses", () => {
    const { root, base } = fixture(); write(root, SOURCE, "export const value = 2;\n"); commit(root);
    const shallow = join(temporary(), "checkout"); git(root, "clone", "-q", "--depth=1", `file://${root}`, shallow);
    expect(() => resolveDocumentationBase(shallow, { base, env: {} })).toThrow();
    const env = hostedEvent(shallow, base); env.DEMONSTRATION_TOKEN = "synthetic";
    expect(() => resolveDocumentationBase(shallow, { env })).toThrow(/simulated public base fetch failure/);
    fetchMock.source = root; expect(resolveDocumentationBase(shallow, { env }).base).toBe(base);
    const call = fetchMock.calls.at(-1)!;
    expect(call.args).toContain("--no-write-fetch-head"); expect(call.args).toContain("credential.helper="); expect(call.args).toContain("core.askPass=");
    for (const flag of ["--no-prune", "--no-prune-tags", "--no-recurse-submodules", "--refmap=", "--no-auto-maintenance", "--no-write-commit-graph"])
      expect(call.args).toContain(flag);
    expect(call.options.env?.GIT_TERMINAL_PROMPT).toBe("0"); expect(call.options.env?.DEMONSTRATION_TOKEN).toBeUndefined();
    expect(existsSync(join(shallow, ".git/FETCH_HEAD"))).toBe(false);
  });
});
