import type { CiImage, OwnedCiImage } from "./ci-image-mirror.mjs";

export type ImageIo = {
  exec: (args: string[], timeout?: number) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

export const IMAGE_PULL_BUDGET_MS: 300000;
export const IMAGE_PULL_ATTEMPTS: 3;
export const IMAGE_PULL_FALLBACK_RESERVE_MS: 60000;
export const imageIo: ImageIo;
export function readCiImages(): OwnedCiImage[];
export function readCiImage(name: string): OwnedCiImage;
export function imageReference(image: CiImage, source?: string): string;
export function mirrorUnavailable(source: string, message: string): boolean;
export function resolvePinnedImage(image: CiImage, reference: string, io?: ImageIo): Promise<string>;
export function pullWithRetry(image: CiImage, io?: ImageIo, budgetMs?: number): Promise<string>;
