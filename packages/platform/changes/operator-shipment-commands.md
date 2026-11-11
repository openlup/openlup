- Add the experimental native operator shipment command factory for atomic label evidence, exact reservation consumption at handoff and tracking chronology with server actor and durable replay evidence.
- Preserve earlier-only delivered replay through the arrival recorder, safe latest-operation reads and fail-soft accounting composition after handoff. Historical missing reservation sets return a named zero-consumption result; unattributed cross-order tracking references refuse with the conflicting order reference. The documented limits describe manual resolution.

Install the complete selected native catalogue through `20261110230000_operator_shipment_commands.sql`. Hosts retain administrator authorization, provider selection, duty policy and connection ownership. No operator UI or live carrier call is added.

- The approved packed-byte cap of 3,023,741 B is retained. Code files measured 4,120 against the prior cap of 4,117; the code-file cap is 4,203 (measurement plus 2%, rounded up). The released baseline is unchanged.
- Tracking-reference writers require READ COMMITTED and an explicit provider namespace, including shared shipment evidence. Exact handoff receipts replay before any new status transition.
