import { beforeEach, describe, expect, it, vi } from "vitest";

import { requestBff } from "@/lib/bff/client";

import { COMMERCE_CONTRACT_VERSION } from "../commerce/types";
import {
  createBundleDraftResponseSchema,
  setBundleCompositionResponseSchema,
  setBundleTargetPriceResponseSchema,
} from "./adminBundleContracts";
import { activateBundleResponseSchema } from "./adminBundleLifecycleContracts";
import {
  activateBundle,
  archiveBundle,
  cloneBundleDraft,
  createBundleDraft,
  deactivateBundle,
  restoreBundle,
  setBundleComposition,
  setBundleTargetPrice,
  updateBundleDraft,
} from "./adminBundleClient";

vi.mock("@/lib/bff/client", () => ({ requestBff: vi.fn().mockResolvedValue({}) }));

const mockedRequestBff = vi.mocked(requestBff);

beforeEach(() => mockedRequestBff.mockClear());

const BASE = "/api/bff/admin/commerce/bundles";

describe("adminBundleClient — every call reaches its own route", () => {
  it.each([
    ["create", createBundleDraft, { mode: "commit", bundle: { code: "starter-set", title: "Starter set" } }],
    ["update", updateBundleDraft, { mode: "commit", code: "starter-set", updates: { title: "Renamed" } }],
    ["set-composition", setBundleComposition, { mode: "commit", code: "starter-set", components: [] }],
    ["set-target-price", setBundleTargetPrice, { mode: "commit", code: "starter-set", price: { mode: "one_time", targetPriceMinor: 4900, currency: "EUR", amountKind: "gross" } }],
    ["archive", archiveBundle, { mode: "commit", code: "starter-set" }],
    ["restore", restoreBundle, { mode: "commit", code: "starter-set" }],
    ["clone-draft", cloneBundleDraft, { mode: "commit", sourceCode: "starter-set", code: "starter-set-two" }],
    ["activate", activateBundle, { mode: "commit", code: "starter-set" }],
    ["deactivate", deactivateBundle, { mode: "commit", code: "starter-set" }],
  ] as const)("POSTs %s without leaking the token into the body", async (route, invoke, body) => {
    await invoke("admin-token", body as never);

    const [url, , options] = mockedRequestBff.mock.calls[0];
    expect(url).toBe(`${BASE}/${route}`);
    expect(options?.method).toBe("POST");
    expect(options?.body).toEqual(body);
    expect(JSON.stringify(options?.body)).not.toContain("admin-token");
    expect((options?.headers as Headers).get("Authorization")).toBe("Bearer admin-token");
  });

  it("hands each call ITS OWN response schema, not a shared one", async () => {
    // The client builds every operation from one factory, so the schema is the only
    // thing distinguishing them. A copy-paste that reused one schema would still
    // route correctly and still pass every assertion above.
    await createBundleDraft("admin-token", { mode: "commit" } as never);
    expect(mockedRequestBff.mock.calls[0][1]).toBe(createBundleDraftResponseSchema);
    mockedRequestBff.mockClear();

    await setBundleComposition("admin-token", { mode: "commit" } as never);
    expect(mockedRequestBff.mock.calls[0][1]).toBe(setBundleCompositionResponseSchema);
    mockedRequestBff.mockClear();

    await activateBundle("admin-token", { mode: "commit" } as never);
    expect(mockedRequestBff.mock.calls[0][1]).toBe(activateBundleResponseSchema);
  });
});

describe("adminBundleClient — the envelopes those schemas admit", () => {
  it("parses a well-formed success envelope", () => {
    expect(
      createBundleDraftResponseSchema.parse({
        contractVersion: COMMERCE_CONTRACT_VERSION,
        dryRun: false,
        idempotent: false,
        code: "starter-set",
        bundleId: "bundle-id",
      }),
    ).toMatchObject({ code: "starter-set", bundleId: "bundle-id", dryRun: false });

    expect(
      setBundleCompositionResponseSchema.parse({
        contractVersion: COMMERCE_CONTRACT_VERSION,
        dryRun: true,
        idempotent: false,
        code: "starter-set",
        componentCount: 2,
      }).componentCount,
    ).toBe(2);
  });

  it("refuses an envelope from a contract version this client does not speak", () => {
    expect(() =>
      setBundleTargetPriceResponseSchema.parse({
        contractVersion: "1900-01-01.not-this-one",
        dryRun: false,
        idempotent: false,
        code: "starter-set",
      }),
    ).toThrow();
  });

  it("refuses a malformed envelope rather than passing it to a caller", () => {
    // A missing idempotent flag is the case that matters: a replayed write that
    // arrived without it would otherwise read as a fresh one.
    expect(() =>
      activateBundleResponseSchema.parse({
        contractVersion: COMMERCE_CONTRACT_VERSION,
        dryRun: false,
        code: "starter-set",
      }),
    ).toThrow();
    expect(() =>
      createBundleDraftResponseSchema.parse({
        contractVersion: COMMERCE_CONTRACT_VERSION,
        dryRun: false,
        idempotent: false,
        code: "Starter Set",
        bundleId: "bundle-id",
      }),
    ).toThrow();
  });
});
