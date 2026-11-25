import { buildGuidance, infrastructure, rulesRecheck, up } from './installation/refusals.ts';
import { seedPhysicalGuidance } from './shared/seed-physical.ts';

const retryBrowser = 'Run `./lifecycle browser` again.';
const checkConfig = { fix: 'Correct the selected configuration in owned files.', recheck: up };
const browser = fix => ({ fix, recheck: retryBrowser });
const verifySeed = { fix: 'Restore the original demonstration inputs or rebuild a disposable demo using the installed guide.', recheck: up };
const owner = { fix: "Follow the installation command's case-specific Fix for this owner refusal.", recheck: "Use the installation command's case-specific Recheck." };
const argumentsForUp = {
  cause: 'This lifecycle command accepts only its documented options and argument values.',
  fix: 'Use the documented options once each and supply a configuration ID when using the configuration option.',
  recheck: 'Run `./lifecycle up --json` with the corrected options.',
};
const candidate = { fix: 'Supply one matching Core, Outbox and Platform tarball from the same candidate set.', recheck: 'Repeat `./lifecycle candidate` with the three qualified tarballs.' };

export const starterRefusals = Object.freeze(Object.fromEntries(Object.entries({
  ...seedPhysicalGuidance,
  checkout_recovery_schedule_change_blocked_open_episodes: owner,
  fulfillment_stock_current_idempotency_conflict: owner,
  ...buildGuidance,
  starter_acquisition_seed_conflict: verifySeed,
  starter_argument_duplicate: argumentsForUp,
  starter_argument_unknown: argumentsForUp,
  starter_argument_value_required: argumentsForUp,
  starter_billing_installation_required: { fix: 'Install the qualified billing migrations for the demonstration database.', recheck: up },
  starter_candidate_identity_mismatch: candidate,
  starter_candidate_requires_three_tarballs: candidate,
  starter_candidate_set_mismatch: candidate,
  starter_catalog_empty: checkConfig,
  starter_catalogue_build_invalid: { fix: 'Restore the rules and definition matching the retained build, or rebuild a disposable demo.', recheck: up },
  starter_catalogue_pack_version_conflict: owner,
  starter_catalogue_profile_redefinition: owner,
  starter_catalogue_profile_ref_missing: owner,
  starter_catalogue_publication_login_invalid: { fix: 'Restore the dedicated publication login and its matching private password file through the demonstration installer.', recheck: up },
  starter_catalogue_publication_password_missing: { fix: 'Restore the private publication password file by rerunning the demonstration installer with its build volume.', recheck: up },
  starter_catalogue_publication_password_invalid: { fix: 'Restore access to the private publication password file in the demo build volume.', recheck: up },
  starter_catalogue_rules_invalid: { ...owner, recheck: rulesRecheck },
  starter_catalogue_rules_required: { fix: 'Restore the tested rules bundle under owned/catalogue-rules.cjs.', recheck: up },
  starter_catalogue_type_redefinition: owner,
  starter_checkout_attempt_ledger_check_failed: { fix: 'Verify that the runtime login can check the installed checkout attempt ledger.', recheck: up },
  starter_checkout_attempt_ledger_execute_required: { fix: 'Restore the qualified runtime grant for the checkout attempt ledger routine.', recheck: up },
  starter_checkout_attempt_ledger_missing: { fix: 'Install the qualified migration for the checkout attempt ledger routine.', recheck: up },
  starter_configuration_invalid: checkConfig,
  starter_configuration_unknown: { fix: 'Select an ID exported by owned/store.config.ts.', recheck: up },
  starter_customer_session_binding_required: { fix: 'Restore the native customer session binding for the starter runtime.', recheck: up },
  starter_database_browser_command_failed: browser('Correct the failed command in the browser recipe.'),
  starter_database_browser_host_unavailable: browser('Check that the disposable starter host starts and serves its health endpoint.'),
  starter_database_browser_installation_incomplete: browser('Verify the installed platform packages and complete the disposable database migrations.'),
  starter_database_browser_port_required: browser('Allow the browser recipe to bind a local port.'),
  starter_database_browser_postgres_unavailable: browser('Check local Docker and the disposable PostgreSQL service.'),
  starter_database_browser_predecessor_required: browser('Supply the qualified predecessor extraction for the upgrade witness.'),
  starter_database_retry_budget: checkConfig,
  starter_lines_above_representation: checkConfig,
  starter_quote_configuration_invalid: checkConfig,
  starter_renewal_configuration_invalid: checkConfig,
  starter_retention_configuration_invalid: checkConfig,
  starter_subscription_actions_invalid: checkConfig,
  starter_subscription_care_configuration_invalid: checkConfig,
  starter_subscription_configuration_invalid: checkConfig,
  starter_database_browser_upgrade_required: browser('Use a candidate that applies the expected forward migrations.'),
  starter_default_locale_invalid: checkConfig,
  starter_demo_start_failed: infrastructure,
  starter_document_seed_conflict: verifySeed,
  starter_installation_binding_required: owner,
  starter_installation_failed: infrastructure,
  starter_installation_incomplete: { fix: 'Check the qualified package and migration set and resolve pending migrations.', recheck: up },
  starter_installed_policy_drift: { fix: 'Reconcile the owned policies with the installed demonstration policies.', recheck: up },
  starter_installed_upgrade_unavailable: { fix: 'Install the application’s pinned packages.', recheck: 'Repeat `./lifecycle upgrade`.' },
  starter_installed_verify_unavailable: { fix: 'Install the application’s pinned packages.', recheck: 'Repeat `./lifecycle verify`.' },
  starter_legacy_cancel_does_not_use_future_terms: browser('Use the qualified legacy fixture and its original cancellation terms.'),
  starter_listen_invalid: { fix: 'Use a supported listen address for the host.', recheck: up },
  starter_locale_copy_missing: { fix: 'Supply the missing copy field for the selected locale.', recheck: up },
  starter_locale_unsupported: { fix: 'Select a supported market locale.', recheck: up },
  starter_locales_invalid: checkConfig,
  starter_market_invalid: checkConfig,
  starter_offer_invalid: checkConfig,
  starter_order_controls_configuration_invalid: checkConfig,
  starter_pause_presets_invalid: checkConfig,
  starter_policy_seed_conflict: verifySeed,
  starter_port_invalid: { fix: 'Supply a valid numeric host port.', recheck: up },
  starter_predecessor_cancel_failed: browser('Use the qualified predecessor and verify its seeded subscription and cancellation terms.'),
  starter_price_seed_conflict: verifySeed,
  starter_product_invalid: checkConfig,
  starter_promotion_seed_conflict: verifySeed,
  starter_public_origin_flag_invalid: { fix: 'Supply the documented public origin option with a valid origin.', recheck: up },
  starter_public_origin_invalid: checkConfig,
  starter_public_origin_not_canonical: checkConfig,
  starter_public_origin_tls_required: { fix: 'Use HTTPS for a non-loopback public origin.', recheck: up },
  starter_purchase_configuration_invalid: checkConfig,
  starter_recovery_configuration_invalid: { fix: 'Supply all required recovery states and message fields in the owned recovery configuration.', recheck: up },
  starter_quote_acceptance_key_invalid: { fix: 'Restore the private demo quote-key directory and its required permissions.', recheck: up },
  starter_runtime_connection_required: { fix: 'Supply the starter runtime database connection.', recheck: up },
  starter_seed_demonstration_database_required: owner,
  starter_seed_install_role_required: owner,
  starter_seed_runtime_role_forbidden: owner,
  starter_subscription_creation_invalid: checkConfig,
  starter_subscription_offer_invalid: checkConfig,
  starter_support_email_invalid: checkConfig,
  starter_theme_invalid: checkConfig,
  starter_units_above_representation: checkConfig,
}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));

const legacyConfig = {
  inventory_renewal_protection_policy_invalid: { fix: 'Correct the renewal stock protection policy in the owned configuration.', recheck: up },
  checkout_recovery_reminder_schedule_invalid: { fix: 'Correct the checkout recovery reminder schedule in the owned configuration.', recheck: up },
  saved_address_policy_invalid: { fix: 'Correct the saved address policy in the owned configuration.', recheck: up },
};
export function starterGuidance(code) {
  if (Object.hasOwn(starterRefusals, code)) return starterRefusals[code];
  if (Object.hasOwn(legacyConfig, code)) return legacyConfig[code];
  if (/^starter_locale_unsupported: [A-Za-z0-9_-]{1,32}$(?![\s\S])/u.test(code)) return starterRefusals.starter_locale_unsupported;
  if (/^starter_locale_copy_missing: [A-Za-z0-9_.\[\]-]{1,120} \([a-z]{2}\)$(?![\s\S])/u.test(code)) return starterRefusals.starter_locale_copy_missing;
}
