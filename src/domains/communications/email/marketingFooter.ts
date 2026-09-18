// Shared marketing-email footer: the RODO/CAN-SPAM one-click unsubscribe block
// that every marketing send MUST append. A divider followed by a muted inline
// link to the signed unsubscribe URL (built via buildUnsubscribeUrl). This is
// the only implementation; the Deno mirror it was byte-identical with (apart
// from import extensions) retired with the hosted-function tree on 2026-09-05.

import type { Locale } from "../../../lib/i18n/resolveLocale.js";
import { divider, linkParagraph, type EmailBlock } from "./blocks.js";

const UNSUBSCRIBE_COPY: Record<Locale, string> = {
  pl: "Nie chcesz tych wiadomości? Zrezygnuj.",
  en: "Don't want these? Unsubscribe.",
};

/**
 * Footer blocks for a marketing email: a hairline divider then a muted,
 * clickable unsubscribe link. Spread these onto the end of a content module's
 * block list. `unsubscribeUrl` is the absolute signed URL from
 * buildUnsubscribeUrl(purpose = 'marketing_newsletter').
 */
export function marketingUnsubscribeFooter(
  locale: Locale,
  unsubscribeUrl: string,
): EmailBlock[] {
  return [
    divider(),
    linkParagraph(UNSUBSCRIBE_COPY[locale], unsubscribeUrl, { muted: true }),
  ];
}
