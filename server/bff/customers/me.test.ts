import { afterEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  DEFAULT_PLATFORM_BUNDLE,
  PLATFORM_BUNDLE_IDS,
} from "../../domains/platform-runtime/platformKernel.js";
import handler from "./me.js";

const FLAG = "COMMERCE_V2_W12_CUSTOMER_AUTH_UI";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const PROFILE = {
  id: "22222222-2222-4222-8222-222222222222",
  email: "buyer@example.com",
  first_name: "Bart",
  last_name: null,
  lifecycle_stage: "customer",
};
const ENV_PRECEDENCE = {
  key: [
    "VITE_SUPABASE_PUBLISHABLE_KEY",
    "VITE_SUPABASE_ANON_KEY",
    "SUPABASE_ANON_KEY",
  ],
  url: ["SUPABASE_URL", "VITE_SUPABASE_URL"],
} as const;
const SELECTED_URL = "https://customer-identity.test";
const SELECTED_KEY = "preferred-public-key";
const NODE_MANAGED_BUNDLE = PLATFORM_BUNDLE_IDS.find(
  (bundle) => bundle !== DEFAULT_PLATFORM_BUNDLE && bundle !== "node-postgres",
);
if (!NODE_MANAGED_BUNDLE)
  throw new Error(
    "customer-me characterization requires a managed Node bundle",
  );
const BUNDLES = [DEFAULT_PLATFORM_BUNDLE, NODE_MANAGED_BUNDLE] as const;
const ORIGINAL_ENV = process.env;

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = ORIGINAL_ENV;
});

describe("GET /api/bff/customers/me default bundle contract", () => {
  it.each(BUNDLES)(
    "keeps the %s linked-profile response byte-equivalent",
    async (bundle) => {
      const transport = installTransport({ profile: PROFILE });
      configureDefaultBundle(bundle);
      const req = request("GET");
      const res = createResponse();
      const repeated = createResponse();

      await handler(req, res);
      await handler(req, repeated);

      const expected = {
        ok: true,
        data: {
          clientId: PROFILE.id,
          email: PROFILE.email,
          firstName: PROFILE.first_name,
          lastName: PROFILE.last_name,
          lifecycleStage: PROFILE.lifecycle_stage,
        },
      };
      expect(res.status).toHaveBeenCalledTimes(1);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledTimes(1);
      expect(res.json).toHaveBeenCalledWith(expected);
      expect(repeated.status).toHaveBeenCalledTimes(1);
      expect(repeated.status).toHaveBeenCalledWith(200);
      expect(repeated.json).toHaveBeenCalledTimes(1);
      expect(repeated.json).toHaveBeenCalledWith(expected);
      expect(transport.fetch).toHaveBeenCalledTimes(4);
      expect(transport.requests).toHaveLength(4);
      const [auth, profile, repeatedAuth, repeatedProfile] = transport.requests;
      expect(new URL(auth.url).origin).toBe(SELECTED_URL);
      expect(new URL(auth.url).pathname).toBe("/auth/v1/user");
      expect(auth.headers.get("apikey")).toBe(SELECTED_KEY);
      expect(auth.headers.get("authorization")).toBe("Bearer customer-token");
      const profileUrl = new URL(profile.url);
      expect(profileUrl.origin).toBe(SELECTED_URL);
      expect(profileUrl.pathname).toBe("/rest/v1/clients");
      expect(profileUrl.searchParams.get("select")).toBe(
        "id,email,first_name,last_name,lifecycle_stage",
      );
      expect(profileUrl.searchParams.get("auth_user_id")).toBe(`eq.${USER_ID}`);
      expect(profile.headers.get("apikey")).toBe(SELECTED_KEY);
      expect(profile.headers.get("authorization")).toBe(
        "Bearer customer-token",
      );
      expect(repeatedAuth.url).toBe(auth.url);
      expect(repeatedAuth.headers).toEqual(auth.headers);
      expect(repeatedProfile.url).toBe(profile.url);
      expect(repeatedProfile.headers).toEqual(profile.headers);
    },
  );

  it.each(BUNDLES)(
    "keeps %s authentication and profile error envelopes",
    async (bundle) => {
      const cases = [
        {
          transport: { authStatus: 401 },
          status: 401,
          code: "UNAUTHORIZED",
          message: "Customer session required",
        },
        {
          transport: { profile: null },
          status: 403,
          code: "FORBIDDEN",
          message: "No customer account linked to this session",
        },
        {
          transport: { profileStatus: 500 },
          status: 503,
          code: "UPSTREAM_UNAVAILABLE",
          message: "Customer me read failed",
        },
      ] as const;

      for (const expected of cases) {
        const transport = installTransport(expected.transport);
        configureDefaultBundle(bundle);
        const res = createResponse();

        await handler(request("GET"), res);

        expect(res.status).toHaveBeenCalledWith(expected.status);
        expect(res.json).toHaveBeenCalledWith({
          ok: false,
          error: { code: expected.code, message: expected.message },
          meta: { requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) },
        });
        if ("authStatus" in expected.transport) {
          expect(transport.fetch).toHaveBeenCalledTimes(1);
          expect(transport.requests).toHaveLength(1);
          expect(new URL(transport.requests[0].url).pathname).toBe(
            "/auth/v1/user",
          );
        }
      }
    },
  );

  it.each(BUNDLES)(
    "keeps %s missing-environment and disabled-flag envelopes",
    async (bundle) => {
      const transport = installTransport({});
      configureMissingEnvironment(bundle);
      const missingEnvironment = createResponse();

      await handler(request("GET"), missingEnvironment);

      expect(missingEnvironment.status).toHaveBeenCalledWith(500);
      expect(missingEnvironment.json).toHaveBeenCalledWith({
        ok: false,
        error: {
          code: "INTERNAL",
          message: "Supabase environment is not configured",
        },
        meta: { requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) },
      });

      delete process.env[FLAG];
      const disabled = createResponse();
      await handler(request("GET"), disabled);

      expect(disabled.status).toHaveBeenCalledWith(503);
      expect(disabled.json).toHaveBeenCalledWith({
        ok: false,
        error: {
          code: "UPSTREAM_UNAVAILABLE",
          message: "Customer accounts are disabled",
          details: {
            feature: "customer_auth",
            featureFlag: FLAG,
            reason: "feature_flag_disabled",
          },
        },
        meta: { requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) },
      });
      expect(transport.fetch).not.toHaveBeenCalled();
    },
  );
});

function configureDefaultBundle(bundle: (typeof BUNDLES)[number]) {
  const env = isolatedEnvironment({
    [FLAG]: "true",
    PLATFORM_BUNDLE: bundle,
  });
  env[ENV_PRECEDENCE.url[0]] = SELECTED_URL;
  env[ENV_PRECEDENCE.url[1]] = "https://ignored-url.test";
  env[ENV_PRECEDENCE.key[0]] = SELECTED_KEY;
  env[ENV_PRECEDENCE.key[1]] = "ignored-anon-key";
  env[ENV_PRECEDENCE.key[2]] = "ignored-server-key";
  process.env = env;
}

function configureMissingEnvironment(bundle: (typeof BUNDLES)[number]) {
  process.env = isolatedEnvironment({
    [FLAG]: "true",
    PLATFORM_BUNDLE: bundle,
  });
}

function isolatedEnvironment(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...ORIGINAL_ENV, ...overrides };
  for (const key of [...ENV_PRECEDENCE.key, ...ENV_PRECEDENCE.url])
    delete env[key];
  return env;
}

function installTransport({
  authStatus = 200,
  profile = PROFILE,
  profileStatus = 200,
}: {
  authStatus?: number;
  profile?: typeof PROFILE | null;
  profileStatus?: number;
}) {
  const requests: { headers: Headers; url: string }[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const { url } = request;
    requests.push({ headers: request.headers, url });
    if (url.includes("/auth/v1/user")) {
      return json(
        authStatus,
        authStatus === 200
          ? { id: USER_ID, email: PROFILE.email }
          : { message: "invalid" },
      );
    }
    if (url.includes("/rest/v1/clients")) {
      return json(
        profileStatus,
        profileStatus === 200
          ? profile
            ? [profile]
            : []
          : { message: "unavailable" },
      );
    }
    throw new Error(`unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch, requests };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function request(method: string): VercelRequest {
  return {
    method,
    query: {},
    headers: { authorization: "Bearer customer-token" },
  } as unknown as VercelRequest;
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
