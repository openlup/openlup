import { afterEach, describe, expect, it, vi } from "vitest";
import { blobFacade, setBlobFacadePort } from "./blob.facade.js";
import type { VercelBlobStorage } from "../../adapters/vercel/blobStorage.js";

function fakePort(): VercelBlobStorage & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    urlFor: (key) => {
      calls.push(`urlFor:${key}`);
      return `https://cdn/${key}`;
    },
    upload: (key) => {
      calls.push(`upload:${key}`);
      return Promise.resolve({ url: `https://cdn/${key}`, pathname: key });
    },
    exists: (key) => {
      calls.push(`exists:${key}`);
      return Promise.resolve(true);
    },
    delete: (k) => {
      calls.push(`delete:${k}`);
      return Promise.resolve();
    },
    list: (prefix) => {
      calls.push(`list:${prefix}`);
      return Promise.resolve({ keys: [] });
    },
    listDetailed: (prefix) => {
      calls.push(`listDetailed:${prefix}`);
      return Promise.resolve({ blobs: [] });
    },
  };
}

describe("blobFacade", () => {
  afterEach(() => setBlobFacadePort(null));

  it("pathFor applies the pet-personalizer prefix and .png suffix", () => {
    expect(blobFacade.pathFor("abc")).toBe("pet-personalizer/abc.png");
  });

  it("delegates urlFor/exists/upload to the bound port with the prefixed key", async () => {
    const port = fakePort();
    setBlobFacadePort(port);
    expect(blobFacade.urlFor("abc")).toBe("https://cdn/pet-personalizer/abc.png");
    expect(await blobFacade.exists("abc")).toBe(true);
    await blobFacade.upload("abc", Buffer.from("png"));
    expect(port.calls).toContain("upload:pet-personalizer/abc.png");
    expect(port.calls).toContain("exists:pet-personalizer/abc.png");
  });

  it("list and listDetailed scope to the pet-personalizer prefix", async () => {
    const port = fakePort();
    setBlobFacadePort(port);
    await blobFacade.list();
    await blobFacade.listDetailed();
    expect(port.calls).toContain("list:pet-personalizer/");
    expect(port.calls).toContain("listDetailed:pet-personalizer/");
  });

  it("delete passes the url straight through", async () => {
    const port = fakePort();
    setBlobFacadePort(port);
    await blobFacade.delete("https://cdn/pet-personalizer/abc.png");
    expect(port.calls).toContain("delete:https://cdn/pet-personalizer/abc.png");
  });
});
