import { copy } from '../owned/copy.ts';
import { editorCopy } from '../owned/editor-copy.ts';
import { quoteCopy, quoteRefusalCopy } from '../owned/quote-copy.ts';
import { acquisitionAddresses } from '../owned/acquisition-addresses.ts';
import { nativeLimits, operationLimitDefinitions } from './limits.ts';
import { assertLocaleCopy, assertLocalized } from './locales.ts';
import { copyKeys, editorCopyKeys, quoteCopyKeys, quoteRefusalKeys } from './copy-keys.ts';
import type { StoreConfig } from './config.ts';

/** Startup checks the same owned copy consumed by the host and browser. */
export function assertStarterCopy(config: StoreConfig): void {
  const locales = config.market.locales;
  for (const [path, registry, keys] of [
    ['copy', copy, copyKeys], ['editorCopy', editorCopy, editorCopyKeys],
    ['quoteCopy', quoteCopy, quoteCopyKeys], ['quoteRefusalCopy', quoteRefusalCopy, quoteRefusalKeys],
  ] as const) {
    assertLocaleCopy(registry, locales, path, keys);
  }
  for (const [path, section, keys] of [
    ['brand', config.brand, ['strapline', 'description']],
    ['copy', config.copy, ['heroTitle', 'heroBody', 'offerTitle', 'offerBody']],
    ['media', config.media, ['heroAlt']],
    ['purchase.recoveryMessage', config.purchase?.recoveryMessage, ['subject', 'body', 'expiryLabel', 'orderLabel']],
  ] as const) {
    for (const key of keys) assertLocalized((section as Record<string, unknown> | undefined)?.[key], locales, `${path}.${key}`);
  }
  for (const [path, products] of [['offer.products', config.offer.products], ['subscriptionEditing.catalogue', config.subscriptionEditing.catalogue]] as const) {
    for (const [index, product] of products.entries()) {
      for (const key of ['name', 'description', 'details', 'mediaAlt'] as const) assertLocalized(product[key], locales, `${path}[${index}].${key}`);
    }
  }
  for (const [path, choices] of [['returns.reasons', config.returns?.reasons], ['orderControls.holdReasons', config.orderControls?.holdReasons],
    ['acquisitionAddresses', acquisitionAddresses]] as const) {
    for (const [index, choice] of (choices ?? []).entries()) assertLocalized(choice.label, locales, `${path}[${index}].label`);
  }
  for (const limit of [...nativeLimits, ...Object.values(operationLimitDefinitions)]) {
    assertLocalized(limit.explanation, locales, `limits.${limit.id}.explanation`);
  }
}
