Document separate attribute/projection and V2 combination fixtures, trusted
reference and retained facts, and the async offline checker call.

Migration: Await `runCatalogExtensionConformance` in the matching unreleased
0.44.0 package set. Existing CLI invocations and the copied skeleton stay valid;
new fixtures are opt-in and never add fields to v1 drafts. No database migration,
publication or activation occurs.
