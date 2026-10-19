// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const roots = vi.hoisted(() => ({ createRoot: vi.fn(), render: vi.fn(), hydrateRoot: vi.fn() }));
vi.mock("react-dom/client", () => ({
  createRoot: roots.createRoot.mockImplementation(() => ({ render: roots.render })),
  hydrateRoot: roots.hydrateRoot,
}));

describe("selected subscription entry", () => {
  beforeEach(() => {
    vi.resetModules();
    roots.createRoot.mockClear();
    roots.render.mockClear();
    roots.hydrateRoot.mockClear();
    document.body.innerHTML = '<div id="root"></div>';
  });

  it.each(["/subscribe", "/sign-in", "/zaloguj-sie", "/account", "/konto", "/account/auth/callback", "/konto/auth/callback"])("creates a shared customer root at %s", async (path) => {
    window.history.replaceState({}, "", path);
    await import("./subscription-main");
    expect(roots.createRoot).toHaveBeenCalledOnce();
    expect(roots.hydrateRoot).not.toHaveBeenCalled();
    expect(roots.render).toHaveBeenCalledOnce();
    const { appQueryClient } = await import("@/lib/queryClient");
    expect(roots.render.mock.calls[0]?.[0].props.client).toBe(appQueryClient);
    expect(roots.render.mock.calls[0][0].props.client).toBe((await import("@/lib/queryClient")).appQueryClient);
  });

  it("preserves static SSR hydration for the original reference routes", async () => {
    window.history.replaceState({}, "", "/items/field-notes");
    await import("./subscription-main");
    expect(roots.hydrateRoot).toHaveBeenCalledOnce();
    expect(roots.createRoot).not.toHaveBeenCalled();
    expect(roots.hydrateRoot.mock.calls[0]?.[1]).toMatchObject({ props: { pathname: "/items/field-notes" } });
  });
});
