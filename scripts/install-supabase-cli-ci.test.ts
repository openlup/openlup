import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { env as processEnvironment } from "node:process";
import { describe, expect, it } from "vitest";

const source = readFileSync("scripts/install-supabase-cli-ci.sh", "utf8");
const pins = [
  ["Linux", "x86_64", "668850237", "59ed066847b98d7461c60e9109d40cab6b9756177ce06ebb05b51338519f5136"],
  ["Darwin", "arm64", "668849778", "fe87a5f9781d5423dbd5ebba2d5a6e1a541d01754d14941c574952e5695eaab0"],
];

function fixture(os = "Linux", arch = "x86_64", binaryVersion = "2.122.0") {
  const directory = mkdtempSync(join(tmpdir(), "native-cli-installer-"));
  const bin = join(directory, "bin"), payload = join(directory, "payload");
  mkdirSync(bin); mkdirSync(payload);
  const executed = join(directory, "executed");
  writeFileSync(join(payload, "supabase"), `#!/bin/sh\necho invoked > '${executed}'\nprintf '%s\\n' '${binaryVersion}'\n`, { mode: 0o755 });
  const archive = join(directory, "fixture.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", payload, "supabase"]);
  const sha = createHash("sha256").update(readFileSync(archive)).digest("hex");
  // Substitute only fixture archive hashes; exercise the actual downloader, SHA
  // comparison, extraction, version refusal, installation and cleanup code.
  const script = join(directory, "installer.sh");
  writeFileSync(script, pins.reduce((text, pin) => text.replace(pin[3]!, sha), source));
  const requests = join(directory, "requests");
  writeFileSync(join(bin, "uname"), `#!/bin/sh\ncase "$1" in -s) echo '${os}';; -m) echo '${arch}';; esac\n`, { mode: 0o755 });
  writeFileSync(join(bin, "curl"), `#!/bin/sh
printf '%s\\n' "$*" >> '${requests}'
proto=0; proto_redir=0; tls=0; previous=''
for arg do
  case "$previous:$arg" in
    --proto:=https) proto=1 ;;
    --proto-redir:=https) proto_redir=1 ;;
  esac
  [ "$arg" != '--tlsv1.2' ] || tls=1
  previous="$arg"
  out="$arg"
done
if [ "$proto:$proto_redir:$tls" != '1:1:1' ]; then
  echo 'curl requires --proto =https --proto-redir =https --tlsv1.2' >&2
  exit 1
fi
cp '${archive}' "$out"
`, { mode: 0o755 });
  const allocations = join(directory, "allocations");
  const mktemp = execFileSync("sh", ["-c", "command -v mktemp"], { encoding: "utf8" }).trim();
  writeFileSync(join(bin, "mktemp"), `#!/bin/sh\ncreated="$('${mktemp}' "$@")" || exit 1\nprintf '%s\\n' "$created" >> '${allocations}'\nprintf '%s\\n' "$created"\n`, { mode: 0o755 });
  const githubPath = join(directory, "github-path");
  const run = (version = "2.122.0", environment: NodeJS.ProcessEnv = {}) => spawnSync("bash", [script, version], {
    encoding: "utf8", env: { ...processEnvironment, PATH: `${bin}:${processEnvironment.PATH}`, RUNNER_TEMP: directory, GITHUB_PATH: githubPath, ...environment },
  });
  return { directory, archive, executed, requests, allocations, githubPath, run, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

describe("native CI CLI installer", () => {
  it.each(pins)("verifies and installs the pinned asset on %s/%s", (os, arch, asset) => {
    const f = fixture(os, arch);
    try {
      const result = f.run();
      expect(result.stderr).toBe(""); expect(result.status).toBe(0);
      expect(readFileSync(f.requests, "utf8")).toContain(`https://api.github.com/repos/supabase/cli/releases/assets/${asset}`);
      const installDir = result.stdout.trim();
      expect(isAbsolute(installDir)).toBe(true);
      expect(readFileSync(f.githubPath, "utf8")).toBe(`${installDir}\n`);
      expect(existsSync(f.executed)).toBe(true);
      expect(readFileSync(join(installDir, "supabase"))).toEqual(readFileSync(join(f.directory, "payload/supabase")));
      expect(readdirSync(installDir)).toEqual(["supabase"]);
    } finally { f.cleanup(); }
  });

  it.each([["Linux", "x86_64", "latest"], ["Linux", "aarch64", "2.122.0"], ["Windows", "x86_64", "2.122.0"]])("refuses unreviewed %s/%s version %s before downloading", (os, arch, version) => {
    const f = fixture(os, arch);
    try {
      const result = f.run(version);
      expect(result.status).toBe(2); expect(result.stderr).toContain("No reviewed Supabase CLI asset");
      expect(existsSync(f.requests)).toBe(false); expect(existsSync(f.allocations)).toBe(false);
    } finally { f.cleanup(); }
  });

  it.each(["RUNNER_TEMP", "TMPDIR", "system"])("allocates distinct fresh 0700 directories using %s", (temporarySource) => {
    const f = fixture();
    const installed: string[] = [];
    try {
      const fallbackRoot = join(f.directory, "fallback");
      mkdirSync(fallbackRoot);
      const environment = {
        RUNNER_TEMP: temporarySource === "RUNNER_TEMP" ? f.directory : undefined,
        TMPDIR: temporarySource === "system" ? undefined : fallbackRoot,
      };
      let temporaryDirectory = temporarySource === "RUNNER_TEMP" ? f.directory : fallbackRoot;
      if (temporarySource === "system") {
        const probe = execFileSync("mktemp", ["-d"], { encoding: "utf8", env: { ...processEnvironment, TMPDIR: undefined } }).trim();
        temporaryDirectory = dirname(realpathSync(probe));
        rmSync(probe, { recursive: true });
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = f.run("2.122.0", environment);
        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        const installDir = result.stdout.trim();
        installed.push(installDir);
        expect(result.stdout).toBe(`${installDir}\n`);
        expect(isAbsolute(installDir)).toBe(true);
        expect(dirname(installDir)).toBe(realpathSync(temporaryDirectory));
        expect(statSync(installDir).mode & 0o777).toBe(0o700);
        expect(readFileSync(join(installDir, "supabase"))).toEqual(readFileSync(join(f.directory, "payload/supabase")));
      }
      expect(installed[0]).not.toBe(installed[1]);
      expect(readFileSync(f.githubPath, "utf8")).toBe(`${installed.join("\n")}\n`);
      const allocations = readFileSync(f.allocations, "utf8").trim().split("\n").map((path) => realpathSync(path));
      expect(allocations).toEqual(installed);
    } finally {
      for (const path of installed) rmSync(path, { recursive: true, force: true });
      f.cleanup();
    }
  });

  it("prints the bin directory for local callers without GITHUB_PATH", () => {
    const f = fixture();
    try {
      const result = f.run("2.122.0", { GITHUB_PATH: undefined });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const installDir = result.stdout.trim();
      expect(result.stdout).toBe(`${installDir}\n`);
      expect(isAbsolute(installDir)).toBe(true);
      expect(existsSync(join(installDir, "supabase"))).toBe(true);
      expect(existsSync(f.githubPath)).toBe(false);
    } finally { f.cleanup(); }
  });

  it("refuses corrupt archives before extracting, executing or exposing a binary", () => {
    const f = fixture();
    try {
      writeFileSync(f.archive, "corrupt");
      const result = f.run();
      expect(result.status).toBe(1); expect(result.stderr).toContain("archive checksum mismatch");
      expect(existsSync(f.executed)).toBe(false); expect(existsSync(f.githubPath)).toBe(false);
      expect(result.stdout).toBe("");
      for (const path of readFileSync(f.allocations, "utf8").trim().split("\n")) expect(existsSync(path)).toBe(false);
    } finally { f.cleanup(); }
  });

  it("refuses an unexpected binary version before exposing the installation", () => {
    const f = fixture("Linux", "x86_64", "9.99.0");
    try {
      const result = f.run();
      expect(result.status).toBe(1); expect(result.stderr).toContain("CLI version mismatch");
      expect(result.stdout).toBe(""); expect(existsSync(f.githubPath)).toBe(false);
      for (const path of readFileSync(f.allocations, "utf8").trim().split("\n")) expect(existsSync(path)).toBe(false);
    } finally { f.cleanup(); }
  });

  it("requires an explicit version", () => {
    const result = spawnSync("bash", [resolve("scripts/install-supabase-cli-ci.sh")], { encoding: "utf8" });
    expect(result.status).toBe(2); expect(result.stderr).toContain("Usage:");
  });
});
