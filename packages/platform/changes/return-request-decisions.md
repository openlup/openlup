- Return requests bind the authenticated customer to an owned order before
  command-key lookup. Fresh requests accept paid/fulfilled orders, with one line
  per item and quantity capped at the ordered quantity.
- New receipts normalize key/note whitespace, UUIDs, line order, SKU and
  disposition defaults. Historical receipts retain their stored fingerprint;
  historical NULL SKU means not recorded. Hosts declare a subset of stored reasons.
- Partial approval requires an amount. Approved/rejected decisions produce
  deduplicated intent events; request creation produces none. Receive, restock,
  provider refund and subscription lifecycle actions remain separate.

Migration: apply the complete native catalogue through
`20261110210000_return_request_decisions.sql`. Existing primitive headers and
privileges remain unchanged. Historical replay uses a bounded owned command;
there is no additional runtime SELECT grant on return lines.

Historical and canonical key aliases are resolved by operation type and stored
fingerprint version before creation. Unique matches replay their own request ID;
ambiguous matches refuse uniformly. A historical request cannot act as a decision
receipt through a suffixed key. Existing receipts are retained unchanged.
