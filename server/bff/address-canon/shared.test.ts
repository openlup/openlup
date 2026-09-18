import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { sendBffError, sendBffSuccess } from "../../_lib/bff/response.js";
import { createHiddenAddressCanonRoute } from "./shared.js";
import { createSupabaseAddressCanonLookupPort } from "../../adapters/supabase/address-canon/addressCanonLookup.js";
import { createSupabaseDataGateway } from "../../adapters/supabase/dataGateway.js";

vi.mock("../../adapters/supabase/dataGateway.js", () => ({
  createSupabaseDataGateway: vi.fn(),
}));

vi.mock("../../adapters/supabase/address-canon/addressCanonLookup.js", () => ({
  createSupabaseAddressCanonLookupPort: vi.fn(),
}));

const mockedCreatePort = vi.mocked(createSupabaseAddressCanonLookupPort);
const mockedCreateGateway = vi.mocked(createSupabaseDataGateway);
const serviceClient = { role: "service" };
const gatewayAsService = vi.fn(async (callback: (client: unknown) => Promise<unknown>) => callback(serviceClient));

function stubPort(probe: () => Promise<boolean>) {
  return {
    probeDataAvailable: vi.fn(probe),
    lookupPostalCode: vi.fn(),
    searchLocalities: vi.fn(),
    listStreets: vi.fn(),
  } as unknown as ReturnType<typeof createSupabaseAddressCanonLookupPort>;
}

function withServiceEnv(): void {
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
}

describe("hidden address canon BFF route gate", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    mockedCreateGateway.mockReset();
  });

  it("keeps the shared BFF route behind the data gateway", () => {
    const source = readFileSync("server/bff/address-canon/shared.ts", "utf8");
    expect(source).not.toContain("@supabase/supabase-js");
    expect(source).not.toContain("createClient(");
    expect(source).not.toContain(".rpc(");
    expect(source).not.toContain(".from(");
    expect(source).toContain("createSupabaseDataGateway");
    expect(source).toContain(".asService(");
  });

  it("fails closed before gateway composition when Supabase service env is missing", async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.VITE_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const factory = vi.fn();
    const res = createResponse();

    await createHiddenAddressCanonRoute(factory)(request("GET"), res);

    expect(factory).not.toHaveBeenCalled();
    expect(mockedCreateGateway).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      ok: false,
      error: { code: "INTERNAL", message: "Supabase service environment is not configured" },
    });
  });
});

describe("hidden address canon BFF route dataAvailable hint", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    mockedCreatePort.mockReset();
    mockedCreateGateway.mockReset();
    gatewayAsService.mockClear();
  });

  it("stamps meta.dataAvailable=true on the success envelope when the directory is loaded", async () => {
    withServiceEnv();
    mockedCreateGateway.mockReturnValue({ asService: gatewayAsService } as never);
    mockedCreatePort.mockReturnValue(stubPort(() => Promise.resolve(true)));
    const res = createResponse();
    const jsonSpy = vi.mocked(res.json);

    const factory = () => async (_req: VercelRequest, response: VercelResponse) => {
      sendBffSuccess(response, { candidates: [] }, { contractVersion: "address.canon.v1" });
    };

    await createHiddenAddressCanonRoute(factory)(request("GET"), res);

    expect(mockedCreateGateway).toHaveBeenCalledWith({
      url: "https://example.supabase.co",
      anonKey: expect.any(String),
      serviceRoleKey: "service-role-key",
    });
    expect(gatewayAsService).toHaveBeenCalledOnce();
    expect(mockedCreatePort).toHaveBeenCalledWith(serviceClient);
    expect(jsonSpy).toHaveBeenCalledWith({
      ok: true,
      data: { candidates: [] },
      meta: { contractVersion: "address.canon.v1", dataAvailable: true },
    });
  });

  it("stamps meta.dataAvailable=false so empty candidates can be read as 'not loaded'", async () => {
    withServiceEnv();
    mockedCreateGateway.mockReturnValue({ asService: gatewayAsService } as never);
    mockedCreatePort.mockReturnValue(stubPort(() => Promise.resolve(false)));
    const res = createResponse();
    const jsonSpy = vi.mocked(res.json);

    const factory = () => async (_req: VercelRequest, response: VercelResponse) => {
      sendBffSuccess(response, { candidates: [] });
    };

    await createHiddenAddressCanonRoute(factory)(request("GET"), res);

    expect(jsonSpy).toHaveBeenCalledWith({
      ok: true,
      data: { candidates: [] },
      meta: { dataAvailable: false },
    });
  });

  it("omits the hint and never fails the lookup when the probe throws", async () => {
    withServiceEnv();
    mockedCreateGateway.mockReturnValue({ asService: gatewayAsService } as never);
    mockedCreatePort.mockReturnValue(stubPort(() => Promise.reject(new Error("probe down"))));
    const res = createResponse();
    const jsonSpy = vi.mocked(res.json);

    const factory = () => async (_req: VercelRequest, response: VercelResponse) => {
      sendBffSuccess(response, { candidates: [] }, { contractVersion: "address.canon.v1" });
    };

    await createHiddenAddressCanonRoute(factory)(request("GET"), res);

    expect(jsonSpy).toHaveBeenCalledWith({
      ok: true,
      data: { candidates: [] },
      meta: { contractVersion: "address.canon.v1" },
    });
  });

  it("leaves error envelopes from the downstream handler untouched", async () => {
    withServiceEnv();
    mockedCreateGateway.mockReturnValue({ asService: gatewayAsService } as never);
    mockedCreatePort.mockReturnValue(stubPort(() => Promise.resolve(true)));
    const res = createResponse();
    const jsonSpy = vi.mocked(res.json);

    const factory = () => async (_req: VercelRequest, response: VercelResponse) => {
      sendBffError(response, "UPSTREAM_UNAVAILABLE", "boom");
    };

    await createHiddenAddressCanonRoute(factory)(request("GET"), res);

    expect(jsonSpy).toHaveBeenCalledWith({
      ok: false,
      error: { code: "UPSTREAM_UNAVAILABLE", message: "boom" },
    });
  });
});

function request(method: string): VercelRequest {
  return { method, query: {} } as unknown as VercelRequest;
}

function createResponse(): VercelResponse {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as VercelResponse;

  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}
