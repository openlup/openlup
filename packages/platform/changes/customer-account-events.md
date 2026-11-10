- Add owned account history, customer profile edits and acknowledged invoice correction requests. Profile replay uses recorded event keys and returns current state; its write and event append remain separate commits. Correction request keys are stored without deduplication.
- Add an explicit account-event privacy contributor and exact-row finite transfer classification. Event payloads may contain personal data; identity field clearing does not erase them. Export reports unavailable coverage. Erasure requires a configured reader and an explicit retain assessment; the retention receipt preserves payloads even when that reader reports unavailable export coverage. Missing reader or unresolved disposition refuses erasure.

- Package inventory includes the account-event source, SQL and guidance; the larger merged package caps are retained.

Migration:

Install the complete selected native prefix through `20261110120000_customer_account_events.sql`, bind the authenticated principal/client scope and validation policy, and register the privacy contributor. Saved addresses, billing profiles and starter editors remain separate work.
