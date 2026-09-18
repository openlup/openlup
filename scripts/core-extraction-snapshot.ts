import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  assert,
  assertGitSha,
  runRequired,
  runRequiredRaw,
  sanitizedGitEnvironment,
  type CommandRunner,
} from "./core-extraction-command.ts";

export type SnapshotInput = {
  path: string;
  mode: string;
  content: Buffer | string;
};

export type CoreExtractionSnapshotManifest = {
  schemaVersion: 1;
  sourceSha: string;
  subtreeSha: string;
  packagePrefix: "packages/core/";
  files: Array<{ path: string; mode: string; sha256: string }>;
  digest: string;
};

const packagePrefix = "packages/core/" as const;

export function assertSafeCandidatePath(candidatePath: string): void {
  assert(candidatePath.length > 0, "candidate path must not be empty");
  assert(!isAbsolute(candidatePath), `candidate path must be relative: ${candidatePath}`);
  assert(
    !candidatePath.includes("\\"),
    `candidate path must use POSIX separators: ${candidatePath}`,
  );
  assert(
    [...candidatePath].every((character) => {
      const code = character.charCodeAt(0);
      return code > 31 && code !== 127;
    }),
    `candidate path contains control characters: ${candidatePath}`,
  );
  const segments = candidatePath.split("/");
  assert(
    segments.every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    `unsafe candidate path: ${candidatePath}`,
  );
}

export function candidateFilePath(candidateRoot: string, candidatePath: string): string {
  assertSafeCandidatePath(candidatePath);
  const absolutePath = resolve(candidateRoot, candidatePath);
  const fromRoot = relative(resolve(candidateRoot), absolutePath);
  assert(
    fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot),
    `candidate path escapes root: ${candidatePath}`,
  );
  return absolutePath;
}

function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function buildSnapshotManifest(options: {
  sourceSha: string;
  subtreeSha: string;
  files: SnapshotInput[];
}): CoreExtractionSnapshotManifest {
  const sourceSha = assertGitSha(options.sourceSha, "source snapshot");
  const subtreeSha = assertGitSha(options.subtreeSha, "subtree snapshot");
  const files = options.files
    .map((file) => {
      assertSafeCandidatePath(file.path);
      assert(
        file.mode === "100644" || file.mode === "100755",
        `unsupported tracked mode ${file.mode} for ${file.path}`,
      );
      return { path: file.path, mode: file.mode, sha256: sha256(file.content) };
    })
    .sort((left, right) => left.path.localeCompare(right.path, "en"));

  assert(files.length > 0, "snapshot manifest must contain tracked package files");
  const duplicate = files.find(
    (file, index) => index > 0 && file.path === files[index - 1]?.path,
  );
  assert(!duplicate, `snapshot manifest contains duplicate path: ${duplicate?.path}`);

  const canonical = JSON.stringify({
    schemaVersion: 1,
    sourceSha,
    subtreeSha,
    packagePrefix,
    files,
  });
  return {
    schemaVersion: 1,
    sourceSha,
    subtreeSha,
    packagePrefix,
    files,
    digest: `sha256:${sha256(canonical)}`,
  };
}

export function readCandidateSnapshotFiles(
  candidateRoot: string,
  runner: CommandRunner,
): SnapshotInput[] {
  const output = runRequired(
    "list candidate tree",
    "git",
    ["ls-tree", "-r", "-z", "--full-tree", "HEAD"],
    candidateRoot,
    runner,
  );
  return output
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const match = record.match(/^([0-9]{6}) (blob) ([0-9a-f]{40,64})\t([\s\S]+)$/);
      assert(match, `unexpected git tree entry: ${JSON.stringify(record)}`);
      const [, mode, , blobSha, path] = match;
      candidateFilePath(candidateRoot, path);
      assert(
        mode === "100644" || mode === "100755",
        `candidate must contain regular files only: ${path} (${mode})`,
      );
      return {
        path,
        mode,
        content: runRequiredRaw(
          `read candidate blob ${path}`,
          "git",
          ["cat-file", "blob", blobSha],
          candidateRoot,
          runner,
          sanitizedGitEnvironment(),
        ),
      };
    });
}
