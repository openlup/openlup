import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createReleaseBundleManifest,
  normalizeReleaseSbom,
} from "../scripts/release-bundle.ts";

const sourceTimestamp = "2026-07-15T00:00:00.000Z";

describe("release bundle", () => {
  it("binds immutable artifact digests to an exact source tree and version", () => {
    const tarballBytes = Buffer.from("candidate tarball");
    const sbomBytes = Buffer.from('{"bomFormat":"CycloneDX"}\n');
    const bundle = createReleaseBundleManifest({
      packageManifest: { name: "@openlup/core", version: "0.1.0-rc.1" },
      sourceCommit: "a".repeat(40),
      sourceTree: "b".repeat(40),
      tarballFilename: "openlup-core-0.1.0-rc.1.tgz",
      tarballBytes,
      tarballIntegrity: "sha512-example",
      sbomFilename: "openlup-core-0.1.0-rc.1.cdx.json",
      sbomBytes,
      npmVersion: "11.19.0",
    });

    expect(bundle).toMatchObject({
      schemaVersion: 1,
      package: { name: "@openlup/core", version: "0.1.0-rc.1" },
      source: { commit: "a".repeat(40), tree: "b".repeat(40) },
      artifacts: {
        tarball: { sha256: createHash("sha256").update(tarballBytes).digest("hex") },
        sbom: { sha256: createHash("sha256").update(sbomBytes).digest("hex"), format: "CycloneDX" },
      },
      toolchain: { node: process.version, npm: "11.19.0" },
    });
    expect(Object.keys(bundle.package)).toEqual(["name", "version"]);
  });

  it("canonicalizes the CycloneDX root name without hiding raw identity drift", () => {
    const sbom = {
      serialNumber: "urn:uuid:11111111-1111-4111-8111-111111111111",
      bomFormat: "CycloneDX",
      metadata: {
        timestamp: "2026-07-15T01:23:45.678Z",
        component: {
          "bom-ref": "@openlup/core@0.1.0-rc.1",
          name: "repository",
          purl: "pkg:npm/%40openlup/core@0.1.0-rc.1",
          type: "library",
          version: "0.1.0-rc.1",
        },
      },
      components: [{ name: "zod", version: "4.4.3" }],
    };

    const normalized = normalizeReleaseSbom(
      sbom,
      {
        name: "@openlup/core",
        version: "0.1.0-rc.1",
      },
      "repository",
      sourceTimestamp,
    );

    expect(normalized.metadata?.component).toMatchObject({
      "bom-ref": "@openlup/core@0.1.0-rc.1",
      name: "@openlup/core",
      purl: "pkg:npm/%40openlup/core@0.1.0-rc.1",
      type: "library",
      version: "0.1.0-rc.1",
    });
    expect(normalized.components).toEqual(sbom.components);
    expect(normalized.metadata?.timestamp).toBe(sourceTimestamp);
    expect(normalized).not.toHaveProperty("serialNumber");
    expect(sbom.metadata.component.name).toBe("repository");

    const alreadyCanonical = normalizeReleaseSbom(
      {
        ...sbom,
        metadata: {
          component: { ...sbom.metadata.component, name: "@openlup/core" },
        },
      },
      { name: "@openlup/core", version: "0.1.0-rc.1" },
      "repository",
      sourceTimestamp,
    );
    expect(alreadyCanonical.metadata?.component?.name).toBe("@openlup/core");
    expect(() =>
      normalizeReleaseSbom(
        sbom,
        { name: "@openlup/core", version: "0.1.0-rc.1" },
        "repository",
        "not-a-timestamp",
      ),
    ).toThrow("source timestamp must be canonical ISO-8601");
  });

  it("emits identical SBOM bytes when npm changes only volatile metadata", () => {
    const base = {
      bomFormat: "CycloneDX",
      metadata: {
        component: {
          "bom-ref": "@openlup/core@0.1.0-rc.1",
          name: "repository",
          purl: "pkg:npm/%40openlup/core@0.1.0-rc.1",
          version: "0.1.0-rc.1",
        },
      },
    };
    const normalize = (serialNumber: string, timestamp: string) =>
      normalizeReleaseSbom(
        { ...base, serialNumber, metadata: { ...base.metadata, timestamp } },
        { name: "@openlup/core", version: "0.1.0-rc.1" },
        "repository",
        sourceTimestamp,
      );

    expect(JSON.stringify(normalize("urn:uuid:first", "2026-07-15T01:00:00.000Z")))
      .toBe(JSON.stringify(normalize("urn:uuid:second", "2026-07-15T02:00:00.000Z")));
  });

  it.each([
    ["bom-ref", { "bom-ref": "@example/core@0.1.0-rc.1" }],
    ["purl", { purl: "pkg:npm/%40example/core@0.1.0-rc.1" }],
    ["version", { version: "0.2.0" }],
    ["name", { name: "other-package" }],
  ])("rejects a raw SBOM with a foreign root %s", (_field, componentPatch) => {
    expect(() =>
      normalizeReleaseSbom(
        {
          bomFormat: "CycloneDX",
          metadata: {
            component: {
              "bom-ref": "@openlup/core@0.1.0-rc.1",
              name: "repository",
              purl: "pkg:npm/%40openlup/core@0.1.0-rc.1",
              version: "0.1.0-rc.1",
              ...componentPatch,
            },
          },
        },
        { name: "@openlup/core", version: "0.1.0-rc.1" },
        "repository",
        sourceTimestamp,
      ),
    ).toThrow(/must match the release manifest|checkout directory/);
  });

});
