### Improve settings CLI and MCP diagnostics and live-edit reloading

`openlup settings mcp` now runs each tool invocation in a fresh child process
with stdout/console redirected to stderr so on-disk application configuration
edits take effect immediately without restarting the MCP server. Added per-command
`--help` (including `check`, `preview`, and `mcp`), optional `appBindingWarning`
and `partialMatch` fields on `list`, rule `messages` on invalid `check` rows,
distinct remediation when no connected reader is registered, `Default: none`
text formatting, full `preview` input validation before app-key `unsupported`
refusals, and `checkout` search synonyms.
