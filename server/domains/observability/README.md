# Diagnostic history domain

Owns server-issued append capabilities, payload fingerprints and the diagnostic
history port. It derives no business outcomes from browser observations.

The RPC adapter performs bounded atomic storage and retained audited reads through
both data runtime bindings. Public ingress verifies origin/auth and enforces
admission before issuing identity segments. See the shared closed contract in
`src/domains/observability` and `docs/platform/RUNTIME_AND_SELF_HOSTING.md` for interpretation,
coverage omissions and the separate hosted activation requirements.
