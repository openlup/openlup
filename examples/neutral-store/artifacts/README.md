# Candidate artifacts

Status: local candidate input, not a published set.

The application manifest deliberately points to three tarballs in this directory:
`openlup-core.tgz`, `openlup-outbox.tgz` and `openlup-platform.tgz`.
Use only the selected, identified locally packed candidate set. Do not silently
substitute registry packages or an unreviewed source revision.

Within the application's installation authority, import the supplied paths:

```sh
./lifecycle candidate /absolute/core.tgz /absolute/outbox.tgz /absolute/platform.tgz
```

This copies bytes, verifies package names and equal versions, records SHA-256
identities, then generates the candidate lockfile. It installs no package engine
from the author checkout. The command needs a Node/npm toolchain and writes only
inside this application. It is a preparation command, not a sandbox-purchase
qualification. Candidate identities are ignored local evidence.

Final registry pins, a committed lockfile and the exact release archive reference
are pending set-version preparation. No candidate is called a published release.
