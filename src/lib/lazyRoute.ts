/**
 * `React.lazy` for code-split routes, with module failure recorded at the load
 * boundary instead of inferred from an error message afterwards.
 *
 * A stale or partially loaded chunk and an ordinary application bug can both
 * reach the route error boundary as an `Error`. This wrapper is the point that
 * still knows whether the module load itself failed. It tags rejected loaders
 * and module records with a missing/nullish default export through
 * {@link markModuleFailure}. The tag is private and non-serializable, so it
 * cannot leak through telemetry or alter the error object seen by consumers.
 */
import { lazy, type ComponentType, type LazyExoticComponent } from "react";

import { markModuleFailure } from "./chunkReload";

// Match React.lazy's permissive props contract. Route props are irrelevant at
// this boundary, while a narrower generic makes JSX call sites unassignable.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRouteComponent = ComponentType<any>;

type RouteModule<T extends AnyRouteComponent> = { default: T };

/** Wrap a route factory so loader failures remain classifiable after React.lazy. */
export function lazyRoute<T extends AnyRouteComponent>(
  loader: () => Promise<RouteModule<T>>,
): LazyExoticComponent<T> {
  return lazy(async () => {
    let module: RouteModule<T>;
    try {
      module = await loader();
    } catch (error) {
      throw markModuleFailure(error);
    }

    if (module === null || typeof module !== "object" || module.default == null) {
      throw markModuleFailure(
        new Error("Lazy route module resolved without a default export"),
      );
    }

    return module;
  });
}

export default lazyRoute;
