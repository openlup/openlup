import { existsSync, readFileSync } from "node:fs";
import { env as processEnvironment } from "node:process";
import { describe, expect, it, vi } from "vitest";
import { cliImages, cliPin, inspect, mirrorImage, mirrorImages, ownedImages, plannedImages, resolveImage, resolvePlan } from "./ci-image-mirror.mjs";
import { execFileSync } from "node:child_process";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

const digest = `sha256:${"a".repeat(64)}`;
const different = `sha256:${"b".repeat(64)}`;
const pin = "      - uses: supabase/setup-cli@45a513f8c64c0bc8e0e3dfe572b5c95be85f6359\n        with:\n          version: 2.98.2\n";
const services = ["supabase/postgres", "supabase/gotrue", "supabase/realtime", "supabase/storage-api"]
  .map((name) => ({ name, local: "1.2.3" }));
const binary = "public.ecr.aws supabase/pg_prove:3.36\0supabase/pg_prove:3.36\0";
const image = { repository: "library/postgres", tag: "16", digest, sources: ["docker.io/library/postgres", "public.ecr.aws/docker/library/postgres"] };
const resolved = { source: `docker.io/library/postgres@${digest}`, target: "ghcr.io/openlup/library/postgres:16", digest };
const pgtapSource = readFileSync("scripts/public-ci-pgtap.mjs", "utf8");
const batchSource = readFileSync("tests/postgres/reviewedBatchForwards.test.ts", "utf8");
const ownedConfig = () => JSON.parse(readFileSync("config/ci-images.json", "utf8"));

function assertReviewedBatchPins(config: ReturnType<typeof ownedConfig>, source = batchSource) {
  // Match only the exact literal declarations, without importing the Docker-backed test.
  // A declaration shape change refuses until this temporary PR-B bridge is updated.
  const literal = (pattern: RegExp) => {
    const matches = [...source.matchAll(pattern)];
    expect(matches, "expected exactly one reviewed-batch literal declaration").toHaveLength(1);
    return matches[0];
  };
  const managed = literal(/^const managedDigest = "(sha256:[a-f0-9]{64})";$/gmu)[1];
  const native = literal(/^const nativeDigest = "(sha256:[a-f0-9]{64})";$/gmu)[1];
  const sources = literal(/^const imageSources = \{\n {2}native: (\[[^\n]+\]),\n {2}managed: (\[[^\n]+\]),\n\};$/gmu);
  for (const [name, digest, orderedSources] of [
    ["test-postgres", native, JSON.parse(sources[1])],
    ["managed-batch-postgres", managed, JSON.parse(sources[2])],
  ]) {
    const entries = ownedImages(config).filter((image) => image.name === name);
    expect(entries, `exactly one JSON pin for ${name}`).toHaveLength(1);
    expect(entries[0].digest, `${name} digest drift`).toBe(digest);
    expect(entries[0].sources, `${name} ordered upstream sources drift`).toEqual(orderedSources);
  }
}

describe("CI image derivation and digest preservation", () => {
  it("guards reviewed-batch digest and ordered upstream literals against the JSON owner", () => {
    assertReviewedBatchPins(ownedConfig());
  });

  it.each(["test-postgres", "managed-batch-postgres"])("rejects digest and source-order drift for %s in memory", (name) => {
    const changedDigest = ownedConfig();
    changedDigest.images.find((image: { name: string }) => image.name === name).digest = different;
    expect(() => assertReviewedBatchPins(changedDigest)).toThrow("digest drift");
    const changedOrder = ownedConfig();
    changedOrder.images.find((image: { name: string }) => image.name === name).sources.reverse();
    expect(() => assertReviewedBatchPins(changedOrder)).toThrow("ordered upstream sources drift");
  });

  it("refuses missing or duplicate reviewed-batch declarations", () => {
    expect(() => assertReviewedBatchPins(ownedConfig(), batchSource.replace("const managedDigest =", "const renamedDigest ="))).toThrow("exactly one");
    expect(() => assertReviewedBatchPins(ownedConfig(), `${batchSource}\n${batchSource}`)).toThrow("exactly one");
  });

  it("reads exactly one literal CLI pin, including the actual pgTAP workflow", () => {
    expect(cliPin(pin)).toBe("2.98.2");
    expect(cliPin(readFileSync(".github/workflows/published-tree-ci.yml", "utf8"))).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(cliPin(pin.replace("- uses:", "- name: Setup\n        uses:"))).toBe("2.98.2");
    for (const invalid of ["", pin + pin, pin + pin.replace("- uses:", "- name: Setup\n        uses:"), pin.replace("version: 2.98.2", "version: latest"), pin.replace("version: 2.98.2", "version: 2.98.2\n          version: 2.98.2")]) {
      expect(() => cliPin(invalid)).toThrow("exactly one literal");
    }
  });

  it("derives only included bootstrap services plus the binary's unique pg_prove tag", () => {
    const derived = cliImages(services, binary, pgtapSource);
    expect(derived.map(({ repository, tag }) => `${repository}:${tag}`)).toEqual([
      "supabase/postgres:1.2.3", "supabase/pg_prove:3.36",
    ]);
    expect(derived).toEqual([{ repository: "supabase/postgres", tag: "1.2.3" }, { repository: "supabase/pg_prove", tag: "3.36" }]);
    for (const invalid of [services.slice(1), [...services, services[0]], [{ ...services[0], local: undefined }, ...services.slice(1)]]) {
      expect(() => cliImages(invalid, binary, pgtapSource)).toThrow("exactly one local");
    }
    for (const invalid of ["public.ecr.aws", binary + "supabase/pg_prove:4.0", binary.replace("public.ecr.aws", "other")]) {
      expect(() => cliImages(services, invalid, pgtapSource)).toThrow();
    }
  });

  it("derives exclusions from pgTAP without weakening service, registry or binary refusals", () => {
    expect(cliImages(services, binary, pgtapSource.replace('"gotrue,', '"'))[1].repository).toBe("supabase/gotrue");
    expect(() => cliImages(services.slice(0, -1), binary, pgtapSource)).toThrow("exactly one local");
    for (const invalid of ["", pgtapSource + pgtapSource, pgtapSource.replace('"gotrue,', '"postgres,gotrue,'),
      pgtapSource.replace('"gotrue,', '"gotrue,gotrue,'), pgtapSource.replace('"--exclude", excluded', '"--exclude", other')]) {
      expect(() => cliImages(services, binary, invalid)).toThrow("pgTAP exclusion list");
    }
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

  it("accepts only repository/tag pairs and constructs upstreams in the writer", () => {
    expect(plannedImages(JSON.stringify([{ repository: "supabase/postgres", tag: "17.1" }]))).toEqual([
      { repository: "supabase/postgres", tag: "17.1", sources: ["public.ecr.aws/supabase/postgres", "docker.io/supabase/postgres"] },
    ]);
    const lookup = vi.fn().mockImplementation((ref: string) => ref.includes("@") ? ref.split("@")[1] : digest);
    expect(resolvePlan(JSON.stringify([{ repository: "supabase/pg_prove", tag: "3.36" }]), ownedConfig(), lookup)).toHaveLength(4);
    expect(lookup.mock.calls[0]).toEqual(["public.ecr.aws/supabase/pg_prove:3.36"]);
  });

  it("refuses every malformed plan before any exec or registry call", () => {
    const valid = { repository: "supabase/postgres", tag: "17.1" };
    const inputs = [
      "not JSON", "null", "{}", JSON.stringify([null]), JSON.stringify([[]]),
      ...["supabase/unknown", "evil.io/supabase/postgres", "../supabase/postgres", "supabase/../postgres", "supabase/postgres/extra"]
        .map((repository) => JSON.stringify([{ ...valid, repository }])),
      ...["../17", "17/extra", "_17", "17:evil", "17@sha256:abc", "17; echo unsafe", "", "a".repeat(129), 17, null]
        .map((tag) => JSON.stringify([{ ...valid, tag }])),
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
