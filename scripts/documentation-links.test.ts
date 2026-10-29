import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertLocalDocumentationLinks } from "./documentation-routing.ts";

const roots: string[] = [];
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "documentation-links-"));
  roots.push(root);
  mkdirSync(join(root, "docs", "folder name"), { recursive: true });
  writeFileSync(join(root, "docs", "source.md"), "# Source\n");
  writeFileSync(join(root, "docs", "folder name", "target.md"), "# Café\n\n## Repeated\n\n## Repeated\n\n<a id=\"html-section\"></a>\n");
  return root;
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("local documentation links", () => {
  it("accepts encoded paths and fragments, duplicate heading slugs, HTML ids, and reference links", () => {
    const root = fixture();
    writeFileSync(join(root, "docs", "source.md"), [
      "[encoded](folder%20name/target.md#caf%C3%A9)",
      "[duplicate](folder%20name/target.md#repeated-1)",
      "[html](folder%20name/target.md#html-section)",
      "[reference][target]",
      "[target]",
      "[target]: <folder%20name/target.md#café>",
    ].join("\n"));
    expect(() => assertLocalDocumentationLinks(root, ["docs/source.md", "docs/folder name/target.md"])).not.toThrow();
  });

  it("rejects a local fragment whose heading was removed or never existed", () => {
    const root = fixture();
    writeFileSync(join(root, "docs", "source.md"), "[old section](folder%20name/target.md#removed-heading)\n");
    expect(() => assertLocalDocumentationLinks(root, ["docs/source.md", "docs/folder name/target.md"]))
      .toThrow(/missing local fragment.*removed-heading/u);
  });

  it("rejects a missing local file target", () => {
    const root = fixture();
    writeFileSync(join(root, "docs", "source.md"), "[missing](folder%20name/missing.md)\n");
    expect(() => assertLocalDocumentationLinks(root, ["docs/source.md", "docs/folder name/target.md"]))
      .toThrow(/missing local link target.*missing\.md/u);
  });

  it("accepts a directory backed by tracked descendants", () => {
    const root = fixture();
    writeFileSync(join(root, "docs", "source.md"), "[directory](folder%20name/)\n");
    expect(() => assertLocalDocumentationLinks(root, ["docs/source.md", "docs/folder name/target.md"])).not.toThrow();
  });

  it("rejects a directory with no tracked descendants", () => {
    const root = fixture();
    writeFileSync(join(root, "docs", "source.md"), "[directory](missing/)\n");
    expect(() => assertLocalDocumentationLinks(root, ["docs/source.md", "docs/folder name/target.md"]))
      .toThrow(/missing local link target.*missing\//u);
  });

  it("ignores broken link examples inside fenced code", () => {
    const root = fixture();
    writeFileSync(join(root, "docs", "source.md"), "```md\n[example](absent.md#not-real)\n```\n");
    expect(() => assertLocalDocumentationLinks(root, ["docs/source.md", "docs/folder name/target.md"])).not.toThrow();
  });
});
