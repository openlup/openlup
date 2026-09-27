/**
 * Public/default owner of `#application-domains`: the domains a deployment adds
 * beside the platform's `CORE_DOMAINS` (`src/lib/coreDomains.ts`).
 *
 * The platform names none. An adopting deployment keeps its own domain
 * directories under `src/domains/<name>` or `server/domains/<name>` and points
 * `#application-domains` in its package.json `imports` at a module that exports
 * the same `APPLICATION_DOMAINS` list, naming those directories. Nothing else in
 * the platform changes.
 */
export const APPLICATION_DOMAINS: readonly string[] = Object.freeze([]);
