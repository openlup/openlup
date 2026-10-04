import { describe, expect, it, vi } from "vitest";
import handler from "./[slug].js";
import { APP_SHELL_ASSET_OVERRIDES } from "../../src/lib/brand/appShellAssets.js";

const IMAGE_URL = "https://blob.example.test/share/abcdef.png";

/** The neutral path the handler writes, and the file this deployment answers it with. */
const NEUTRAL_ICON = "/platform/favicon.svg";
const DEPLOYMENT_ICON = APP_SHELL_ASSET_OVERRIDES[NEUTRAL_ICON] ?? NEUTRAL_ICON;

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
  it("serves the icon from the selected neutral presentation", async () => {
    const res = createResponse();

    await invoke("abcdef", res);

    expect(res.status).toHaveBeenCalledWith(200);
    const markup = sentMarkup(res);
    expect(markup).toContain(`href="${DEPLOYMENT_ICON}"`);
    expect(markup).toContain(NEUTRAL_ICON);
  });

  it("keeps the neutral icon when the selected overlay is empty", () => {
    expect(APP_SHELL_ASSET_OVERRIDES).toEqual({});
    expect(DEPLOYMENT_ICON).toBe(NEUTRAL_ICON);
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
