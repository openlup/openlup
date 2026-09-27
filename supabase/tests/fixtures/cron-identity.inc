-- Synthetic identity belongs only to this rolled-back test transaction.
INSERT INTO private.platform_cron_environment (
  id, environment_label, expected_system_identifier, expected_server_addr,
  expected_server_port, external_cron_enabled
) VALUES (true, 'test', 'test-lineage', inet_server_addr(), inet_server_port(), false)
ON CONFLICT (id) DO NOTHING;
