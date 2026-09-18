import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFilesystemBlobStorage } from "./blobStorage.js";
import { runBlobPortContract } from "../blobPortContract.testFixtures.js";

describe("filesystem blob storage", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "blob-fs-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // The credential-free adapter: runs the full shared port contract for real in CI.
  runBlobPortContract("filesystem", () =>
    createFilesystemBlobStorage({ root, baseUrl: "https://files.example.com" }),
  );

  it("urlFor joins base url and normalized key", () => {
    const blob = createFilesystemBlobStorage({ root, baseUrl: "https://files.example.com/" });
    expect(blob.urlFor("/pet/abc.png")).toBe("https://files.example.com/pet/abc.png");
  });

  it("rejects keys that escape the root", async () => {
    const blob = createFilesystemBlobStorage({ root, baseUrl: "https://files.example.com" });
    await expect(blob.upload("../escape.png", Buffer.from("x"))).rejects.toThrow(
      /key_escapes_root/,
    );
  });

  it("delete tolerates a missing object and accepts full urls", async () => {
    const blob = createFilesystemBlobStorage({ root, baseUrl: "https://files.example.com" });
    await blob.upload("pet/keep.png", Buffer.from("data"));
    await blob.delete("https://files.example.com/pet/keep.png");
    expect(await blob.exists("pet/keep.png")).toBe(false);
    await expect(blob.delete("pet/already-gone.png")).resolves.toBeUndefined();
  });
});
