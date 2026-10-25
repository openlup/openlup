import { expect, it, vi } from "vitest";
import { createCommerceContribution } from "../../src/composition/index.js";

const schema = { version: "complete", migration: "host", objects: [] };
it("declares the installed commerce entries and shares existing port, route and trigger callables", () => {
  const execute = vi.fn();
  const binding = createCommerceContribution({ version: "test", requiredSchema: schema, commerce: { execute, missing: null },
    handlers: [{ eventType: "commerce.order.paid", timeoutMs: 1000 }],
    routes: [{ id: "/selected", handle: execute }], schedules: [{ id: "selected", cadenceSeconds: 60, run: execute }],
  });
  expect(binding.contributions[0].manifest).toEqual({
    name: "@openlup/platform", version: "test", kind: "rail",
    module: { id: "commerce", kind: "capability", provides: ["./commerce", "./commerce/contracts", "./commerce/server"], dependsOn: [] },
    emits: [], handles: ["commerce.order.paid"], env: [], requiredPorts: ["execute", "missing"],
    routes: ["/selected"], schedules: [{ id: "selected", cadenceSeconds: 60 }], requiredSchema: schema,
  });
  expect(binding.ports).toEqual({ "@openlup/platform/commerce:execute": execute });
  expect(binding.routes["@openlup/platform/commerce:/selected"]).toBe(execute);
  expect(binding.triggers["@openlup/platform/commerce:selected"]).toBe(execute);
  expect(execute).not.toHaveBeenCalled();
});

it.each(["handler", "schedule", "route"] as const)("refuses duplicate %s registration", kind => {
  const run = vi.fn(), handler = { eventType: "commerce.order.paid", timeoutMs: 1000 };
  const schedule = { id: "selected", cadenceSeconds: 60, run }, route = { id: "/selected", handle: run };
  expect(() => createCommerceContribution({ version: "test", requiredSchema: schema, commerce: { run },
    handlers: kind === "handler" ? [handler, handler] : [],
    schedules: kind === "schedule" ? [schedule, schedule] : [], routes: kind === "route" ? [route, route] : [],
  })).toThrow(`commerce_duplicate_${kind}`);
});
