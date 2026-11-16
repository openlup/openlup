Document separate attribute/projection and V2 combination fixtures, trusted
reference and retained facts, and the async offline checker call.

Migration: Await `runCatalogExtensionConformance` in the matching unreleased
0.44.0 package set. Existing CLI invocations and the copied skeleton stay valid;
new fixtures are opt-in and never add fields to v1 drafts. No database migration,
publication or activation occurs.

The guide now specifies the plain-data boundary and
`conformance_input_not_plain_data` refusal (exit 1), including resolver results,
exact paths, alias capture, no getter execution and the exclusion of native binary
retained identities. Existing explicit callback handles remain trusted code.
