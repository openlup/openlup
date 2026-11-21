### Use the starter settings script to find and check configuration

The starter's agent guide shows how to find settings by goal, verify a value
edit and start the read-only settings server.

Migration: Before applying the next set's managed files, replace a pristine
`AGENTS.md` from the 1.3.0 starter with the target starter's `AGENTS.md`.
If the file has local edits, an explicit snapshot replacement refuses before
writing. Merge the target guidance into your copy, keep your edits and rerun
the managed upgrade without `AGENTS.md` in its snapshots. This documentation
change requires no installed-policy step and adds no startup refusal.
