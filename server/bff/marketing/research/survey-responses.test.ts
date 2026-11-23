import { createBffDispatcher } from "@openlup/platform/bff";
import { createNodeHttpRuntime } from "@openlup/platform/http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpRequest, HttpResponse } from "../../../_lib/types/http.js";

const unitComposition = vi.hoisted(() => ({ enabled: true }));
vi.mock("#deployment-route-policy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#deployment-route-policy")>();
  return {
    ...actual,
    enforceDeploymentRoutePolicy: (...args: Parameters<typeof actual.enforceDeploymentRoutePolicy>) =>
      unitComposition.enabled || actual.enforceDeploymentRoutePolicy(...args),
  };
});

const { direct, handleSubmit, createServiceRoleClient } = vi.hoisted(() => ({
  direct: { enabled: true },
  handleSubmit: vi.fn(),
  createServiceRoleClient: vi.fn(),
}));
vi.mock("./acquisitionEvidenceDirect.js", () => ({
  isDirectAcquisitionEvidenceBundle: () => direct.enabled,
  isAcquisitionSurveyView: () => true,
  handleAcquisitionSurveySubmit: handleSubmit,
}));
vi.mock("../../../_lib/admin-domain/auth.js", () => ({ createServiceRoleClient }));
import handler from "./survey-responses.js";

describe("marketing research survey responses public BFF route", () => {
  it("executes the direct survey path through the observed wrapper", async () => {
    handleSubmit.mockImplementation(async (_req: unknown, res: HttpResponse) => {
      res.status(200).json({ ok: true });
    });
    const res = response();
    await handler({ method: "POST", headers: {}, query: {}, body: {} } as unknown as HttpRequest, res);
    expect(handleSubmit).toHaveBeenCalledOnce();
    expect(res.status).toHaveBeenCalledWith(200);
  });
  it("public default refuses before invoking survey submission", async () => {
    unitComposition.enabled = false;
    handleSubmit.mockClear();
    try {
      const res = response();
      await handler({ method: "POST", headers: {}, query: {}, body: {} } as unknown as HttpRequest, res);
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        ok: false, error: expect.objectContaining({ details: expect.objectContaining({ reason: "adopter_policy_required" }) }),
      }));
      expect(handleSubmit).not.toHaveBeenCalled();
    } finally {
      unitComposition.enabled = true;
    }
  });

});

const now = "2020-01-15T12:00:00.000Z";
const cutoff = "2020-01-15T11:00:00.000Z";
const recent = "2020-01-15T11:59:00.000Z";
const producer = "survey_responses_producer";
const consumer = "survey_responses_consumer";
const peer = "192.0.2.10";
const forwarded = "198.51.100.10";
const route = "/api/bff/marketing/research/survey-responses";
const producerBody = { surveyType: "producer", responseData: { role: "Founder" } };

describe("managed survey response quota and storage", () => {
  beforeEach(() => {
    direct.enabled = false;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(now));
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role");
    vi.stubEnv("RESEND_PROVIDER_MODE", "sandbox");
    vi.stubEnv("RESEND_SANDBOX_API_KEY", "test-sandbox-key");
    vi.stubEnv("SURVEY_RESPONSE_NOTIFY_TO", "");
    vi.stubEnv("SURVEY_RESPONSE_RATE_LIMIT_WINDOW_MINUTES", "60");
    vi.stubEnv("SURVEY_RESPONSE_RATE_LIMIT_MAX_PER_IP", "3");
    vi.stubEnv("CUSTOMER_DIAGNOSTIC_TRUSTED_PROXY_HOPS", undefined);
    vi.stubEnv("VERCEL", undefined);
  });

  afterEach(() => {
    direct.enabled = true;
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("counts and stores the socket peer across different forwarding headers", async () => {
    const db = surveyDatabase();
    await submitSurvey(peer, forwarded);
    await submitSurvey(peer, "198.51.100.11");
    await submitSurvey("192.0.2.11", forwarded, "consumer");

    expect(db.counts).toEqual([
      { table: producer, filter: "eq", address: peer, since: cutoff, ids: [] },
      { table: producer, filter: "eq", address: peer, since: cutoff, ids: ["insert-1"] },
      { table: consumer, filter: "eq", address: "192.0.2.11", since: cutoff, ids: [] },
    ]);
    expect(db.insert.mock.calls.map(([table, row]) => [table, row.ip_address, row.user_agent])).toEqual([
      [producer, peer, "survey-test"], [producer, peer, "survey-test"], [consumer, "192.0.2.11", "survey-test"],
    ]);
  });

  it("keeps the socket peer through Node HTTP adaptation and dispatch", async () => {
    const db = surveyDatabase();
    const dispatch = createBffDispatcher({
      env: () => ({}),
      preflight: () => true,
      notFound: (res) => { res.status(404).end(); },
    });
    const runtime = createNodeHttpRuntime({
      routes: [{ route, pattern: /^\/api\/bff\/marketing\/research\/survey-responses$/, params: [], handler }],
      dispatch,
      security: { globalHeaders: [], assetCachePrefixes: [], noindexFamilies: [], noindexExacts: [], isProductionHost: () => false },
    });
    if (!runtime.listen) throw new Error("Expected a Node HTTP listener");
    await runtime.listen({ port: 0, host: "127.0.0.1" });
    const server = runtime.server;
    if (!server) throw new Error("Expected a loopback listener");
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a loopback listener");
      const res = await fetch(`http://127.0.0.1:${address.port}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": forwarded },
        body: JSON.stringify(producerBody),
      });
      expect(await res.json()).toMatchObject({ ok: true, data: { ok: true } });
      expect(db.counts[0]).toMatchObject({ filter: "eq", address: "127.0.0.1" });
      expect(db.insert).toHaveBeenCalledWith(producer, expect.objectContaining({ ip_address: "127.0.0.1" }));
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it("counts recent NULLs in the selected table and refuses at the threshold", async () => {
    vi.stubEnv("CUSTOMER_DIAGNOSTIC_TRUSTED_PROXY_HOPS", "invalid");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const db = surveyDatabase([
      { table: producer, ip_address: null, created_at: recent, id: "recent" },
      { table: producer, ip_address: null, created_at: cutoff, id: "at-cutoff" },
      { table: producer, ip_address: null, created_at: "2020-01-15T10:59:59.999Z", id: "too-old" },
      { table: producer, ip_address: peer, created_at: recent, id: "known" },
      { table: consumer, ip_address: null, created_at: recent, id: "other-table" },
    ]);

    const accepted = await submitSurvey(peer, forwarded);
    const limited = await submitSurvey("192.0.2.11", "198.51.100.11");
    const consumerAccepted = await submitSurvey(peer, forwarded, "consumer");

    expect(db.counts).toEqual([
      { table: producer, filter: "is", address: null, since: cutoff, ids: ["recent", "at-cutoff"] },
      { table: producer, filter: "is", address: null, since: cutoff, ids: ["recent", "at-cutoff", "insert-1"] },
      { table: consumer, filter: "is", address: null, since: cutoff, ids: ["other-table"] },
    ]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("OPENLUP_E_TRUSTED_PROXY_HOPS_INVALID"));
    expect(accepted.json).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ ok: true }) }));
    expect(limited.json).toHaveBeenCalledWith({ ok: true, data: { ok: false, error: "survey_rate_limited" } });
    expect(consumerAccepted.json).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ ok: true }) }));
    expect(db.insert.mock.calls.map(([table, row]) => [table, row.ip_address])).toEqual([
      [producer, null], [consumer, null],
    ]);
  });

  it("counts a recent row under the resolved key and excludes the old forwarded key", async () => {
    vi.stubEnv("SURVEY_RESPONSE_RATE_LIMIT_MAX_PER_IP", "2");
    const db = surveyDatabase([
      { table: producer, ip_address: peer, created_at: recent, id: "resolved-key" },
      { table: producer, ip_address: forwarded, created_at: recent, id: "old-key" },
    ]);

    const accepted = await submitSurvey(peer, forwarded);
    const limited = await submitSurvey(peer, forwarded);

    expect(db.counts.map(({ ids }) => ids)).toEqual([["resolved-key"], ["resolved-key", "insert-1"]]);
    expect(accepted.json).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ ok: true }) }));
    expect(limited.json).toHaveBeenCalledWith({ ok: true, data: { ok: false, error: "survey_rate_limited" } });
    expect(db.insert).toHaveBeenCalledOnce();
  });

  it("fails closed on a count error", async () => {
    const db = surveyDatabase([], new Error("count unavailable"));
    const res = await submitSurvey(peer, forwarded);

    expect(res.json).toHaveBeenCalledWith({ ok: true, data: { ok: false, error: "survey_rate_limit_unavailable" } });
    expect(db.insert).not.toHaveBeenCalled();
  });
});

type SurveyRow = { table: string; ip_address: string | null; created_at: string; id: string };

function surveyDatabase(rows: SurveyRow[] = [], countError?: Error) {
  const counts: { table: string; filter: string; address: string | null; since: string; ids: string[] }[] = [];
  let inserted = 0;
  const insert = vi.fn((table: string, row: { ip_address: string | null; user_agent: string | null }) => {
    const id = `insert-${++inserted}`;
    rows.push({ table, ip_address: row.ip_address, created_at: now, id });
    return { select: () => ({ single: async () => ({ data: { id } }) }) };
  });
  createServiceRoleClient.mockReturnValue({
    from: (table: string) => ({
      select(columns: string, options: unknown) {
        if (columns !== "id" || JSON.stringify(options) !== JSON.stringify({ count: "exact", head: true })) {
          throw new Error("Expected an exact head count");
        }
        const matchAddress = (filter: string, field: string, address: string | null) => ({
          async gte(dateField: string, since: string) {
            if (field !== "ip_address" || dateField !== "created_at") throw new Error("Unexpected count filter");
            const ids = rows.filter(row => row.table === table && row.ip_address === address && row.created_at >= since)
              .map(row => row.id);
            counts.push({ table, filter, address, since, ids });
            return { count: countError ? null : ids.length, error: countError };
          },
        });
        return {
          eq: (field: string, address: string) => matchAddress("eq", field, address),
          is: (field: string, address: null) => matchAddress("is", field, address),
        };
      },
      insert: (row: Parameters<typeof insert>[1]) => insert(table, row),
      update: () => ({ eq: async () => ({}) }),
    }),
  });
  return { counts, insert };
}

async function submitSurvey(address: string, forwarding: string, surveyType = "producer") {
  const res = response();
  await handler({
    method: "POST",
    headers: { "x-forwarded-for": forwarding, "cf-connecting-ip": "203.0.113.2", "user-agent": "survey-test" },
    query: {},
    body: { ...producerBody, surveyType },
    socket: { remoteAddress: address },
  } as unknown as HttpRequest, res);
  return res;
}

function response(): HttpResponse {
  const res = { statusCode: 200, setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as HttpResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}
