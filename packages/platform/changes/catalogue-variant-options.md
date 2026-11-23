Declare each variant option once with the experimental `catalogVariantOptions`
helper in `@openlup/platform/catalog`. The offline checker reports the actual
fixture locations for combination issues and advises on unmatched variant
attributes and Platform version ranges.

Migration: Check pack definitions before upgrading. Definition admission,
including registry construction and definition digest calculation, now refuses
axes with mismatched declarations or repeated attribute assignments. This
includes declarations with overlapping choice IDs or units. For example, an
axis with `[a,b]` on its dimension and `[a,c]` on its attribute previously
accepted `a` as an individual option. This release cannot register an installed
type version with either issue. There is no in-place migration. A corrected
new version still leaves the upgrade blocked while the affected version stays
composed. If your pack is affected, stay on the previous release.
