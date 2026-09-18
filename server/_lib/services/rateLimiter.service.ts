// IP rate limiter — thin shim over the default in-memory RateLimiterPort adapter (W4.5).
//
// The decision logic + the pluggable in-memory / Postgres adapters now live in rateLimiterPort.ts.
// This module keeps the ORIGINAL export shape (`rateLimiter.check(ip, now?) -> RateLimitDecision`,
// synchronous) so every caller — notably api/process.ts and its golden-master — is byte-identical.
// The default singleton is the in-memory adapter, preserving exact Vercel behavior.
//
// A node-* multi-instance bundle should construct `createPgRateLimiter(...)` from rateLimiterPort.ts
// at its composition root instead of importing this singleton.

import {
  createInMemoryRateLimiter,
  type RateLimitDecision,
} from "./rateLimiterPort.js";

export type { RateLimitDecision } from "./rateLimiterPort.js";

const defaultLimiter = createInMemoryRateLimiter();

export const rateLimiter = {
  check(ip: string, now: number = Date.now()): RateLimitDecision {
    // The default adapter is synchronous; the cast narrows the port's union return for callers
    // that depend on the historical synchronous contract.
    return defaultLimiter.check(ip, now) as RateLimitDecision;
  },
};
