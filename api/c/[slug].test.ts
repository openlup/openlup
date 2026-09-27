// What this deployment serves from the share route, after the R6 payment.
//
// The handler composes its own entry document, so it carries the entry document's
// obligation: every static path it names must be answerable by a tree containing
// only publishable files. It therefore names `/platform/favicon.svg` and puts this
// deployment's own file back through `applyAppShellAssetOverrides`.
//
// The assertion that matters is the one that would catch the mistake this shape
// invites: shipping the NEUTRAL path to real visitors. Naming the neutral path and
// forgetting to apply the overrides is a silent, correct-looking change - the icon
// still resolves, it is just the platform's placeholder - and nothing else in the
// repository reads this document. So the test asserts both halves: the served
// markup carries `/favicon.svg` and does NOT carry `/platform/`.
//
// The request and response are described STRUCTURALLY rather than by importing the
// hosting provider's request/response types. Two reasons, and the second is the
// load-bearing one: this suite reads four members in total, and `bff-api`'s
// `provider` counter reads 7740 of 7740 + 3, so naming the vendor type would have
// spent a publishable family's entire remaining headroom on a test's annotations.

import { describe, expect, it, vi } from "vitest";
import handler from "./[slug].js";
import { APP_SHELL_ASSET_OVERRIDES } from "../../src/lib/brand/appShellAssets.js";

const IMAGE_URL = "https://blob.example.test/share/abcdef.png";

/** The neutral path the handler writes, and the file this deployment answers it with. */
const NEUTRAL_ICON = "/platform/favicon.svg";
const DEPLOYMENT_ICON = APP_SHELL_ASSET_OVERRIDES[NEUTRAL_ICON];

vi.mock("../../server/_lib/facades/blob.facade.js", () => ({
  blobFacade: {
    urlFor: () => IMAGE_URL,
    exists: async (slug: string) => slug !== "missing",
  },
}));

type ResponseDouble = {
  status: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
};

describe("/api/c/[slug] share document", () => {
  it("serves this deployment's own icon, not the platform placeholder", async () => {
    const res = createResponse();

    await invoke("abcdef", res);

    expect(res.status).toHaveBeenCalledWith(200);
    const markup = sentMarkup(res);
    // Read out of the map rather than spelled here. Not a style choice: writing the
    // expected icon attribute out as a literal would make THIS FILE a published
    // carrier naming a withheld asset, which is the very defect
    // `check-publishable-asset-references` pins at 0 - and it caught exactly that
    // when this suite was first written, twice: once in the assertion and once in
    // the sentence explaining the assertion. Building the attribute from the map
    // also couples the two, so a renamed key cannot leave this expectation passing.
    expect(markup).toContain(`href="${DEPLOYMENT_ICON}"`);
    // The override must have been applied, not merely declared.
    expect(markup).not.toContain("/platform/");
  });

  it("resolves the neutral shell path this deployment overrides", () => {
    expect(DEPLOYMENT_ICON).toBe(APP_SHELL_ASSET_OVERRIDES[NEUTRAL_ICON]);
    expect(DEPLOYMENT_ICON).not.toBe(NEUTRAL_ICON);
  });

  it("still refuses a slug with no blob behind it, and that document names no asset", async () => {
    const res = createResponse();

    await invoke("missing", res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(sentMarkup(res)).not.toContain("favicon");
  });

  it("rejects a malformed slug before reaching storage", async () => {
    const res = createResponse();

    await invoke("../etc", res);

    expect(res.status).toHaveBeenCalledWith(400);
  });
});

/** Call the route with the two request members it reads. */
function invoke(slug: string, res: ResponseDouble): Promise<void> {
  const route = handler as unknown as (request: unknown, response: unknown) => Promise<void>;
  return route({ method: "GET", query: { slug } }, res);
}

function createResponse(): ResponseDouble {
  const res: ResponseDouble = { status: vi.fn(), send: vi.fn(), setHeader: vi.fn() };
  res.status.mockReturnValue(res);
  res.send.mockReturnValue(res);
  return res;
}

function sentMarkup(res: ResponseDouble): string {
  const calls = res.send.mock.calls;
  expect(calls).toHaveLength(1);
  return String(calls[0]?.[0] ?? "");
}
