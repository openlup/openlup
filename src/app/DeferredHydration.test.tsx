import { act, useState } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DeferredHydration } from "./DeferredHydration";
import { RenderRuntimeProvider } from "./renderMode";

class TestIntersectionObserver {
  static instances: TestIntersectionObserver[] = [];
  constructor(private readonly callback: IntersectionObserverCallback) {
    TestIntersectionObserver.instances.push(this);
  }
  observe = vi.fn();
  disconnect = vi.fn();
  intersect() {
    this.callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

describe("DeferredHydration", () => {
  afterEach(() => {
    TestIntersectionObserver.instances = [];
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("preserves server HTML until its below-fold boundary is approached", async () => {
    vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
    document.body.innerHTML = [
      '<div id="root">',
      '<div data-deferred-hydration="below-fold"><!--$--><button type="button">Static FAQ</button><!--/$--></div>',
      "</div>",
    ].join("");
    const root = document.getElementById("root")!;
    const recoverableError = vi.fn();

    await act(async () => {
      hydrateRoot(
        root,
        <RenderRuntimeProvider mode="ssg">
          <DeferredHydration><button type="button">Static FAQ</button></DeferredHydration>
        </RenderRuntimeProvider>,
        { onRecoverableError: recoverableError },
      );
    });

    expect(root).toHaveTextContent("Static FAQ");
    expect(recoverableError).not.toHaveBeenCalled();
    expect(TestIntersectionObserver.instances).toHaveLength(1);

    await act(async () => {
      TestIntersectionObserver.instances[0].intersect();
    });

    expect(root).toHaveTextContent("Static FAQ");
    expect(recoverableError).not.toHaveBeenCalled();
  });

  it("renders a boundary mounted after the first SSG commit without an observer", async () => {
    vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
    document.body.innerHTML = '<div id="root"></div>';
    const container = document.getElementById("root")!;
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <RenderRuntimeProvider mode="ssg">
          <MountDeferredBoundary />
        </RenderRuntimeProvider>,
      );
    });

    await act(async () => {
      container.querySelector("button")?.click();
    });

    expect(container).toHaveTextContent("SPA product details");
    expect(TestIntersectionObserver.instances).toHaveLength(0);
  });
});

function MountDeferredBoundary() {
  const [mounted, setMounted] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setMounted(true)}>Mount product sections</button>
      {mounted ? (
        <DeferredHydration>
          <p>SPA product details</p>
        </DeferredHydration>
      ) : null}
    </>
  );
}
