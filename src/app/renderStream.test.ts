import { createElement, lazy, Suspense } from "react";
import { describe, expect, it, vi } from "vitest";

import { renderCompleteReactHtml, StaticRenderTimeoutError } from "./renderStream";

describe("renderCompleteReactHtml", () => {
  it("waits for lazy content instead of returning a Suspense fallback", async () => {
    const LazyContent = lazy(async () => ({
      default: () => createElement("h1", null, "Complete route"),
    }));
    const tree = createElement(
      Suspense,
      { fallback: createElement("p", null, "Loading") },
      createElement(LazyContent),
    );

    await expect(renderCompleteReactHtml(tree)).resolves.toContain("Complete route");
  });

  it("rejects render errors and reports the same failure", async () => {
    const failure = new Error("lazy route failed");
    const onError = vi.fn();
    const Broken = lazy(async () => {
      throw failure;
    });
    const tree = createElement(
      Suspense,
      { fallback: createElement("p", null, "Loading") },
      createElement(Broken),
    );

    await expect(renderCompleteReactHtml(tree, { onError })).rejects.toBe(failure);
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it("aborts a route whose lazy tree never settles", async () => {
    const Never = lazy(() => new Promise(() => {}));
    const tree = createElement(
      Suspense,
      { fallback: createElement("p", null, "Loading") },
      createElement(Never),
    );

    await expect(renderCompleteReactHtml(tree, { timeoutMs: 20 })).rejects.toBeInstanceOf(
      StaticRenderTimeoutError,
    );
  });

  it("rejects invalid timeout configuration before rendering", async () => {
    await expect(
      renderCompleteReactHtml(createElement("p"), { timeoutMs: 0 }),
    ).rejects.toBeInstanceOf(RangeError);
  });
});
