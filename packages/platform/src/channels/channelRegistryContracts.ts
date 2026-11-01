
export type { ChannelScope } from "./contracts/index.js";
import { z } from "./validation.js";
import { channelCurrencySchema, channelCountryCodeSchema, connectorProviderKindSchema, externalRefSchema } from "./contracts.js";

export const CHANNEL_CONTROL_JSON_LIMITS = { maxDepth: 24, maxBytes: 262144,
  errors: { invalid: "channel_json_invalid", depth: "channel_json_depth", tooLarge: "channel_command_too_large" } };

// Read-only historical identities needed by captured order ingest. Registry authoring stays with the host.
export const channelControlIdSchema = z.guid().refine(value => value === value.toLowerCase(), "UUID must be lowercase");
export const channelControlRefSchema = z.string().refine(value => value.trim() === value, "reference must be unpadded").pipe(externalRefSchema);
export const channelControlDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const channelControlVersionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const channelControlTimeSchema = z.string().datetime({ offset: true });
export const channelScopeSchema = z.object({
  connectionId: channelControlIdSchema, channelId: channelControlIdSchema,
  connectorKind: connectorProviderKindSchema, sellerRef: channelControlRefSchema,
  environmentRef: channelControlRefSchema, connectionVersion: channelControlVersionSchema,
  registryVersion: channelControlVersionSchema, currency: channelCurrencySchema, regionCode: channelCountryCodeSchema,
}).strict();
