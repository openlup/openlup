import { readFileSync } from "node:fs";

import { assert, runRequired, runRequiredRaw, type CommandRunner } from "./core-extraction-command.ts";
import { candidateFilePath } from "./core-extraction-snapshot.ts";

function bytes(output: Buffer | string): Buffer {
  return Buffer.isBuffer(output) ? output : Buffer.from(output);
}

export function assertPackedCandidateContent(options: {
  candidateRoot: string;
  tarballPath: string;
  packFiles: string[];
  runner: CommandRunner;
  environment: NodeJS.ProcessEnv;
}): void {
  const expected = [...options.packFiles].sort();
  const packed = runRequired(
    "list packed candidate tarball",
    "tar",
    ["-tzf", options.tarballPath],
    options.candidateRoot,
    options.runner,
    options.environment,
  ).split(/\r?\n/).filter((entry) => entry && !entry.endsWith("/")).map((entry) => {
    assert(entry.startsWith("package/"), `packed tarball entry escapes package root: ${entry}`);
    const path = entry.slice("package/".length);
    candidateFilePath(options.candidateRoot, path);
    return path;
  }).sort();
  assert(JSON.stringify(packed) === JSON.stringify(expected), "packed tarball entries differ from npm pack manifest");
  for (const path of expected) {
    const candidate = readFileSync(candidateFilePath(options.candidateRoot, path));
    const archived = bytes(runRequiredRaw(
      `read packed candidate file ${path}`,
      "tar",
      ["-xOf", options.tarballPath, `package/${path}`],
      options.candidateRoot,
      options.runner,
      options.environment,
    ));
    assert(candidate.equals(archived), `packed tarball bytes differ from candidate file: ${path}`);
  }
}
