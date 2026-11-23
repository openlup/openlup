### Consolidate starter catalogue declarations before demonstration installation

Move any still-used declarations and fixtures from `owned/catalogue.json` to
`catalogueConformance.packs` in `owned/catalogue.ts` and run
the starter’s `catalogue:check:source` npm script from your application root.
Upgrade leaves the old owned JSON bytes in place. After verifying the migration, remove a pristine copy manually and archive
or remove a customized copy. Independent inert JSON fixtures can use
`openlup catalogue check --packs` directly.

#### Convert the owned module from 1.3.0

The 1.3.0 starter exports only `catalogDraftRegistry`. Applying the upgrade
preserves the owned TypeScript and JSON files. Before starting the demo, edit
`owned/catalogue.ts` in your application. Keep your existing `types` array and
its validators. Add the `CatalogPackInput` type import from
`@openlup/platform/catalog`. Replace the single eager registry export with the
target starter's pack declaration, `catalogueConformance` export and lazy
registry block. Have the fixture pack use your retained `types` array. Move
any still-used drafts into their pack entries and keep their type references.
Run the source check and start the demo. Archive the retained JSON after
verifying the conversion.

Upgrade replaces a pristine `package.json` and removes the old
`catalogue:check` script. For a customized manifest, use the upgrade-conflict
workflow to reconcile the manifest, then switch local and CI calls to the
`catalogue:check:source` npm script. These steps supersede the dual-wrapper
instructions in the catalogue transport recipes.

Demo installation now uses each non-starter entry in declaration order. Use an
application-owned ID and namespace, update references together, and supply and
test `owned/catalogue-rules.cjs`. Give intentional changes to immutable pack,
type or profile definitions new versions. Run the source check, then run
`./lifecycle up` to rebuild the image and activate demo definition installation.
Applying application files alone performs no catalogue installation. See the
Platform release notes under “Handle typed catalogue definition install refusals”
for the experimental install and binding error changes.
