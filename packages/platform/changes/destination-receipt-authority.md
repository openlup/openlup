### Preserve destination receipt replay and privacy

The native migration adds private destination receipts with a scoped replay key
and an audit record. The native privacy contributor exports subject evidence
and erases its payload while retaining the replay tombstone. Connected-store
capture and restore carry both dispositions. Fresh destination issuance remains
unavailable until its owner is installed.
