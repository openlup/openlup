### Fixed

- Rank installed reader-guide recipes and upgrade narrative sections above generated `### \`packages/*/api/*.api.md\`` diff blocks in `openlup-context search`, cap repeated API-report diff matches to one per upgrade file unless `.api.md` is queried explicitly, match `PascalCase` and `UPPER_SNAKE_CASE` declaration symbols in multi-word queries, and raise the per-package declaration and source scan limit from 1,200 to 2,000 files.

Migration: no API, runtime or SQL changes. `openlup-context search` result shapes and CLI flags are unchanged; `scans[].fileLimit` for `declarations` and `package-source` is now `2000`.
