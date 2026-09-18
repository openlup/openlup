import { createHmac } from 'node:crypto';

/** One-way hash of client IP via HMAC SHA256. Truncated to 32 chars (still
 *  collision-safe at our scale) so the events table stays compact. */
export function hashIp(ip: string): string {
  const secret = process.env.IP_HASH_SECRET;
  if (!secret) return 'unhashed:' + ip.slice(0, 16); // fail-soft for missing secret
  return createHmac('sha256', secret).update(ip).digest('hex').slice(0, 32);
}

/** Classify User-Agent into a coarse bucket. Avoids storing the raw UA
 *  (browser fingerprint surface) while still letting us spot bot abuse. */
export function classifyUserAgent(ua: string | undefined): 'bot' | 'mobile' | 'desktop' {
  if (!ua) return 'bot';
  const lower = ua.toLowerCase();
  // Common bot patterns
  if (/bot|crawl|spider|slurp|fetch|curl|wget|python|go-http|httpie|postman|insomnia|axios\/|node-fetch|libwww/.test(lower)) {
    return 'bot';
  }
  // Mobile indicators
  if (/iphone|ipad|android|mobile|webos|blackberry|windows phone/.test(lower)) {
    return 'mobile';
  }
  return 'desktop';
}
