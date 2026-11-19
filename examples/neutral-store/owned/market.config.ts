import type { Locale as PlatformLocale } from '@openlup/platform/communications/contracts';

/** Application-owned language registry; the current platform supports en and pl. */
export const market = {
  locales: ['en', 'pl'],
  defaultLocale: 'en',
} as const satisfies { locales: readonly PlatformLocale[]; defaultLocale: PlatformLocale };
