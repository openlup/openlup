- Add actor-owned account choices, grants and withdrawals for the independent
  newsletter and gifts-and-discounts marketing purposes, with durable provenance,
  suppression precedence and idempotent replay. Retain consent history and trusted
  sync target configuration through connected native-store capture and restore.
- Record withdrawals locally even when the email or sync target is unusable;
  successful withdrawals can return a null `workId`. Provider sync requires a
  usable recipient and enabled target. Replay never backfills deferred work.

Migration: apply `20261101232000_customer_account_consents.sql` through the
selected native migration sequence before using these actor routines. Use the
owner-documented unsynced-denial query to inspect withdrawals without work;
reconcile current choices before provider action. Existing actor setters retain
their served behavior. This introduces no provider retry worker or erasure path.
