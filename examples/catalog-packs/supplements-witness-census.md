# Supplements reference pack witness census

The tables name the isolated inputs for the three parameterized witnesses. Values
are frozen independently of the draft recipe. Run the native operator and
agreement rows against the composed installation with installed packages.

| Witness | Rule | Isolating input | Expected owner result or observation |
| --- | --- | --- | --- |
| `supplements_pack_artifact_matrix` | RP1-D-002a | Valid capsule and powder documents | Exact synthetic ingredient, fact, allergen, warning, claim and evidence values |
| | RP1-D-002b | One absent evidence field | `evidence_required` at `document.evidence` |
| | RP1-D-002c | Filter by capsule, leaving powder unchanged | Only the capsule; internal evidence stays outside public attributes |
| | RP1-D-003a | Extract the pack from the candidate, enumerate the registry | One supplements entry and all five owned paths |
| | RP1-D-003b | Replay definition installation | Same manifest and type digests, zero product, SKU, price and publication rows |
| | RP1-D-003c | Change only the manifest digest at the same pack version | `catalog_definition_install_conflict` |
| | RP1-D-003d | Increment the pack version and change the existing type definition | `catalog_type_install_refuses_redefinition` |
| | RP1-D-003e | Run definition install as runtime role | SQLSTATE `42501`, zero definition writes |
| | RP1-D-004a | Convert 56 capsules to canonical count | 56 `openlup:piece` |
| | RP1-D-004b | Convert 140 g to canonical mass | 140 `openlup:g` |
| | RP1-D-004c | Read declared serving count and serving form | 28 each, capsule pair and scoop respectively; 5 g host scoop fact |
| | RP1-D-004d | Convert capsule count directly to grams | `quantity_cross_dimension` |
| | RP1-D-004e | Read capsule, powder and successor gross masses and formats | 92 g, 172 g and 96 g; capsule, powder, capsule |
| | RP1-D-007a | Resolve the declared class default and market asset | `reduced-supplement`, one ZZ/XTS zero-bps row effective 2026-01-01 through 2027-01-01 exclusive |
| | RP1-D-007b | Read authored taxonomy before operator actions | Two child categories and one collection; zero merchandising or tax-rate activations |
| | RP1-D-010a | Check each path in the reference and starter copies | Exact bytes and relative imports confined to the pack or public packages |
| | RP1-D-010b | Apply an upgrade with an edited owned pack | Exact edited bytes retained; divergent newly created path refuses before writes |

| Witness | Rule | Isolating input | Expected owner result or observation |
| --- | --- | --- | --- |
| `supplements_draft_transition_matrix` | RP1-D-001a | Published item with wrong document identity | `catalog_publication_manifest_invalid` at the native reader, no partial items. Integrated serving refuses the changed authority. |
| | RP1-D-001b | Published item with wrong SKU identity | `catalog_publication_sku_revision_invalid` at the native reader, no partial items. Integrated serving refuses the changed authority. |
| | RP1-D-005a | Two v3 draft creates and exact retry | Two immutable drafts; identical retry replays, zero public visibility |
| | RP1-D-005b | Withdraw capsule with v4 and valid approval | New purchase refused; old agreement and historical SKU retained |
| | RP1-D-005c | Approve v5 successor with new immutable SKU and identifier | Explicit predecessor and successor, 2,800 → 3,080 minor, no automatic substitution |
| | RP1-D-011a | Decision using the wrong human actor | `catalog_publication_operator_mismatch`, zero publication writes |
| | RP1-D-011b | Expired human verification | `publisher_not_authorized`, zero publication writes |
| | RP1-D-011c | Repeat an approved publish with identical command and actor | Same receipt and one publication |

| Witness | Rule | Isolating input | Expected owner result or observation |
| --- | --- | --- | --- |
| `supplements_policy_and_upgrade_matrix` | RP1-D-006a | One of each SKU at the pinned quantities and cadence | Two independent exact 28-day coverages; no pooling |
| | RP1-D-006b | Missing host attestation with 18+ flag | `age_attestation_required`, zero accepted effects |
| | RP1-D-006c | False host attestation with 18+ flag | `age_attestation_required`, zero accepted effects |
| | RP1-D-006d | Valid basket with prepaid requested | `prepaid_unsupported`, zero accepted effects |
| | RP1-D-006e | Same quantities at 27 days | `cadence_not_allowed` |
| | RP1-D-006f | 55 capsule pieces and original powder | `line_coverage_mismatch` |
| | RP1-D-008a | Add v2 with explicitly mapped `label_language` | Both version digests resolve; v1 bytes and accepted terms unchanged |
| | RP1-D-008b | Omit only the new required field from v2 | `attribute_required_missing` at `/productAttributes/label_language` |
| | RP1-D-008c | Repeat v2 mapping from the extracted source | Identical authored data and digests |
| | RP1-D-007c | Two-line purchase, renewal and explicit successor comparison | 7,000 / 7,000 / 7,280 XTS minor, 0 shipping and tax, 28 days |

## Frozen bookends

- Compatible package range `^1.3.0` targets the first minor after 1.2.0.
- Effective instant and first cycle anchor 2026-11-19T12:00:00.000Z.
  Next anchors 2026-12-17T12:00:00.000Z and 2027-01-14T12:00:00.000Z.
- XTS exponent 2, active subscription gross prices at minimum quantity 1,
  one unit per line, with the existing price owner using zero discount and a
  ten-minor-unit rounding quantum. In order: G1-CAPS-56 2,800, G1-POWDER-140 4,200,
  G1-CAPS-NEXT-56 3,080. Zero discounts, delivery and tax in the fixture.
  Existing starter defaults are in `examples/neutral-store/owned/store.config.ts:46-52,96-99`.
- UUIDs `00000000-0000-4000-8000-0000000001NN` use suffixes 10–13,
  20–23 and 30–33 for the three products (product, SKU, document, draft
  in that order). Synthetic identifier issuer `fixture:supplements` and
  one value per SKU. Evidence identifiers `fixture:supplements/capsule/1`,
  `fixture:supplements/powder/1`, `fixture:supplements/capsule-next/1`.
- The test vectors describe synthetic data only. D-009 excludes other application
  variants. The installed guide skeleton belongs to the transport change.

## Rule provenance

RP1-D-001, D-002 and D-011 preserve the deployed identity/cardinality checks,
the separation of document facts from offer facts, and the verified human
decision/publish boundaries. See the corresponding authority checks in
`packages/platform/src/catalog/commerceQuoteCatalogRead.ts:64-93,140-154`,
`packages/platform/src/catalog/draftV3Schemas.ts:25-38`, and
`packages/platform/src/catalog/publicationStore.ts:139-150,248-285`. The adaptations use the existing publication
read, shared-content and operator contracts, respectively. RP1-D-003 through
D-008 and D-010 are synthetic application data, registration and extraction
proof. The existing quantity, attribute, profile, price and upgrade owners
validate these fixtures. C06 selects a synthetic age attestation and an executed
prepaid refusal. C07 selects the reference directory as the authored source,
copy parity and a typed v3–v5 recipe with retained v1 type definitions.
The recipe first saves v3 drafts, then supplies v4 revisions for publication.
That preserves the lifecycle authority required by withdrawal without
reinterpreting the stored v3 drafts. The authored price command uses the
existing gross base writer; the synthetic subscription price is derived
with the existing zero-discount policy. Source references are
`supplements/catalogue.ts:70-141`, `supplements/fixtures.ts:8-49` and
`supplements/policy.ts:14-63`.
