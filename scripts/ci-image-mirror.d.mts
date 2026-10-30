export type ImageCoordinates = { repository: string; tag: string };
export type CiImage = ImageCoordinates & { digest: string; sources: string[] };
export type OwnedCiImage = CiImage & { name: string };
export type ResolvedImage = { source: string; target: string; digest: string };
export type RegistryInspect = (reference: string) => string | null;

export const MIRROR_REGISTRY: "ghcr.io/openlup";
export function ownedImages(config: unknown): OwnedCiImage[];
export function inspect(reference: string): string | null;
export function resolveImage(image: CiImage, registryInspect?: RegistryInspect): ResolvedImage;
export function mirrorImage(
  image: ResolvedImage,
  registryInspect?: RegistryInspect,
  copy?: (source: string, target: string) => void,
): "skipped" | "copied and verified";
export function resolvePlan(config: unknown, registryInspect?: RegistryInspect): ResolvedImage[];
export function mirrorImages(images: ResolvedImage[]): void;
