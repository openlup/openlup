import { z } from "zod";

import { createPlatformBundleIdGuard, type PlatformBundleId, type PlatformCapability } from "./contracts.js";

/** @beta */
export interface PlatformBundleReadiness {
  ok: boolean;
  error?: string;
}

/** @beta */
export interface PlatformBundleDescriptor {
  id: PlatformBundleId;
  /** Declarative capability provider kind, bound by downstream composition. */
  capabilities: Record<PlatformCapability, string>;
  readReadiness(env: PlatformEnvInput): PlatformBundleReadiness;
}

/** @beta */
export type PlatformEnvInput = Record<string, string | undefined>;

/** @beta */
export const platformEnvSchema = z.object({
  PLATFORM_BUNDLE: z.string().trim().min(1).optional(),
  APP_BASE_URL: z.string().url().optional(),
});

/** @beta */
export type PlatformEnv = z.infer<typeof platformEnvSchema>;

/** @beta */
export interface PlatformBundleRegistry<TId extends string = PlatformBundleId> {
  readonly defaultBundleId: TId;
  readonly bundleIds: readonly TId[];
  readonly descriptors: readonly PlatformBundleDescriptor[];
  isBundleId(value: unknown): value is TId;
  resolveBundleId(env: PlatformEnvInput): TId;
  getBundleDescriptor(id: TId): PlatformBundleDescriptor;
}

/** @beta */
export interface CreatePlatformBundleRegistryInput<TId extends string = PlatformBundleId> {
  descriptors: readonly PlatformBundleDescriptor[];
  defaultBundleId: TId;
}

/** @beta */
export function createPlatformBundleRegistry<const TIds extends readonly string[]>(
  input: {
    descriptors: readonly (PlatformBundleDescriptor & { id: TIds[number] })[];
    defaultBundleId: TIds[number];
  },
): PlatformBundleRegistry<TIds[number]> {
  const bundleIds = input.descriptors.map((descriptor) => descriptor.id) as unknown as TIds;
  const isBundleId = createPlatformBundleIdGuard(bundleIds);
  const descriptorsById = new Map<TIds[number], PlatformBundleDescriptor>();

  for (const descriptor of input.descriptors) {
    if (descriptorsById.has(descriptor.id)) {
      throw new Error(`Duplicate platform bundle descriptor: ${descriptor.id}`);
    }
    descriptorsById.set(descriptor.id, descriptor);
  }

  if (!descriptorsById.has(input.defaultBundleId)) {
    throw new Error(`Default platform bundle is not declared: ${input.defaultBundleId}`);
  }

  return {
    defaultBundleId: input.defaultBundleId,
    bundleIds,
    descriptors: input.descriptors,
    isBundleId,
    resolveBundleId(env) {
      const raw = env.PLATFORM_BUNDLE;
      return isBundleId(raw) ? raw : input.defaultBundleId;
    },
    getBundleDescriptor(id) {
      const descriptor = descriptorsById.get(id);
      if (!descriptor) {
        throw new Error(`Unknown platform bundle descriptor: ${id}`);
      }
      return descriptor;
    },
  };
}
