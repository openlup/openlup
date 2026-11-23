import type { HttpRequest } from "../types/http.js";
import {
  isInvalidTrustedProxyHopsError,
  readTrustedProxyHops,
  resolveClientAddress,
} from "../../runtime/observability/clientAddressResolver.js";

export function rateLimitClientAddress(req: HttpRequest, env = process.env): string {
  let trustedProxyHops: number | null;
  try {
    trustedProxyHops = readTrustedProxyHops(env);
  } catch (error) {
    if (!isInvalidTrustedProxyHopsError(error)) throw error;
    console.error(error.message);
    return "unknown";
  }
  return resolveClientAddress(req, { trustedProxyHops, env });
}
