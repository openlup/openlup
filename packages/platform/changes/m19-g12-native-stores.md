### Native OMS, returns and support store bindings

Expose the existing PostgreSQL OMS control, reduced control-plane, delivered
system-hold recovery, returns and customer-support journey stores through explicit
platform subpaths. Reference imports delegate to the same factories and error
constructors. Portable support read schemas have a separate browser-safe entry;
the existing contracts entry remains type-only. Existing SQL, replay and named
refusal boundaries are preserved. No rich OMS projection or diagnostic store is
added.

Migration: Existing source imports remain thin facades. Installed consumers select
`commerce/server/postgres`, `account-support/postgres` and, for browser validation,
`account-support/read-contracts`. Supply the existing restricted runtime executor
or connection and trusted operator context; select the optional `pg` peer for
connection-owning stores. No SQL or data migration is added. Rich OMS projections
and the existing unsupported commands retain their refusals.
