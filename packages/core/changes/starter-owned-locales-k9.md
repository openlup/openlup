### Changed

- Document the source starter's owned language registry, configured default and named startup copy refusals. The current platform language set remains `en` and `pl`.

Migration: Existing source-starter adopters add `market.defaultLocale` and compose the owned `market` registry from `owned/market.config.ts`. Keep `locales: ['en', 'pl']` and `defaultLocale: 'en'` for the previous demonstration behavior. This documentation change adds no npm API or SQL migration.
