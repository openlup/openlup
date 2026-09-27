// W15 transport witness for the CP2-R readback seam.
//
// CP2-R (#2340) repointed the reference journey's four authenticated order readbacks from the
// product routes (`/api/bff/customers/orders*`, `/api/bff/admin/commerce/orders*`) onto the neutral
// `/api/bff/reference-journey/*` pair. Nothing pinned that: restoring either product route left the
// whole suite green, because the proof only asserts the *statuses* the routes return and the product
// routes return the same ones. This file is that missing pin — it reads the transport module and
// asserts which routes the journey actually calls, in order, so an accidental (or quiet) revert of
// the seam is a red test rather than an invisible regression.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./reference-journey-readbacks.ts", import.meta.url), "utf8");

const CUSTOMER_ROUTE = "/api/bff/reference-journey/customer/order-readback";
const OPERATOR_ROUTE = "/api/bff/reference-journey/operator/order-readback";
// The exact product routes the seam moved off. They are named as literals so a revert is caught by
// this file, not only by whoever happens to reread the diff.
const PRODUCT_ROUTES = ["/api/bff/customers/orders", "/api/bff/admin/commerce/orders"];

type Call = { route: string; operation: string | null; authenticated: boolean };

// Every readback goes through the one shared `requestJson(baseUrl, <url>, <options?>)` helper, so the
// call list is the transport contract. `unwrap(` in front of a call is what marks the four
// authenticated list/detail readbacks; the remaining calls are the anonymous/cross-user denials.
function requestedCalls(): Call[] {
  return [...source.matchAll(/(unwrap\(await\s+)?requestJson\(baseUrl,\s*[`"]([^`"]+)[`"](,\s*\{\s*token)?/g)].map(
    ([, unwrapped, url, token]) => {
      const [route, query = ""] = url.split("?");
      return { route: route!, operation: /operation=([a-z]+)/.exec(query)?.[1] ?? null, authenticated: Boolean(unwrapped) && Boolean(token) };
    },
  );
}

describe("reference journey readback transport", () => {
  it("calls the neutral reference-journey routes for all four authenticated list/detail readbacks", () => {
    const authenticated = requestedCalls().filter((call) => call.authenticated);
    expect(authenticated).toEqual([
      { route: CUSTOMER_ROUTE, operation: "list", authenticated: true },
      { route: CUSTOMER_ROUTE, operation: "detail", authenticated: true },
      { route: OPERATOR_ROUTE, operation: "list", authenticated: true },
      { route: OPERATOR_ROUTE, operation: "detail", authenticated: true },
    ]);
  });

  it("keeps every negative control on the same neutral routes", () => {
    // A denial proved against a different route proves nothing about the route the owner reads.
    expect(requestedCalls().map((call) => `${call.route}?operation=${call.operation}`)).toEqual([
      `${CUSTOMER_ROUTE}?operation=list`,
      `${CUSTOMER_ROUTE}?operation=detail`,
      `${CUSTOMER_ROUTE}?operation=list`,
      `${CUSTOMER_ROUTE}?operation=list`,
      `${CUSTOMER_ROUTE}?operation=detail`,
      `${OPERATOR_ROUTE}?operation=list`,
      `${OPERATOR_ROUTE}?operation=detail`,
      `${OPERATOR_ROUTE}?operation=list`,
    ]);
  });

  it("does not reach for the product routes the seam moved off", () => {
    for (const productRoute of PRODUCT_ROUTES) expect(source).not.toContain(productRoute);
    expect(source.match(new RegExp(CUSTOMER_ROUTE, "g"))).toHaveLength(5);
    expect(source.match(new RegExp(OPERATOR_ROUTE, "g"))).toHaveLength(3);
  });
});
