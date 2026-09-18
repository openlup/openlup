// Every `docker rm` in a tracked shell script under `scripts/` must carry `-v`.
//
// The local proof and parity scripts start a `postgres:16` container. That image
// declares `VOLUME /var/lib/postgresql/data`, so every start mints an anonymous
// volume, and `docker rm -f "$container"` removes the container while leaving the
// volume behind. `docker run --rm` does not rescue it: the force-remove wins the
// race against the daemon's auto-remove, and the volume is orphaned either way.
// Measured on 2026-09-09: 1571 idle anonymous volumes, 99.9 GB, about 160 a day.
//
// `-v` removes only anonymous volumes; named volumes are never touched, so the
// flag is always safe to carry and the rule needs no allow-list.
//
// The scan is measured on its own failure modes below: a fixture that must go
// red, the flag spellings that must stay green, and a floor on how many real
// invocations the repository scan actually saw, so a regex that matches nothing
// cannot pass this file.
//
// The repository is read through `git grep` and `git ls-files` rather than the
// filesystem: only tracked scripts count, and the file opens no path it computed,
// so it stays out of the opaque-dependency-edge registry.

import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const SHELL_SCRIPTS = "scripts/*.sh";

/** `docker rm` or `docker container rm`, followed by its option words. */
const DOCKER_RM = /\bdocker\s+(?:container\s+)?rm\b((?:\s+--?[A-Za-z][\w-]*(?:=\S*)?)*)/g;

export type Invocation = { line: number; text: string; volumes: boolean };

/** Whether one option cluster (`-fv`, `--volumes`, `-v`) carries the volume flag. */
function carriesVolumeFlag(option: string): boolean {
  if (option === "--volumes") return true;
  if (option.startsWith("--")) return false;
  return option.slice(1).includes("v");
}

/** Every `docker rm` invocation in a shell source, with whether it removes volumes. */
export function dockerRmInvocations(source: string, firstLine = 1): Invocation[] {
  const found: Invocation[] = [];
  source.split(/\r?\n/).forEach((raw, index) => {
    if (raw.trimStart().startsWith("#")) return;
    for (const match of raw.matchAll(DOCKER_RM)) {
      const options = match[1].trim().split(/\s+/).filter(Boolean);
      found.push({ line: firstLine + index, text: raw.trim(), volumes: options.some(carriesVolumeFlag) });
    }
  });
  return found;
}

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
}

function trackedShellScripts(): string[] {
  return git(["ls-files", "-z", "--", SHELL_SCRIPTS]).split("\0").filter(Boolean).sort();
}

/** Every tracked line under `scripts/*.sh` that mentions docker, as `path:line:text`. */
function trackedDockerLines(): Array<{ path: string; line: number; text: string }> {
  let output = "";
  try {
    output = git(["grep", "-n", "-I", "-e", "docker", "--", SHELL_SCRIPTS]);
  } catch (error) {
    // `git grep` exits 1 when nothing matches; that is an empty scan, which the
    // floor assertion below turns into a failure rather than a pass.
    if ((error as { status?: number }).status !== 1) throw error;
  }
  return output.split("\n").filter(Boolean).map((row) => {
    const match = /^([^:]+):(\d+):(.*)$/.exec(row);
    if (!match) throw new Error(`unparseable git grep row: ${row}`);
    return { path: match[1], line: Number(match[2]), text: match[3] };
  });
}

describe("docker rm carries -v in every tracked shell script under scripts/", () => {
  it("flags a force-remove that leaves the anonymous volume behind", () => {
    const fixture = [
      "#!/usr/bin/env bash",
      "cleanup() { docker rm -f \"$container\" >/dev/null 2>&1 || true; }",
      "trap 'docker rm --force \"$container\" >/dev/null' EXIT",
      "docker rm \"$container\"",
      "docker container rm -f \"$container\"",
    ].join("\n");
    const leaking = dockerRmInvocations(fixture).filter((invocation) => !invocation.volumes);
    expect(leaking.map((invocation) => invocation.line)).toEqual([2, 3, 4, 5]);
  });

  it("accepts every spelling that removes the volume, and ignores comments and `docker run --rm`", () => {
    const fixture = [
      "# docker rm -f \"$container\" is documented here only",
      "docker run --detach --rm --name \"$container\" postgres:16",
      "docker rm -f -v \"$container\" >/dev/null",
      "docker rm -fv \"$container\"",
      "docker rm -vf \"$container\"",
      "docker rm -v -f \"$container\"",
      "docker rm --volumes --force \"$container\"",
      "trap 'docker rm -f -v \"$container\" >/dev/null' EXIT",
    ].join("\n");
    const invocations = dockerRmInvocations(fixture);
    expect(invocations).toHaveLength(6);
    expect(invocations.every((invocation) => invocation.volumes)).toBe(true);
  });

  it("finds no tracked shell script under scripts/ removing a container without -v", () => {
    expect(trackedShellScripts().length).toBeGreaterThan(20);

    const seen: string[] = [];
    const leaking: string[] = [];
    for (const { path, line, text } of trackedDockerLines()) {
      for (const invocation of dockerRmInvocations(text, line)) {
        seen.push(`${path}:${invocation.line}`);
        if (!invocation.volumes) leaking.push(`${path}:${invocation.line}: ${invocation.text}`);
      }
    }

    // Not vacuous: the repository really does remove containers from shell, so a
    // scan that saw none of those invocations is a broken scan, not a clean tree.
    expect(seen.length).toBeGreaterThanOrEqual(13);
    expect(
      leaking,
      "these `docker rm` calls orphan the container's anonymous volume; add `-v` (`docker rm -f -v ...`)",
    ).toEqual([]);
  });
});
