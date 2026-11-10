- Add a private customer address book with owned read/save/canonical-reuse/default/delete ports, existing account events and explicit privacy/finite-transfer coverage. Subscription usage pointers support active/paused deletion refusal; saved-address selection and preference consumption remain separate.

Migration:

Install the full selected native catalogue through `20261110190000_customer_saved_addresses.sql`. Select `shipping/postgres` and host validation/copy/readers explicitly. Clear, write and event append remain separate commits; replay reads current state. Foreign/missing entity deletion remains a zero-row acknowledgement. The saved-address privacy owner erases saved rows; account-event retention and immutable destination ownership remain separate.

Documentation and unpacked-content caps add 2% headroom for the new storage, API and guide footprint; the packed cap and released baseline are retained.
