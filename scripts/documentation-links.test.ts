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

  it("ignores exact-run inline code spans, escaped brackets, and indented code", () => {
    const root = fixture();
    writeFileSync(join(root, "docs", "source.md"), [
      "`` example ` [example](absent.md) ``",
      "",
      String.raw`\[example](absent.md)`,
      "",
      "    [example](absent.md)",
      "",
      "\t[example](absent.md)",
      "",
      "[label `code`](folder%20name/target.md)",
      "- parent",
      "    - [nested](folder%20name/target.md)",
    ].join("\n"));
    expect(() => assertLocalDocumentationLinks(root, ["docs/source.md", "docs/folder name/target.md"])).not.toThrow();
  });

  it("still rejects a real broken link adjacent to code examples", () => {
    const root = fixture();
    writeFileSync(join(root, "docs", "source.md"), [
      "`` example ` [example](absent.md) ``",
      "",
      String.raw`\[example](absent.md)`,
      "",
      "    [example](absent.md)",
      "",
      "[real](absent.md)",
    ].join("\n"));
    expect(() => assertLocalDocumentationLinks(root, ["docs/source.md", "docs/folder name/target.md"]))
      .toThrow(/missing local link target.*absent\.md/u);
  });

  it("distinguishes an indented list example from an actual nested list", () => {
    const root = fixture();
    writeFileSync(join(root, "docs", "source.md"), "    - [example](absent.md)\n");
    expect(() => assertLocalDocumentationLinks(root, ["docs/source.md", "docs/folder name/target.md"])).not.toThrow();
    writeFileSync(join(root, "docs", "source.md"), "- Parent\n\n    - [real](absent.md)\n");
    expect(() => assertLocalDocumentationLinks(root, ["docs/source.md", "docs/folder name/target.md"]))
      .toThrow(/missing local link target.*absent\.md/u);
  });

  it("checks broken links inside indented nested-list items", () => {
    const root = fixture();
    writeFileSync(join(root, "docs", "source.md"), "- parent\n    - [nested](absent.md)\n");
    expect(() => assertLocalDocumentationLinks(root, ["docs/source.md", "docs/folder name/target.md"]))
      .toThrow(/missing local link target.*absent\.md/u);
  });

  it("checks paragraph links continued inside a list item after a blank line", () => {
    const root = fixture();
    writeFileSync(join(root, "docs", "source.md"), "- Item\n\n    [real](absent.md)\n");
    expect(() => assertLocalDocumentationLinks(root, ["docs/source.md", "docs/folder name/target.md"]))
      .toThrow(/missing local link target.*absent\.md/u);
  });

  it("does not treat an HTML id inside inline code as a fragment target", () => {
    const root = fixture();
    writeFileSync(join(root, "docs", "folder name", "target.md"), "# Target\n\n`<a id=\"code-example\"></a>`\n");
    writeFileSync(join(root, "docs", "source.md"), "[code example](folder%20name/target.md#code-example)\n");
    expect(() => assertLocalDocumentationLinks(root, ["docs/source.md", "docs/folder name/target.md"]))
      .toThrow(/missing local fragment.*code-example/u);
  });

  it("does not carry list indentation context across a later block", () => {
    const root = fixture();
    writeFileSync(join(root, "docs", "source.md"), [
      "- Item",
      "",
      "# Section",
      "",
      "    [heading example](absent.md)",
      "",
      "Outside paragraph.",
      "",
      "    [paragraph example](absent.md)",
    ].join("\n"));
    expect(() => assertLocalDocumentationLinks(root, ["docs/source.md", "docs/folder name/target.md"])).not.toThrow();
  });

  it("checks an indented link that continues an open paragraph", () => {
    const root = fixture();
    writeFileSync(join(root, "docs", "source.md"), "Paragraph\n    [real](absent.md)\n");
    expect(() => assertLocalDocumentationLinks(root, ["docs/source.md", "docs/folder name/target.md"]))
      .toThrow(/missing local link target.*absent\.md/u);
  });
});
