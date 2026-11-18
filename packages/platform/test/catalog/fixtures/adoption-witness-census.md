# Catalogue adoption witness census

Each input varies from a verified control. A command refusal leaves the head, facts, obligations and receipt tables unchanged. A read refusal returns no partial evidence. The managed protocol cases exercise the existing authority adapter. They do not grant managed writer capability.

| Rule | Class and paths | Isolating input | Expected result |
| --- | --- | --- | --- |
| LC8-D-001 | Binding · native and managed | Native selected without its executor while managed is available | Unsupported native capability and zero managed calls |
| LC8-D-002 | Binding · managed head | Zero rows, two rows, current head missing digest, prior head with partial state, unknown transport failure | Invalid response for each malformed result, dependency unavailable for transport failure |
| LC8-D-003 | Binding · readiness | Empty codes, duplicate codes, 101 codes, malformed digest, swapped order, wrong count, wrong head, ready without identity, ready without physical reference | Invalid query per ingress predicate, authority changed per mismatched anchor, invalid response per incoherent result |
| LC8-D-004 | Actor · operator and adoption | Invalid session, no user, non-admin, machine true, missing machine flag | Unauthorized in each case. Confirmed human admin succeeds |
| LC8-D-005 | Actor · managed registration and native seal | Change supplied digest alone, swap registration response identity, read zero then two candidate rows, repeat valid registration | Digest mismatch, response mismatch, absence, invalid response, existing record respectively. Native seals the verified observation directly |
| LC8-D-006 | Transaction · commit | Invalid scope, digest or command key alongside unauthorized actor. Then reuse a valid key with a different authorized actor | `catalog_adoption_command_invalid` before actor check per bad field. `catalog_adoption_command_key_reused` for changed actor |
| LC8-D-007 | Transaction · commit and recovery | Replay after advancing head, change sealed digest alone, reuse a decision key | Byte-identical receipt with replay outcome, then `catalog_adoption_command_key_reused` in both collision cases |
| LC8-D-008 | Transaction · managed approval and native commit | Missing candidate, wrong kind, zero approvals, two approvals, prior use. Native missing approved digest | Managed authority refuses absent, wrong kind, non-unit balance and prior use respectively. Native rejects missing approved digest |
| LC8-D-009 | Transaction · commit | Hold conflicting authority lock, then race two valid commands on one scope | `catalog_adoption_busy` while locked, one committed receipt and one `catalog_adoption_already_published` in the race |
| LC8-D-010 | Transaction · preflight and commit | Change one source fact after preflight, supply wrong digest, remove an existing head while retaining lineage | `catalog_adoption_source_changed` for either digest mismatch, lineage refusal for corrupt head. Exact unchanged source admits |
| LC8-D-011 | Transaction · preflight and commit | Absent document pointer, wrong product document, changed document digest | Document unavailable for absent or wrong scope, source changed for an otherwise valid changed document after approval |
| LC8-D-012 | Facts · preflight and commit | Duplicate normalized identifier, SKU from another product, foreign primary SKU, missing required physical fact | `catalog_adoption_identity_conflict` for identifier or identity mismatch. `catalog_adoption_facts_invalid` for missing facts |
| LC8-D-013 | Transaction · commit and recovery | Adopt two exact SKUs with existing prices and a document | One revision 1, one receipt and correct actor; source IDs, rows and money preserved |
| LC8-D-014 | Managed · head parity and adoption | Release before recognized adoption, second adoption, prohibited state operation | Existing managed protocol refusals. Native adoption accepts verified source only |
| LC8-D-015 | Managed · membership and current head | Wrong base, change live product or SKU fact, extra or missing membership, changed frozen roster | Exact matching source and membership are required. Managed rejects representation and frozen-roster changes |
| LC8-D-016 | Transaction · commit and replay | Fail receipt insert after writing revision, retry successfully and replay | All staged adoption rows roll back. Success then replay returns identical persisted result |
| LC8-D-017 | Binding · observed authority | Unavailable head, genuinely unadopted scope, recognized prior protocol, changed live state with same anchor | Dependency unavailable, unadopted or recognized prior protocol as appropriate. Drift refuses |
| LC8-D-018 | Facts · preflight and commit | Two overlapping effective price windows; adjacent-window control | `catalog_adoption_price_overlap` for overlap. Adjacent windows accepted under existing price rules |
| LC8-D-019 | Binding · payment and editor lanes | Advance head after binding; repeat with absent governed proof | Existing accepted-reference refusal from the effect owner with zero commerce mutations |
| LC8-D-020 | Legacy · order and renewal | Snapshot frozen history and terms before adoption, then read and renew | Identical historical bytes and accepted amount, units, SKU and schedule. Existing settlement replay returns its stored result |
| LC8-D-021 | Managed · retired writer | Register, decide and publish through retired protocol after adoption, then read authoritative head | All three writes refuse as protocol inactive. Verified head remains readable |
| LC8-D-022 | Managed · legacy fence | Create, update, archive and price writes before and after explicit disable | `legacy_catalog_mutation_fenced` (42501) in every stage |
| LC8-D-023 | Actor · SQL and managed transport | Public, runtime and support direct commit, direct receipt write, and machine publish | SQL 42501 on forbidden operations. Restricted role has only its granted lane |
| LC8-D-024 | Binding · qualification | Missing dependency, verified empty scope, matching head with partial membership | Unavailable, qualified empty, identity mismatch respectively |
| LC8-D-025 | Facts · canonical source | Duplicate code, unknown type, nonresolving type version, ambiguous scope | `catalog_adoption_identity_conflict` for duplicate, `catalog_adoption_type_unavailable` for unknown or mismatched installed definition, input refusal for unknown scope |
| LC8-D-026 | Binding · quote batch | Owner changes between two evaluations; first-read failure control | Shared observation or shared refusal with one read. Effect owner independently verifies anchor |
| LC8-D-027 | Transaction · lineage | Concurrent adoption and draft publication against the same first-source state; exact command retry | At most one first publication, with stable adoption receipt on an exact retry if adoption wins |
| LC8-D-028 | Binding · prior protocol fallback | Missing method, permission fault, malformed old head, verified old head | Only missing method can read prior protocol. Permission is unavailable, ambiguous is invalid, verified prior evidence never elevates writer capability |
| LC8-D-029 | Managed · legacy adapter | Omit update fields in a legacy call with writer enabled | `legacy_catalog_mutation_fenced` (42501) and no publisher call |
| LC8-D-030 | Facts · digest and shape | Wrong digest plus malformed JSON, correct digest plus malformed JSON, partial document triple, explicitly null prior triple | Digest mismatch first, then shape refusal for malformed JSON and partial triple. Prior null triple recognized; native adoption requires a present document |
| LC8-D-031 | Facts · canonical roster | Reverse sorted identities, duplicate code, omit nullable key, explicit nullable value, string flag, foreign primary | Invalid shape for each mutation except the legal explicit null |
| LC8-N-001 | Binding · host and ACL | Omit implementation, schema, grant or opt-in individually; fail live call separately; disable writes on otherwise qualified install | Feature false per missing prerequisite, bound outage reports dependency unavailable, read and servicing stay qualified on disable |
| LC8-N-002 | Transaction · publication and receipt | Existing document/SKU/price and no draft or head | Kind `adopted_existing`, revision 1, null predecessor and draft link, exact source and kind `adoption` receipt. Explicit dialect in history and recovery |
| LC8-N-003 | Legacy · obligation census | Unresolvable active obligation and then an exact legacy identity control | `catalog_adoption_unbound_obligation` with zero effects. Exact obligation gains one legacy binding while the stored agreement is byte-identical |
| LC8-N-004 | Legacy · edit, renewal and stock wait | Compatible presentation change, material quantity/type change, inconclusive evidence, ordinary and stock-wait renewal after disable | Compatible admits when owner permits; material and inconclusive return `sku_identity_change_requires_new_sku`. Renewals use original held terms and dates |
| LC8-N-005 | Binding · transfer and recovery | Restore a draft receipt and an adopted lineage, then enable and disable only the writer | Exact old receipt and new typed recovery. Retained facts and acquired subscriptions still resolve and the legacy fence still refuses |

The schema witness compares the installed source discriminant, draft/source pairing, binding identity constraints, immutable triggers and grants as one exact shape. Transaction cases cover zero effects for each isolated refusal.

| Contract choice | Discriminating witness |
| --- | --- |
| C-READY | N-001 and D-017 distinguish enabled, unadopted, unsupported and unavailable per capability |
| C-ADOPT | N-002 and D-010 require a kinded initial revision and an approved digest rechecked against locked facts |
| C-LEGACY | N-003 and N-004 require explicit side provenance and shared obligation and materiality checks |
| C-MANAGED | D-015 and D-028 require a single authoritative head with exact scoped membership |
