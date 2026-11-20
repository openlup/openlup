Adds `openlup catalogue project --trusted-packs` for explicitly trusted local
catalogue modules. It projects deterministic JSON to an external scratch file and
runs one offline check with the registered content validators. Draft schemas
through v3 check supplied draft data and operation and price shape.
Finding pointers for v1 dimensions now resolve in the saved subject.

Migration: Existing `catalogue check --packs` invocations still read inert JSON.
Use the reported replay command to inspect the scratch subject without loading
application code. Installed rules, price execution and publication require
separate evidence.
