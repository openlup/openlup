import {
  referenceJourneyOrderReadbackDetailResponseSchema,
  referenceJourneyOrderReadbackListResponseSchema,
  referenceJourneyOrderReadbackRequestSchema,
} from "../../src/domains/commerce/referenceJourneyReadbackContracts.js";

export type ReferenceJourneyReadbackConfiguration = {
  baseUrl: string;
  customerToken: string;
  crossCustomerToken: string;
  operatorToken: string;
  orderId: string;
};

// A local proof transport, not route activation or a database/lifecycle runner.
// Credentials are explicit, stay in headers, and never enter returned evidence or errors.
export async function runReferenceJourneyReadbacks(
  configuration: ReferenceJourneyReadbackConfiguration,
  fetchTransport: typeof fetch = fetch,
) {
  const baseUrl = validateConfiguration(configuration);
  const { customerToken, crossCustomerToken, operatorToken, orderId } = configuration;
  const detailQuery = `operation=detail&orderId=${encodeURIComponent(orderId)}`;

  async function requestJson(path: string, token?: string): Promise<{ status: number; body: unknown }> {
    try {
      const response = await fetchTransport(new URL(path, baseUrl), {
        method: "GET",
        headers: token ? { Accept: "application/json", Authorization: `Bearer ${token}` } : { Accept: "application/json" },
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      return { status: response.status, body: await response.json() };
    } catch {
      // Fetch/JSON errors may contain request headers or reflected credentials.
      throw new Error("Reference journey readback transport failed");
    }
  }

  const customerList = listData(await requestJson("/api/bff/reference-journey/customer/order-readback?operation=list", customerToken), orderId);
  const customerDetail = detailData(await requestJson(`/api/bff/reference-journey/customer/order-readback?${detailQuery}`, customerToken), orderId);
  const anonymousCustomer = denial(await requestJson("/api/bff/reference-journey/customer/order-readback?operation=list"), 401, "UNAUTHORIZED");
  const crossList = denial(await requestJson("/api/bff/reference-journey/customer/order-readback?operation=list", crossCustomerToken), 403, "FORBIDDEN");
  const crossDetail = denial(await requestJson(`/api/bff/reference-journey/customer/order-readback?${detailQuery}`, crossCustomerToken), 404, "NOT_FOUND");
  const operatorList = listData(await requestJson("/api/bff/reference-journey/operator/order-readback?operation=list", operatorToken), orderId);
  const operatorDetail = detailData(await requestJson(`/api/bff/reference-journey/operator/order-readback?${detailQuery}`, operatorToken), orderId);
  const anonymousOms = denial(await requestJson("/api/bff/reference-journey/operator/order-readback?operation=list"), 401, "UNAUTHORIZED");
  const evidence = { customerList, customerDetail, operatorList, operatorDetail, readbackDenials: { anonymousCustomer, crossList, crossDetail, anonymousOms } };
  const serialized = JSON.stringify(evidence);
  if ([customerToken, crossCustomerToken, operatorToken].some((token) => serialized.includes(token))) throw new Error("Reference journey readback evidence contains a credential");
  return evidence;
}

function validateConfiguration(configuration: ReferenceJourneyReadbackConfiguration): URL {
  try {
    if (!configuration || typeof configuration.baseUrl !== "string") throw new Error();
    const url = new URL(configuration.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)
      || !['127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error();
    const tokens = [configuration.customerToken, configuration.crossCustomerToken, configuration.operatorToken];
    if (tokens.some((token) => typeof token !== "string" || !/^[\x21-\x7e]+$/.test(token)) || new Set(tokens).size !== tokens.length) throw new Error();
    if (!referenceJourneyOrderReadbackRequestSchema.safeParse({ operation: "detail", orderId: configuration.orderId }).success) throw new Error();
    return url;
  } catch {
    throw new Error("Invalid reference journey readback configuration");
  }
}

type Result = { status: number; body: unknown };
function successData(result: Result): unknown {
  if (result.status !== 200 || !isRecord(result.body) || result.body.ok !== true) throw new Error("Reference journey readback expected success");
  return result.body.data;
}
function listData(result: Result, orderId: string) {
  const parsed = referenceJourneyOrderReadbackListResponseSchema.safeParse(successData(result));
  if (!parsed.success || !parsed.data.orders.some((order) => order.orderId === orderId)) throw new Error("Reference journey readback list did not contain the expected order");
  return parsed.data;
}
function detailData(result: Result, orderId: string) {
  const parsed = referenceJourneyOrderReadbackDetailResponseSchema.safeParse(successData(result));
  if (!parsed.success || parsed.data.order.orderId !== orderId) throw new Error("Reference journey readback detail did not match the expected order");
  return parsed.data;
}
function denial<T extends number>(result: Result, status: T, code: string): T {
  if (result.status !== status || !isRecord(result.body) || result.body.ok !== false || !isRecord(result.body.error) || result.body.error.code !== code) throw new Error("Reference journey readback negative control failed");
  return status;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
