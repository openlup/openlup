# Cosmetics catalogue pack

This fictional fixture preview uses 30 ml ivory and 50 ml sand foundation. Prepare and install
an [independent starter with matching candidate packages](../../neutral-store/README.md)
using its candidate extraction recipe. Keep the existing `owned/catalogue-rules.cjs`.

1. From the starter root, set `REFERENCE_PACK_DIR` to this example directory and
   run `cp "$REFERENCE_PACK_DIR/pack.ts" owned/cosmetics-pack.ts`. Check that
   `owned/cosmetics-pack.ts` is byte-for-byte identical to the example.
2. Edit `owned/catalogue.ts` as shown. Keep the existing entries and lazy
   registry. Add the import at the top, widen the pack list on its closing line,
   and append the new entry after the existing declarations.

   ```diff
   +import { referenceEntry as cosmetics } from './cosmetics-pack.ts';
   -  }, skus: [] }] }],
   +  }, skus: [] }] }] as { pack: CatalogPackInput; drafts: unknown[] }[],
   +catalogueConformance.packs.push(cosmetics);
   ```

   Run `npx --no -- openlup catalogue project --trusted-packs ./owned/catalogue.ts --json`.
   Expect exit 0 and JSON `"state":"satisfied"`. For this reference entry, expect neither
   `advisory_net_content_not_publishable` nor `advisory_unit_identifier_missing`.
   The existing starter fixture uses schema version 1 and has its own advisories.
3. Run `./lifecycle up` in the PostgreSQL sandbox. Expect exit 0 and a healthy
   local application. Run
   `curl --fail --silent --output /dev/null --write-out '%{http_code}\n' http://127.0.0.1:4319/api/config`
   and expect `200`.

Applying products to the storefront and checking them in a browser follow in a later release.
