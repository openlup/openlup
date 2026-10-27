import { expect, it, vi } from "vitest";
import { createOperationsClients, type OperationsRequestBff } from "../../src/operations/clients.js";

it("preserves method/body/header binding and validates through the supplied BFF requester", async () => {
  const request = vi.fn<OperationsRequestBff>().mockImplementation(async (_path, schema, options) => schema.parse(
    options?.method === "POST" ? { key: "jobs.enabled", saved: true } : { settings: {}, adminUsers: [] },
  ));
  const clients = createOperationsClients(request);
  await expect(clients.getAdminSettings("synthetic-token", { headers: { "x-example": "kept" } })).resolves.toEqual({ settings: {}, adminUsers: [] });
  expect(new Headers(request.mock.calls[0][2]?.headers).get("authorization")).toBe("Bearer synthetic-token");
  expect(new Headers(request.mock.calls[0][2]?.headers).get("x-example")).toBe("kept");
  await clients.updateAdminSetting("synthetic-token", { key: "jobs.enabled", value: false });
  expect(request.mock.calls[1][2]).toMatchObject({ method: "POST", body: { key: "jobs.enabled", value: false } });
});
