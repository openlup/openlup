### Settings MCP launch and required inputs

- Launch the read-only settings server from the starter directory with
  `npm --silent run settings -- mcp`. If the application module cannot load,
  launch stops and reports the reason on stderr.
- Provide `key` to `settings_show`, `keyOrCode` to `settings_explain`, and both
  `key` and the proposed JSON `value` to `settings_preview`. Missing inputs
  receive a JSON-RPC argument error that names the required field.
