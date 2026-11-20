### Settings MCP launch and required inputs

- Pass `mcp` to the starter's settings script to launch the read-only settings
  server from the application root. If the application module cannot load,
  launch stops and reports the reason on stderr.
- Provide `key` to `settings_show`, `keyOrCode` to `settings_explain`, and both
  `key` and the proposed JSON `value` to `settings_preview`. Missing inputs
  receive a JSON-RPC argument error that names the required field.
