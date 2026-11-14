- Add optional neutral fulfillment capability declarations, readiness refusals and native execution probes. Existing adapter operation flags and outputs remain unchanged; no unsupported native lifecycle operation becomes implemented.
- Add selected-intake dispatch ACK composition, snapshot-only stock synchronization and compatible receipt/observation aliases.

Migration: install the complete selected SQL catalogue through `20261120100000_fulfillment_intake_channel.sql` before using the updated native dispatch store. Polling hosts pass the selected intake declaration to native ACK composition; omitted intake remains push and existing accepted receipts retain their channel.

Migration: omitted descriptor fields preserve existing behavior. Provider-owned reservations and provider-managed consumption now have explicit readiness refusals. Explicit `stockMovements: false` selects snapshots with a separate movement refusal and preserves the movement watermark; absent retains movement reads. Pass the declaration to the stock worker.

Migration: `transportSelection: "provider"` admits nullable native parcel carrier/service; saved customer preferences still require strings. PDF remains the sole supported label document format. Independent split, standalone pickup/locker, native label create/void and remote cancel requests remain named limits.

Migration: optional `receiptKey` must equal required legacy `labelKey` byte-for-byte. Neutral observation status aliases `code`/`detailCode` coexist with required legacy `primary`/`subStatus`; neutral shipment event kinds coexist with legacy order event kinds. Preserve event keys, occurrence identity and historical acceptance JSON; no backfill or receipt rewrite is supplied.
