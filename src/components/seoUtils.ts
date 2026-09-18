import { APP_SITE_ORIGIN } from "@/lib/brand/appBrand";

const SITE = APP_SITE_ORIGIN;

export type OgVariant =
  | "home"
  | "lamb"
  | "venison"
  | "beef"
  | "turkey"
  | "salmon"
  | "pork";

export const absUrl = (path: string) =>
  path.startsWith("http") ? path : SITE + (path.startsWith("/") ? path : "/" + path);

export const ogImageFor = (variant: OgVariant, size: "og" | "twitter" | "square" = "og") =>
  SITE + "/og/og-" + variant + "-" + size + ".jpg";
