import { build, type Metafile } from "esbuild";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const commerceRoot = join(packageRoot, "src/commerce");
function browserSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "server" ? [] : browserSources(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

const sharedTemplateExports = [
  "OUTBOX_CHECKOUT_EXPIRED_TEMPLATE_SLUG",
  "OUTBOX_ORDER_CONFIRMATION_TEMPLATE_SLUG",
  "OUTBOX_ORDER_PAID_TEMPLATE_SLUG",
  "OUTBOX_ORDER_REFUNDED_TEMPLATE_SLUG",
  "OUTBOX_PAYMENT_FAILED_TEMPLATE_SLUG",
  "OUTBOX_RETURN_APPROVED_TEMPLATE_SLUG",
  "OUTBOX_RETURN_REJECTED_TEMPLATE_SLUG",
  "OUTBOX_SHIPMENT_DELIVERED_TEMPLATE_SLUG",
  "OUTBOX_SHIPMENT_DISPATCHED_TEMPLATE_SLUG",
  "OUTBOX_SHIPMENT_EXCEPTION_TEMPLATE_SLUG",
];

function bundle(entry: URL, platform: "browser" | "node") {
  return build({
    entryPoints: [fileURLToPath(entry)], bundle: true, platform, format: "esm",
    write: false, metafile: true, logLevel: "silent",
  });
}

const browserEntry = new URL("../../dist/commerce/index.js", import.meta.url);
const serverEntry = new URL("../../dist/commerce/server/index.js", import.meta.url);
const bundleExports = (metafile: Metafile) => Object.values(metafile.outputs).flatMap(({ exports }) => exports).sort();

function expectBrowserGraph(metafile: Metafile) {
  for (const [path, input] of Object.entries(metafile.inputs)) {
    expect(path).not.toMatch(/(?:^|[/\\])commerce[/\\]server[/\\]/);
    for (const name of [path, ...input.imports.map(({ path }) => path)]) {
      expect(name).not.toMatch(/^(?:node:|pg(?:\/|$))|(?:^|[/\\])node_modules[/\\]pg(?:[/\\]|$)/);
    }
  }
}

describe("commerce runtime placement", () => {
  it("bundles the complete published commerce entry for browsers without externals", async () => {
    const result = await bundle(browserEntry, "browser");
    expectBrowserGraph(result.metafile);
    const inputs = Object.entries(result.metafile.inputs);
    expect(inputs.length).toBeGreaterThan(10);
    expect(inputs.filter(([path]) => /(?:^|\/)commerce\/server\//.test(path))).toEqual([]);
    expect(inputs.flatMap(([, input]) => input.imports).filter(({ path }) => path.startsWith("node:"))).toEqual([]);
    expect(result.outputFiles[0]!.text).not.toMatch(/(?:from\s*|import\s*\(|require\s*\()\s*["']node:/);
    const server = await import(/* @vite-ignore */ serverEntry.href);
    expect(bundleExports(result.metafile).filter(name => Object.hasOwn(server, name))).toEqual(sharedTemplateExports.toSorted());
  });

  it("has no source import of commerce/server, including erased type imports", () => {
    const files = browserSources(commerceRoot);
    expect(files.length).toBeGreaterThan(10);
    for (const path of files) {
      const source = readFileSync(path, "utf8");
      const imports = ts.preProcessFile(source, true, true).importedFiles;
      for (const { fileName } of imports) {
        const target = fileName.startsWith(".") ? relative(commerceRoot, resolve(dirname(path), fileName)).replaceAll("\\", "/") : fileName;
        expect(target, `${relative(commerceRoot, path)} imports ${fileName}`).not.toMatch(/^(?:server\/|@openlup\/platform\/commerce\/server(?:\/|$))/);
      }
    }
  });

  it.each(["orderReviewContracts", "orderFeedbackContracts"])("bundles the reference %s facade for browsers", async (name) => {
    const result = await bundle(new URL(`../../../../src/domains/commerce/${name}.ts`, import.meta.url), "browser");
    expectBrowserGraph(result.metafile);
  });

  it("bundles the complete server entry for Node with only the public server exports", async () => {
    const result = await bundle(serverEntry, "node");
    const runtime = await import(/* @vite-ignore */ serverEntry.href);
    expect(bundleExports(result.metafile)).toEqual(Object.keys(runtime).sort());
  });

  it("keeps the emitted commerce server declarations independent of pg and Platform data", () => {
    const entry = new URL("index.d.ts", serverEntry);
    const declarations = new Set([entry.href]);
    const forbidden: string[] = [];
    for (const declaration of declarations) {
      const source = readFileSync(new URL(declaration), "utf8");
      const { importedFiles, typeReferenceDirectives } = ts.preProcessFile(source, true, true);
      for (const { fileName } of [...importedFiles, ...typeReferenceDirectives]) {
        if (/^(?:pg|@types\/pg)(?:\/|$)|(?:^|\/)data(?:\/|$)/u.test(fileName)) {
          forbidden.push(`${declaration} imports ${fileName}`);
        } else if (fileName.startsWith(".") && fileName.endsWith(".js")) {
          declarations.add(new URL(fileName.replace(/\.js$/u, ".d.ts"), declaration).href);
        }
      }
    }
    expect(declarations.has(new URL("commerceMoneyLimitsV2.d.ts", entry).href)).toBe(true);
    expect(forbidden).toEqual([]);
  });

  it("refuses raw upload in a browser as a live negative control", async () => {
    await expect(bundle(new URL("../../src/commerce/server/orderReviewRawUploadHandler.ts", import.meta.url), "browser"))
      .rejects.toMatchObject({ errors: expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining("node:crypto") }),
        expect.objectContaining({ text: expect.stringContaining("node:zlib") }),
      ]) });
  });
});
