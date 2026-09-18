// A guide card in a fulfillment mail: the selected copy pack names the guide by
// a site-relative path, and the sender knows the site origin, so this is the
// one place the two are joined into the absolute links a mail client needs.

import type { EmailGuideCardCopy } from "./commerceEmailContent.js";
import { featureCard, type FeatureCardBlock } from "../../communications/email/blocks.js";

// Exactly one slash at the seam, whichever side carries it.
function siteUrl(siteOrigin: string, path: string): string {
  return `${siteOrigin.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export function guideCardBlock(
  copy: EmailGuideCardCopy,
  siteOrigin: string,
  contextName: string | null,
): FeatureCardBlock {
  return featureCard({
    eyebrow: copy.eyebrow,
    title: copy.title,
    text: copy.text(contextName),
    cta: { label: copy.cta, href: siteUrl(siteOrigin, copy.path) },
    ...(copy.image
      ? {
          image: {
            src: siteUrl(siteOrigin, copy.image.path),
            alt: copy.image.alt,
            widthPx: copy.image.widthPx,
            heightPx: copy.image.heightPx,
          },
        }
      : {}),
  });
}
