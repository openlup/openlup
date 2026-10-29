import type { OwnedCiImage } from "./ci-image-mirror.mjs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { arch, platform, env as processEnvironment } from "node:process";
import { describe, expect, it, vi } from "vitest";
import { cliImages, cliPin, deriveCliImages, inspect, mirrorImage, mirrorImages, ownedImages, pinnedCliImages, plannedImages, resolveImage, resolvePlan } from "./ci-image-mirror.mjs";
import { execFileSync } from "node:child_process";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

const digest = `sha256:${"a".repeat(64)}`;
const different = `sha256:${"b".repeat(64)}`;
const pin = "      - uses: supabase/setup-cli@45a513f8c64c0bc8e0e3dfe572b5c95be85f6359\n        with:\n          version: 2.122.0\n";
const services = ["supabase/postgres", "supabase/gotrue", "supabase/realtime", "supabase/storage-api"]
  .map((name) => ({ name, local: "1.2.3" }));
const binary = "public.ecr.aws supabase/pg_prove:3.36\0supabase/pg_prove:3.36\0";
const image = { repository: "library/postgres", tag: "16", digest, sources: ["docker.io/library/postgres", "public.ecr.aws/docker/library/postgres"] };
const resolved = { source: `docker.io/library/postgres@${digest}`, target: "ghcr.io/openlup/library/postgres:16", digest };
const pgtapSource = readFileSync("scripts/public-ci-pgtap.mjs", "utf8");
const batchSource = readFileSync("tests/postgres/reviewedBatchForwards.test.ts", "utf8");
const actualConfig = () => JSON.parse(readFileSync("config/ci-images.json", "utf8")) as { images: OwnedCiImage[]; cliImages: OwnedCiImage[] };
const ownedConfig = (images = cliImages(services, binary, pgtapSource)) => ({
  images: actualConfig().images,
  cliImages: images.map(image => ({ ...image, name: `cli-${image.repository.split("/").at(-1)!.replaceAll("_", "-")}`, digest, sources: [`public.ecr.aws/${image.repository}`, `docker.io/${image.repository}`] })),
});

function assertSingleOwner(source: string) {
  expect(source).not.toMatch(/sha256:[a-f0-9]{64}/u);
  expect(source).not.toMatch(/\[[^\]\n]*["'`](?:ghcr\.io|docker\.io|public\.ecr\.aws)\//u);
}

describe("CI image derivation and digest preservation", () => {
  it.each(["native", "npm", "npm-override", "npm-relative-override", "npm-path-override", "npm-path-space-override", ...(platform === "win32" ? [] : ["npm-path-backslash-override"]), "npm-path-missing", "npm-missing", "npm-registry-drift"])("inspects the executed binary for a %s installation", async (installation) => {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const which = actual.execFileSync("which", ["which"], { encoding: "utf8" }).trim();
    const directory = mkdtempSync(join(tmpdir(), "cli-install-layout-"));
    const executable = join(directory, "supabase");
    const native = join(directory, "native");
    const overrideName = `${basename(directory)}${installation === "npm-path-backslash-override" ? "\\override" : "-override"}${installation === "npm-path-space-override" ? " " : ""}`;
    const cwdOverride = join(process.cwd(), overrideName);
    vi.stubEnv("SUPABASE_CLI_BINARY_OVERRIDE", "");
    try {
      writeFileSync(native, binary);
      if (installation === "native") symlinkSync(native, executable);
      else {
        const launcher = join(directory, "node_modules/supabase/dist/supabase.js");
        mkdirSync(join(directory, "node_modules/supabase/dist"), { recursive: true });
        // setup-cli v3 exposes this symlinked Node launcher, not the ELF/Mach-O binary.
        writeFileSync(launcher, '#!/usr/bin/env node\nimport { spawn } from "node:child_process";\n');
        symlinkSync(launcher, executable);
        if (installation === "npm-override") vi.stubEnv("SUPABASE_CLI_BINARY_OVERRIDE", native);
        else if (installation === "npm-relative-override") vi.stubEnv("SUPABASE_CLI_BINARY_OVERRIDE", relative(process.cwd(), native));
        else if (installation === "npm-path-override" || installation === "npm-path-space-override" || installation === "npm-path-backslash-override" || installation === "npm-path-missing") {
          // A valid but different cwd binary must never win over the launcher's PATH lookup.
          writeFileSync(cwdOverride, binary.replaceAll("3.36", "9.99"), { mode: 0o755 });
          if (installation !== "npm-path-missing") writeFileSync(join(directory, overrideName), binary, { mode: 0o755 });
          vi.stubEnv("PATH", directory);
          vi.stubEnv("SUPABASE_CLI_BINARY_OVERRIDE", overrideName);
        }
        else if (installation !== "npm-missing") {
          const packageDirectory = join(directory, `node_modules/@supabase/cli-${platform}-${arch}`);
          mkdirSync(join(packageDirectory, "bin"), { recursive: true });
          writeFileSync(join(packageDirectory, "package.json"), '{}');
          writeFileSync(join(packageDirectory, "bin/supabase"), installation === "npm-registry-drift" ? binary.replace("public.ecr.aws", "other") : binary);
        }
      }
      vi.mocked(execFileSync).mockImplementation((file, args) => {
        if (file === "which") return args?.[0] === "supabase" ? executable : actual.execFileSync(which, args, { encoding: "utf8" });
        if (args?.[0] === "services") return JSON.stringify(services);
        throw new Error(`unexpected command: ${file}`);
      });
      if (installation === "npm-missing") expect(() => deriveCliImages(process.cwd(), directory)).toThrow("Cannot find module");
      else if (installation === "npm-path-missing") expect(() => deriveCliImages(process.cwd(), directory)).toThrow(`SUPABASE_CLI_BINARY_OVERRIDE not found on PATH: ${overrideName}`);
      else if (installation === "npm-registry-drift") expect(() => deriveCliImages(process.cwd(), directory)).toThrow("upstream registry changed");
      else expect(deriveCliImages(process.cwd(), directory)).toEqual(cliImages(services, binary, pgtapSource));
    } finally {
      vi.unstubAllEnvs();
      vi.mocked(execFileSync).mockReset();
      rmSync(cwdOverride, { force: true });
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps reviewed-batch pins and source lists in the JSON reader only", () => {
    assertSingleOwner(batchSource);
    expect(batchSource).toContain('readCiImage("test-postgres")');
    expect(batchSource).toContain('readCiImage("managed-batch-postgres")');
    expect(() => assertSingleOwner(`${batchSource}\nconst digest = "${digest}";`)).toThrow();
    expect(() => assertSingleOwner(`${batchSource}\nconst sources = ["docker.io/library/postgres"];`)).toThrow();
  });

  it("reads exactly one literal CLI pin, including the actual pgTAP workflow", () => {
    expect(cliPin(pin)).toBe("2.122.0");
    expect(cliPin(readFileSync(".github/workflows/published-tree-ci.yml", "utf8"))).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(cliPin(pin.replace("- uses:", "- name: Setup\n        uses:"))).toBe("2.122.0");
    for (const invalid of ["", pin + pin, pin + pin.replace("- uses:", "- name: Setup\n        uses:"), pin.replace("version: 2.122.0", "version: latest"), pin.replace("version: 2.122.0", "version: 2.122.0\n          version: 2.122.0")]) {
      expect(() => cliPin(invalid)).toThrow("exactly one literal");
    }
  });

  it("retains every schema-init image despite service exclusions, plus the binary pg_prove tag", () => {
    const derived = cliImages(services, binary, pgtapSource);
    expect(derived.map(({ repository, tag }) => `${repository}:${tag}`)).toEqual([
      "supabase/postgres:1.2.3", "supabase/gotrue:1.2.3", "supabase/realtime:1.2.3", "supabase/storage-api:1.2.3", "supabase/pg_prove:3.36",
    ]);
    expect(derived).toEqual([...services.map(({ name, local }) => ({ repository: name, tag: local })), { repository: "supabase/pg_prove", tag: "3.36" }]);
    for (const invalid of [services.slice(1), [...services, services[0]], [{ ...services[0], local: undefined }, ...services.slice(1)]]) {
      expect(() => cliImages(invalid, binary, pgtapSource)).toThrow("exactly one local");
    }
    for (const invalid of ["public.ecr.aws", binary + "supabase/pg_prove:4.0", binary.replace("public.ecr.aws", "other")]) {
      expect(() => cliImages(services, invalid, pgtapSource)).toThrow();
    }
  });

  it("derives exclusions from pgTAP without weakening service, registry or binary refusals", () => {
    expect(cliImages(services, binary, pgtapSource.replace('"gotrue,', '"'))).toEqual(cliImages(services, binary, pgtapSource));
    const runtime = { name: "postgrest/postgrest", local: "v14.10" };
    expect(cliImages([...services, runtime], binary, pgtapSource)).toHaveLength(5);
    for (const name of ["postgrest", "kong", "mailpit", "imgproxy", "vector"]) {
      expect(() => cliImages([...services, runtime], binary, pgtapSource.replace(`${name},`, ""))).toThrow("uncovered runtime image");
    }
    expect(() => cliImages(services.slice(0, -1), binary, pgtapSource)).toThrow("exactly one local");
    for (const invalid of ["", pgtapSource + pgtapSource, pgtapSource.replace('"gotrue,', '"postgres,gotrue,'),
      pgtapSource.replace('"gotrue,', '"gotrue,gotrue,'), pgtapSource.replace('"--exclude", excluded', '"--exclude", other')]) {
      expect(() => cliImages(services, binary, invalid)).toThrow("pgTAP exclusion list");
    }
  });

  it("binds every derived CLI image to its digest and keeps writer sources upstream-only", () => {
    const config = actualConfig();
    const derived = config.cliImages.map(({ repository, tag }) => ({ repository, tag }));
    const pinned = pinnedCliImages(derived, config);
    expect(pinned.map(image => image.digest)).toEqual(config.cliImages.map(image => image.digest));
    expect(pinned.map(image => image.sources)).toEqual(config.cliImages.map(image => image.sources));
    expect(pinned.every(image => image.sources.every(source => !source.startsWith("ghcr.io/openlup/")))).toBe(true);
    for (const invalid of [derived.slice(1), [...derived, derived[0]], [derived[0], ...derived.slice(0, -1)], [{ ...derived[0], tag: "moved" }, ...derived.slice(1)]]) {
      expect(() => pinnedCliImages(invalid, config)).toThrow();
    }
    for (const pins of [undefined, config.cliImages.slice(1), [config.cliImages[0], ...config.cliImages.slice(0, -1)],
      [{ ...config.cliImages[0], digest: "invalid" }, ...config.cliImages.slice(1)],
      [{ ...config.cliImages[0], sources: ["evil.test/supabase/postgres"] }, ...config.cliImages.slice(1)]]) {
      expect(() => pinnedCliImages(derived, { cliImages: pins })).toThrow();
    }
    const inspectPin = vi.fn().mockImplementation((ref: string) => ref.split("@")[1]);
    resolvePlan(JSON.stringify(derived), config, inspectPin);
    expect(inspectPin.mock.calls.slice(0, 5).map(([ref]) => ref)).toEqual(pinned.map(image => `${image.sources[0]}:${image.tag}@${image.digest}`));
  });

  it("validates the owned pins and refuses duplicates, mutable or unsafe refs", () => {
    const config = JSON.parse(readFileSync("config/ci-images.json", "utf8"));
    expect(ownedImages(config).map(({ name }) => name)).toEqual(["install-proof-postgres", "test-postgres", "managed-batch-postgres"]);
    for (const images of [[config.images[0], config.images[0]], [{ ...config.images[0], digest: "TODO" }],
      [{ ...config.images[0], sources: ["evil.test/library/postgres"] }], [{ ...config.images[0], tag: "16; echo unsafe" }]]) {
      expect(() => ownedImages({ images })).toThrow("invalid or duplicate");
    }
    for (const source of ["ghcr.io/library/postgres:16", "ghcr.io/library/postgres:17:extra", "ghcr.io/other/postgres:17"]) {
      expect(() => ownedImages({ images: [{ ...config.images[0], sources: [source] }] })).toThrow("invalid or duplicate");
    }
  });

  it("accepts exactly the five derived repositories and constructs upstreams in the writer", () => {
    const derived = cliImages(services, binary, pgtapSource);
    expect(plannedImages(JSON.stringify(derived)).map(({ repository }) => repository)).toEqual(derived.map(({ repository }) => repository));
    expect(() => plannedImages(JSON.stringify([...derived, { repository: "supabase/migra", tag: "3.0" }]))).toThrow("invalid CLI image plan");
    expect(plannedImages(JSON.stringify([{ repository: "supabase/postgres", tag: "17.1" }]))).toEqual([
      { repository: "supabase/postgres", tag: "17.1", sources: ["public.ecr.aws/supabase/postgres", "docker.io/supabase/postgres"] },
    ]);
    const lookup = vi.fn().mockImplementation((ref: string) => ref.includes("@") ? ref.split("@")[1] : digest);
    expect(resolvePlan(JSON.stringify([{ repository: "supabase/pg_prove", tag: "3.36" }]), ownedConfig([{ repository: "supabase/pg_prove", tag: "3.36" }]), lookup)).toHaveLength(4);
    expect(lookup.mock.calls[0]).toEqual([`public.ecr.aws/supabase/pg_prove:3.36@${digest}`]);
  });

  it("refuses every malformed plan before any exec or registry call", () => {
    const valid = { repository: "supabase/postgres", tag: "17.1" };
    const inputs = [
      "not JSON", "null", "{}", JSON.stringify([null]), JSON.stringify([[]]),
      ...["supabase/unknown", "supabase/migra", "supabase/postgres-meta", "supabase/studio", "supabase/edge-runtime", "evil.io/supabase/postgres", "../supabase/postgres", "supabase/../postgres", "supabase/postgres/extra"]
        .map((repository) => JSON.stringify([{ ...valid, repository }])),
      ...["supabase/postgres", "supabase/gotrue", "supabase/realtime", "supabase/storage-api", "supabase/pg_prove"].flatMap(repository =>
        ["../17", "17/extra", "_17", "17:evil", "17@sha256:abc", "17; echo unsafe", "", "a".repeat(129), 17, null]
          .map(tag => JSON.stringify([{ repository, tag }]))),
      ...["registry", "target", "digest", "sources"].map((field) => JSON.stringify([{ ...valid, [field]: "evil" }])),
      JSON.stringify([valid, valid]), JSON.stringify([valid, { repository: "supabase/pg_prove", tag: "3.36" }, valid]),
    ];
    const exec = vi.mocked(execFileSync).mockClear();
    const lookup = vi.fn();
    for (const input of inputs) expect(() => resolvePlan(input, ownedConfig(), lookup), input).toThrow();
    expect(lookup).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it("refuses missing, empty or mistyped owned fields before any exec or registry call", () => {
    const exec = vi.mocked(execFileSync).mockClear();
    const lookup = vi.fn();
    for (const field of ["name", "repository", "tag", "digest", "sources"]) {
      for (const value of [undefined, null, "", 17, {}, []]) {
        const changed = { ...ownedConfig().images[0], [field]: value };
        if (value === undefined) delete changed[field];
        expect(() => resolvePlan("[]", { images: [changed] }, lookup), `${field}: ${String(value)}`).toThrow("invalid or duplicate");
      }
    }
    expect(lookup).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it.each([false, true])("uses stdin login and removes temporary credentials after login failure=%s", (fail) => {
    vi.stubEnv("GHCR_TOKEN", "test-token");
    vi.stubEnv("GHCR_ACTOR", "test-actor");
    vi.stubEnv("DOCKER_CONFIG", "/previous-config");
    let directory = "";
    const exec = vi.mocked(execFileSync).mockReset().mockImplementation((_file, _args, options) => {
      directory = processEnvironment.DOCKER_CONFIG!;
      expect(existsSync(directory)).toBe(true);
      expect(directory).not.toBe("/previous-config");
      expect(options).toMatchObject({ input: "test-token", stdio: ["pipe", "pipe", "pipe"] });
      if (fail) throw new Error("login failed");
      return "";
    });
    try {
      if (fail) expect(() => mirrorImages([])).toThrow("login failed");
      else mirrorImages([]);
      expect(exec).toHaveBeenCalledExactlyOnceWith("docker", ["login", "ghcr.io", "--username", "test-actor", "--password-stdin"], expect.any(Object));
      expect(existsSync(directory)).toBe(false);
      expect(processEnvironment.DOCKER_CONFIG).toBe("/previous-config");
    } finally { vi.unstubAllEnvs(); }
  });

  it("resolves by pinned digest with ordered fallback and never accepts mismatch", () => {
    const lookup = vi.fn().mockImplementationOnce(() => { throw new Error("rate limited"); }).mockReturnValue(digest);
    expect(resolveImage(image, lookup)).toEqual({ ...resolved, source: `public.ecr.aws/docker/library/postgres@${digest}` });
    expect(lookup.mock.calls.map(([ref]) => ref)).toEqual(image.sources.map((source) => `${source}:16@${digest}`));
    expect(() => resolveImage(image, () => different)).toThrow("source digest mismatch");
    expect(() => resolveImage(image, () => null)).toThrow("no verified upstream");
    expect(resolveImage({ ...image, digest: undefined }, () => digest)).toEqual(resolved);
  });

  it("preserves the managed GHCR source tag without appending a second tag", () => {
    const managed = ownedImages(ownedConfig()).find(({ name }) => name === "managed-batch-postgres");
    const lookup = vi.fn().mockReturnValue(managed.digest);
    expect(resolveImage(managed, lookup).source).toBe(`${managed.sources[0]}@${managed.digest}`);
    expect(lookup).toHaveBeenCalledExactlyOnceWith(`${managed.sources[0]}@${managed.digest}`);
  });

  it("skips identical targets, refuses conflicts and never copies after inspect failure", () => {
    const copy = vi.fn();
    expect(mirrorImage(resolved, () => digest, copy)).toBe("skipped");
    expect(() => mirrorImage(resolved, () => different, copy)).toThrow("refuse to overwrite");
    expect(() => mirrorImage(resolved, () => { throw new Error("401 unauthorized"); }, copy)).toThrow("401");
    expect(copy).not.toHaveBeenCalled();
  });

  it("copies the complete source by digest then verifies the target tag", () => {
    const lookup = vi.fn().mockReturnValueOnce(null).mockReturnValueOnce(digest);
    const copy = vi.fn();
    expect(mirrorImage(resolved, lookup, copy)).toBe("copied and verified");
    expect(copy).toHaveBeenCalledExactlyOnceWith(resolved.source, resolved.target);
    expect(lookup.mock.calls).toEqual([[resolved.target], [resolved.target]]);
    expect(() => mirrorImage(resolved, vi.fn().mockReturnValueOnce(null).mockReturnValueOnce(different), copy)).toThrow("post-copy digest verification failed");
    expect(() => mirrorImage(resolved, () => null, copy)).toThrow("post-copy digest verification failed");
  });

  it("treats only explicit missing manifests as absence", () => {
    const exec = vi.mocked(execFileSync);
    for (const stderr of ["ERROR: manifest unknown", "ERROR: ghcr.io/openlup/library/postgres:16: not found"]) {
      exec.mockImplementationOnce(() => { throw Object.assign(new Error("inspect"), { stderr }); });
      expect(inspect(resolved.target)).toBeNull();
    }
    for (const stderr of ["401 unauthorized", "429 Too Many Requests", "DNS failure", "repository does not exist or may require authorization"]) {
      exec.mockImplementationOnce(() => { throw Object.assign(new Error("inspect failed"), { stderr }); });
      expect(() => inspect(resolved.target)).toThrow("inspect failed");
    }
    exec.mockReturnValueOnce('{"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[]}');
    expect(inspect(resolved.target)).toMatch(/^sha256:[a-f0-9]{64}$/u);
    exec.mockReturnValueOnce("not a manifest");
    expect(() => inspect(resolved.target)).toThrow();
  });

  it("uses a single carbon copy without platform filtering or format conversion", () => {
    const raw = '{"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[]}';
    const exec = vi.mocked(execFileSync).mockReset().mockReturnValueOnce(raw);
    const actual = inspect(resolved.target);
    exec.mockReturnValueOnce("");
    expect(mirrorImage({ ...resolved, digest: actual }, vi.fn().mockReturnValueOnce(null).mockReturnValueOnce(actual))).toBe("copied and verified");
    expect(exec.mock.calls[1]?.slice(0, 2)).toEqual(["docker", ["buildx", "imagetools", "create", "--prefer-index=false", "--tag", resolved.target, resolved.source]]);
  });
});
