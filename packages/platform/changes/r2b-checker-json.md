Integrate attribute validation/projection and V2 combination owners into the
offline catalogue checker. Replace executable subjects with JSON text and the
copied executable skeleton with one static JSON fixture. Reference and refusal
observations are checked without invoking caller code; retained identities are
derived from fixture options and prove no persisted bytes or history.

Migration: For the unreleased 0.44.0 set, migrate module-based callers to
`await runCatalogExtensionConformance(JSON.stringify(subjectData))` and CLI files
to `openlup catalogue check --packs ./owned/catalogue.json --json`. Omit
`validateContent`; requested application content validation is unavailable (2).
Replace refusal callbacks with `observedCode` and `zeroEffects` records, reference
ports with resolution rows, and retained identity bytes with options. The single
entry retains report fields, deterministic ordering and the five CLI exits.
No SQL, publication, subscription changes or capability activation occurs.

Primitive quantity fields are admitted before owner handoff. Only deliberate
owner input errors in the checker's explicit code allowlist become input refusals
(exit 1 at the input path). All other owner exceptions propagate unchanged;
the direct promise rejects and the CLI returns 74 with raw errors withheld.
Default failure is 74; only the tagged `JSON.parse` site gives 64. Integrity codes
are never input-denial codes and propagate to CLI 74. API signatures, SQL and
release caps are unchanged by this checker repair.
