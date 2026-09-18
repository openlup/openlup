import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { defaultCommandRunner } from "./core-extraction-command.ts";
import { assertPackedCandidateContent } from "./core-extraction-package-content.ts";

describe("core packed candidate content", () => {
  it("binds every packed file byte-for-byte to the candidate", () => {
    const root = mkdtempSync(join(tmpdir(), "core-packed-content-"));
    const candidateRoot = join(root, "candidate");
    const packageRoot = join(root, "archive", "package");
    const files = ["package.json", "src/index.js"];
    mkdirSync(join(candidateRoot, "src"), { recursive: true });
    mkdirSync(join(packageRoot, "src"), { recursive: true });
    for (const [path, content] of [[files[0], "{\"name\":\"core\"}\n"], [files[1], "export const value = 1;\n"]]) {
      writeFileSync(join(candidateRoot, path), content);
      writeFileSync(join(packageRoot, path), content);
    }
    const tarballPath = join(root, "core.tgz");
    execFileSync("tar", ["-czf", tarballPath, "-C", join(root, "archive"), "package"]);
    const options = { candidateRoot, tarballPath, packFiles: files, runner: defaultCommandRunner, environment: process.env };
    try {
      expect(() => assertPackedCandidateContent(options)).not.toThrow();
      writeFileSync(join(candidateRoot, "src/index.js"), "export const value = 2;\n");
      expect(() => assertPackedCandidateContent(options))
        .toThrow("packed tarball bytes differ from candidate file: src/index.js");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
