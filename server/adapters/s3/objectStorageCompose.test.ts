import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cwd = fileURLToPath(new URL("../../../", import.meta.url));
const docker = spawnSync("which", ["docker"], { encoding: "utf8", timeout: 5_000 }).stdout?.trim() || "docker";
const env = {
  PUBLIC_REFERENCE_IMAGE: `sha256:${"0".repeat(64)}`,
  PUBLIC_REFERENCE_PORT: "18080",
};
const available = spawnSync(docker, ["compose", "version"], { env, timeout: 5_000 }).status === 0;

function config(storage: Record<string, string | undefined> = {}, profile = false) {
  return JSON.parse(execFileSync(docker, [
    "compose", ...(profile ? ["--profile", "local-storage"] : []), "config", "--format", "json",
  ], { cwd, env: { ...env, ...storage }, encoding: "utf8", timeout: 5_000 })) as {
    services: Record<string, { command: string[]; ports: Array<{ host_ip: string; published: string }> }>;
  };
}

describe.skipIf(!available)("object storage Compose interpolation", () => {
  it("configures the public reference without any storage settings or profile", () => {
    expect(Object.keys(config().services)).toEqual(["public-reference"]);
  });

  it.each([
    {}, { OBJECT_STORAGE_ACCESS_KEY: "", OBJECT_STORAGE_SECRET_KEY: "" },
    { OBJECT_STORAGE_ACCESS_KEY: "testaccess" }, { OBJECT_STORAGE_SECRET_KEY: "testsecret" },
  ])("keeps startup refusal options for missing credentials: %j", (storage) => {
    const command = config(storage, true).services["object-storage"]!.command;
    if (!storage.OBJECT_STORAGE_ACCESS_KEY) expect(command).toContain("--object-storage-access-key-required");
    if (!storage.OBJECT_STORAGE_SECRET_KEY) expect(command).toContain("--object-storage-secret-key-required");
  });

  it("passes configured credentials as gateway options and binds only loopback", () => {
    const service = config({
      OBJECT_STORAGE_ACCESS_KEY: "testaccess", OBJECT_STORAGE_SECRET_KEY: "testsecret", OBJECT_STORAGE_PORT: "17070",
    }, true).services["object-storage"]!;
    expect(service.command).toEqual(["--access=testaccess", "--secret=testsecret", "posix", "/data"]);
    expect(service.ports).toEqual([expect.objectContaining({ host_ip: "127.0.0.1", published: "17070" })]);
  });

  it("publishes an ephemeral loopback port when none is configured", () => {
    const [port] = config({ OBJECT_STORAGE_ACCESS_KEY: "testaccess", OBJECT_STORAGE_SECRET_KEY: "testsecret" }, true)
      .services["object-storage"]!.ports;
    expect(port).toMatchObject({ host_ip: "127.0.0.1" });
    expect(port!.published ?? "").toBe("");
  });
});
