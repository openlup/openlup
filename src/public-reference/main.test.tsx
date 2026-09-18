import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hydrateRoot: vi.fn(),
}));

vi.mock("react-dom/client", () => ({
  hydrateRoot: mocks.hydrateRoot,
}));

describe("public reference client entry", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.hydrateRoot.mockClear();
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState({}, "", "/items/field-notes");
  });

  it("hydrates the bounded public app at the current pathname", async () => {
    await import("./main");

    expect(mocks.hydrateRoot).toHaveBeenCalledOnce();
    expect(mocks.hydrateRoot.mock.calls[0][0]).toBe(document.getElementById("root"));
    expect(mocks.hydrateRoot.mock.calls[0][1]).toMatchObject({
      props: { pathname: "/items/field-notes" },
    });
  });

  it("fails closed when the public root is absent", async () => {
    document.body.innerHTML = "";

    await expect(import("./main")).rejects.toThrow("Public reference root is missing");
    expect(mocks.hydrateRoot).not.toHaveBeenCalled();
  });
});
