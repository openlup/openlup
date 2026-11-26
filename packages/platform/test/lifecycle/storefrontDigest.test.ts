import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { digestStorefrontFiles } from "../../src/lifecycle/index.js";

const encode = (text: string) => new TextEncoder().encode(text);
const files = [
  { path: "assets/app.js", bytes: encode("console.log(1);\n") },
  { path: "index.html", bytes: encode("<!doctype html>\n") },
];

describe("digestStorefrontFiles", () => {
  it("D1 gives one digest for any input order and changes with any byte or path", async () => {
    const digest = await digestStorefrontFiles(files);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await digestStorefrontFiles([...files].reverse())).toBe(digest);
    const changedByte = [files[0]!, { path: "index.html", bytes: encode("<!doctype html>\r") }];
    const renamed = [files[0]!, { path: "index.htm", bytes: files[1]!.bytes }];
    const added = [...files, { path: "empty.txt", bytes: new Uint8Array() }];
    for (const variant of [changedByte, renamed, added]) expect(await digestStorefrontFiles(variant)).not.toBe(digest);
  });

  it("D2 is pinned by a literal and by an independent recomputation", async () => {
    const digest = await digestStorefrontFiles(files);
    expect(digest).toBe("sha256:43f0128c5998a51fc4bc81fea708732821017679c4218b6c3da2019904214af6");
    const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
    const manifest = [...files].sort((a, b) => (a.path < b.path ? -1 : 1)).map(file => `${file.path}\u0000${sha(file.bytes)}\n`).join("");
    expect(digest).toBe(`sha256:${sha(Buffer.from(manifest, "utf8"))}`);
  });

  it("D3 refuses paths outside the rules", async () => {
    const bad = ["/a", "a//b", "./a", "a/../b", "a\\b", "a\u0000b", "a\nb", "a\ud800", "e\u0301", "", "a/", "."];
    for (const path of bad) {
      await expect(digestStorefrontFiles([{ path, bytes: new Uint8Array() }]), JSON.stringify(path)).rejects.toThrow(TypeError);
      await expect(digestStorefrontFiles([{ path, bytes: new Uint8Array() }])).rejects.toThrow(/^storefront_digest_path_invalid: path /);
    }
    await expect(digestStorefrontFiles([files[0]!, files[0]!])).rejects.toThrow(/^storefront_digest_path_invalid: path "assets\/app.js" is given twice/);
    await expect(digestStorefrontFiles([{ path: "a\ud800", bytes: new Uint8Array() }])).rejects.toThrow(/"a\\ud800"/);
    expect(await digestStorefrontFiles([{ path: "\u00e9/\ud83d\ude00.txt", bytes: new Uint8Array() }])).toMatch(/^sha256:/);
  });
});
