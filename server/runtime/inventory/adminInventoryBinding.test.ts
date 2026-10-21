import { describe, expect, it, vi } from "vitest";

import type { VercelRequest } from "../../_lib/types/vercel.js";
import { resolveAdminInventoryRuntimeBinding } from "./adminInventoryBinding.js";

const request = {
  headers: { authorization: "Bearer admin-token" },
} as unknown as VercelRequest;

describe("admin inventory runtime binding", () => {
  it("selects the direct request binding for node-postgres", () => {
    const direct = {
      readPort: {}, mutationPort: {}, authorizeAdmin: vi.fn(), mutationsEnabled: vi.fn(),
    } as never;
    const createDirectBinding = vi.fn(() => direct);
    const env = { PLATFORM_BUNDLE: "node-postgres", APP_BASE_URL: "http://localhost:3000" };

    expect(resolveAdminInventoryRuntimeBinding(request, env, { createDirectBinding })).toBe(direct);
    expect(createDirectBinding).toHaveBeenCalledWith({ env, accessToken: "admin-token" });
    const createManagedGateway = vi.fn();
    expect(resolveAdminInventoryRuntimeBinding(request, env, { createDirectBinding, createManagedGateway })).toBe(direct);
    expect(createManagedGateway).not.toHaveBeenCalled();
  });

  it("does not disguise a missing direct adapter as a Supabase read", () => {
    expect(resolveAdminInventoryRuntimeBinding(request, {
      PLATFORM_BUNDLE: "node-postgres",
      APP_BASE_URL: "http://localhost:3000",
      SUPABASE_URL: "https://managed.invalid",
      VITE_SUPABASE_ANON_KEY: "anon",
      SUPABASE_SERVICE_ROLE_KEY: "service",
    })).toBeNull();
  });

  it("preserves the managed gateway composition for a Supabase bundle", async () => {
    const port = { listStock: vi.fn(async () => ({ stock: [] })), listReservations: vi.fn(), checkAtp: vi.fn(), forecastSubscriptions: vi.fn(), adjustStock: vi.fn() } as never;
    const createManagedGateway = vi.fn(() => ({
      readPort: () => port,
      mutationPort: () => port,
    }));
    const binding = resolveAdminInventoryRuntimeBinding(request, {
      PLATFORM_BUNDLE: "vercel-supabase",
      SUPABASE_URL: "https://managed.invalid",
      VITE_SUPABASE_ANON_KEY: "anon",
      SUPABASE_SERVICE_ROLE_KEY: "service",
      COMMERCE_INVENTORY_MUTATIONS_ENABLED: "true",
    }, { createManagedGateway });

    await binding?.readPort.listStock({ page: 1, pageSize: 10, includeZero: true });
    expect((port as { listStock: unknown }).listStock).toHaveBeenCalledWith({ page: 1, pageSize: 10, includeZero: true });
    expect(binding?.mutationPort).toBe(port);
    expect(binding?.mutationsEnabled()).toBe(true);
    expect(createManagedGateway).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://managed.invalid",
      serviceRoleKey: "service",
    }));
  });
});
