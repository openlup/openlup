import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const repoRoot = process.cwd();
const adminRoots = ["src/pages/admin", "src/components/admin"];
const allowedSrcDocFiles = new Set([
  "src/pages/admin/TemplatesPage.tsx",
  "src/pages/admin/TemplateEditDialog.tsx",
]);
const allowedInnerHtmlFiles = new Set(["src/pages/admin/emailTemplatePreview.ts"]);

describe("admin HTML boundary guardrails", () => {
  it("keeps admin raw HTML rendering behind the email template preview boundary", () => {
    const violations: string[] = [];
    for (const file of adminSourceFiles()) {
      const relativeFile = relative(repoRoot, file);
      const source = readFileSync(file, "utf8");

      if (source.includes("dangerouslySetInnerHTML")) {
        violations.push(`${relativeFile}: dangerouslySetInnerHTML is not allowed in admin UI`);
      }

      if (source.includes("srcDoc=") && !allowedSrcDocFiles.has(relativeFile)) {
        violations.push(`${relativeFile}: iframe srcDoc must stay in the central email preview components`);
      }

      if (source.includes("srcDoc=") && !source.includes("buildEmailTemplatePreviewSrcDoc")) {
        violations.push(`${relativeFile}: iframe srcDoc must be produced by buildEmailTemplatePreviewSrcDoc`);
      }

      if (source.includes("<iframe") && !source.includes('sandbox=""')) {
        violations.push(`${relativeFile}: admin preview iframes must be sandboxed without script permissions`);
      }

      if (source.includes("innerHTML") && !allowedInnerHtmlFiles.has(relativeFile)) {
        violations.push(`${relativeFile}: direct innerHTML is limited to the sanitizer helper`);
      }
    }

    expect(violations).toEqual([]);
  });
});

function adminSourceFiles(): string[] {
  const files: string[] = [];
  for (const root of adminRoots) collect(join(repoRoot, root), files);
  return files.filter((file) => /\.(?:ts|tsx)$/.test(file) && !/\.test\.(?:ts|tsx)$/.test(file));
}

function collect(dir: string, files: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) collect(path, files);
    else files.push(path);
  }
}
