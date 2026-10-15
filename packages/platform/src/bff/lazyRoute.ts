// Loads a BFF route module on its first request instead of at cold start.
//
// A route table binds each route as `lazyBffRoute(() => import("<specifier>"))`, so the
// specifier stays a static literal that bundlers and inventories can read, and the load's type
// keeps every module's default export checked against `RouteEntry["handler"]`.
//
// Concurrent first calls share one load. A rejected load is not kept: the requests that awaited
// it reject as a throwing handler does, and the next request loads again. A module that threw
// during evaluation stays errored in Node's ESM loader; the retry helps only a failure before
// evaluation (a missing file or a read error). Once loaded, the module's handler is called
// synchronously and its result returned.
import type { RouteEntry } from "./dispatch.js";

export function lazyBffRoute(load: () => Promise<{ default: RouteEntry["handler"] }>): RouteEntry["handler"] {
  let handler: RouteEntry["handler"] | undefined;
  let loading: Promise<RouteEntry["handler"]> | undefined;
  return (req, res) => {
    if (handler) return handler(req, res);
    loading ??= load().then(
      (module) => (handler = module.default),
      (error: unknown) => {
        loading = undefined;
        throw error;
      },
    );
    return loading.then((loaded) => loaded(req, res));
  };
}
