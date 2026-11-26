import { buildGuidance, infrastructure, rulesRecheck, up } from './installation/refusals.ts';
import { hostPortFix } from './shared/refusals.ts';
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

const reviewCommand = 'npm run catalogue:apply -- --reprice';
export const repriceRecovery = (verify = 'npm run catalogue:apply', review = reviewCommand) =>
  `Run ${verify} to verify committed prices read-only, then run ${review} to review any remaining change.`;
export const repriceReview = (review = reviewCommand) =>
  `A fresh review by the reviewing administrator is required. Start a fresh --reprice by running ${review}, then review the current amounts and approve again.`;
export const repriceRequired = (review = reviewCommand) =>
  `To change the live price, run ${review}. To keep it, set the declared amount to the live price.`;
const applyAgain = 'Repeat catalogue apply after correcting the prerequisite.';
const review = 'Reload the current draft and head. Prepare the current revision and obtain its own approval.';
const originalActor = 'Have the original issuing administrator sign in';
const original = `${originalActor} and resume the original operation.`;
const unchanged = 'Retry the unchanged original request. For a separate proposal, prepare it and obtain its own approval.';
const operatorChallengeLimits = 'The limits are one issued challenge per minute and five per hour per address.';
const operatorMailbox = 'After requesting a token, re-read the private mailbox in the same Compose project. If a new matching message appears, use its token within ten minutes.';
export const operatorChallengeGuidance = `${operatorChallengeLimits} ${operatorMailbox}`;
const operatorSignIn = [
  'The starter could not complete operator sign-in.',
  'The email may not belong to an active administrator account or its current invitation. The token may be wrong, expired or already used.',
  `Use the email for the active administrator account or its current invitation and request a fresh token once both rolling limits allow it. ${operatorChallengeGuidance}`,
  'Retry sign-in with the same apply flags. If no new matching message arrives, confirm the address and wait until both limits allow another request.',
];
const isOperatorSignIn = (code, path) => path === 'auth.operator' && ['starter_input_invalid', 'starter_auth_invalid'].includes(code);
export const localPortFix = 'Set OPENLUP_STARTER_PORT to a decimal port from 1024 to 65535, or unset it to use 4319. For the default origin, choose a port that Fetch permits.';
// Only findings about a single SKU's price state can be collected during review.
const skuLocalPriceRefusals = new Set([
  'starter_catalogue_reprice_required', 'starter_catalogue_price_scheduled', 'base_price_ambiguous',
  'starter_catalogue_reprice_base_missing', 'starter_catalogue_derived_price_zero',
]);
export const isSkuLocalPriceRefusal = code => skuLocalPriceRefusals.has(code);

export function catalogueApplyFix(finding, { activity, invocation, freshReprice, repriceStarted }) {
  const { code, fix } = finding;
  if (isOperatorSignIn(code, finding.path)) return fix;
  if (['operator_required', 'starter_auth_invalid', 'draft_operator_required', 'catalog_draft_operator_required',
    'catalog_operator_required', 'publisher_not_authorized'].includes(code)) {
    const restart = repriceStarted ? 'Use an active administrator when restarting with the same flags.'
      : `Restart ${activity} with the same flags under an active administrator. Run ${invocation}.`;
    // The owner also uses this code for command refusals without exposing a receipt actor.
    return code === 'publisher_not_authorized'
      ? `${restart} If replaying a receipt known to belong to another administrator, use its original issuing administrator.`
      : restart;
  }
  if (['starter_catalogue_publication_actor_mismatch', 'operator_mismatch', 'catalog_operator_mismatch',
    'catalog_draft_command_actor_mismatch'].includes(code))
    return repriceStarted ? `${originalActor}.` : `${original} Run ${invocation}.`;
  if (code === 'starter_catalogue_reprice_review_required') return repriceStarted
    ? 'Use the reviewing administrator and the effective list for the next review.' : repriceReview(freshReprice);
  if (code === 'starter_catalogue_reprice_required') return repriceRequired(freshReprice);
  if (repriceStarted && code === 'price_list_not_active') return 'Use the effective price list for the next review.';
  if (repriceStarted && code === 'expected_state_mismatch')
    return 'Review the current base again and ask the pricing owner to clear any pending replacement.';
  return fix;
}

const applyRefusals = {
  OPENLUP_E_CATALOGUE_PRODUCT_REQUIRED: ['The owned catalogue has no product declaration for apply.', 'The command needs a catalogueProduct export.', 'Add the documented product declaration to the owned catalogue.', 'Repeat apply and check that the product is loaded.'],
  OPENLUP_E_CATALOGUE_BASE_PRICES_MISMATCH: ['Declared price keys differ from the authored SKU codes.', 'Base prices require exactly one amount per authored SKU.', 'Match the price keys to the SKU codes and remove unrelated entries.', 'Repeat preflight and check that every SKU has one price.'],
  OPENLUP_E_CATALOGUE_TERMINAL_REQUIRED: ['Apply cannot open an interactive terminal.', 'This mode requires direct operator confirmation.', 'Review the displayed proposal and type approve only if you intend it.', 'Rerun in an interactive terminal and check that the review prompt appears.'],
  OPENLUP_E_CATALOGUE_CONFIRMATION_INVALID: ['The terminal did not receive the required confirmation.', 'Approval requires explicit confirmation of the displayed proposal.', 'Review the displayed proposal and type approve only if you intend it.', 'Rerun in an interactive terminal and check that the review prompt appears.'],
  starter_catalogue_sign_in_incomplete: ['The sign-in prompt closed before receiving input.', 'The command needs an operator email and token.', 'Restart catalogue apply in an interactive terminal and complete operator sign-in.', 'Check the private mailbox for the latest token.'],
  OPENLUP_E_CATALOGUE_APPLY_UNAVAILABLE: ['The starter operation is unavailable.', infrastructure.cause, 'Check the running demo, installed packages and migrations, connection and TLS, and scoped routine access.', applyAgain],
  starter_seed_demonstration_database_required: ['The database or configuration did not match the marked demo.', 'Apply requires an admitted demonstration store.', 'Select the intended marked demo. Use the normal human operator workflow for another store.'],
  starter_auth_invalid: ['The sign-in token was refused.', 'The token may be expired, used or invalid.', 'Request a fresh challenge and enter the newest unused token within ten minutes.', 'Recheck by signing in.'],
  operator_required: ['The administrator session could not be verified for this run.', 'Apply requires an active human administrator and a consistent identity.', 'Have an active human store administrator sign in and review the saved proposal.'],
  starter_same_origin_required: ['The host refused the request origin.', 'Catalogue requests must use the configured origin.', 'Use the origin of the running starter for the selected configuration and rerun.'],
  starter_local_host_required: ['The host refused the request address.', 'The request host and port must match the running starter.', 'Use the configured host and port for the selected starter and rerun.'],
  starter_catalogue_currency_mismatch: ['The effective list currency differs from the configured market currency.', 'The selected list must price this market.', 'Restore a market and effective list that use the same currency.', 'Recheck the authenticated price target.'],
  starter_catalogue_d2c_policy_required: ['The effective D2C policy is missing, invalid or changed.', 'The base price requires a verified derived subscription price.', 'Restore one valid effective D2C policy.', 'Recheck the authenticated price target.'],
  starter_catalogue_derived_price_zero: ['The proposed base derives a zero subscription price.', 'The effective policy discounts and rounds the proposed base.', 'Choose a base that derives a positive subscription price under the effective policy.', 'Repeat validation.'],
  starter_catalogue_price_invalid: ['A base amount is outside the supported range.', 'Prices use integer minor units.', 'Enter a whole minor-unit amount from 1 to 2147483647.'],
  starter_catalogue_save_too_large: ['The serialized draft action exceeds 65536 UTF-8 bytes.', 'The host bounds the complete action body.', 'Shorten optional content or reduce the number of SKUs in the proposal.'],
  starter_catalogue_presentation_invalid: ['The presentation is outside the starter display schema.', 'The storefront uses the shared starter presentation.', 'Supply a title and, if used, localized short names and a local media reference.'],
  starter_catalogue_media_invalid: ['The referenced image could not be used.', 'Apply requires a nonempty regular file within the image limit.', 'Put the image under public/media and match the filename case in the presentation reference.'],
  catalog_publication_media_validation_unavailable: ['The image verification did not finish.', 'The local media file could not be read.', 'Check the starter’s local media directory and file access, then retry.'],
  starter_catalogue_copy_unchanged: ['The copy matches the issued presentation.', 'A presentation successor needs a change to the saved copy.', 'Edit the intended presentation in copyPresentation.'],
  starter_catalogue_copy_requires_published: ['The original product publication is incomplete.', 'This mode requires both the Release and Activation receipts.', 'Run npm run catalogue:apply without --copy or --reprice first.', 'Check that Activation is published before using --copy or --reprice.'],
  starter_catalogue_reprice_review_required: ['The signed-in administrator or effective price list changed.', 'The approval belongs to the reviewing administrator and price list.', repriceReview()],
  starter_catalogue_reprice_required: ['The declared amount differs from the live base.', 'This mode requires matching live prices.', repriceRequired()],
  starter_catalogue_reprice_base_missing: ['The SKU has no effective base price.', 'The published prices require a live base for every SKU.', 'Set the missing positive gross base through the authorized price action with no prior entry, then rerun.'],
  starter_catalogue_price_scheduled: ['The SKU has a scheduled base price.', 'The price writer cannot replace a scheduled base.', 'Ask the pricing owner to clear the scheduled base price first, then rerun.'],
  starter_catalogue_reprice_readback_unverified: ['committed; figure not verified', 'The effective price and subscription figure could not be verified.', repriceRecovery()],
  starter_catalogue_reprice_requires_active: ['The SKU is ineligible for reprice.', 'A live replacement requires an active sellable SKU on the effective list.', 'Publish Activation for a draft product. Ask the pricing owner to review other SKU eligibility or list issues.'],
  base_price_ambiguous: ['The SKU has multiple effective base prices.', 'The price writer needs a single effective base.', 'Two effective base prices exist for this SKU. Route the duplicate to the pricing owner, then rerun.'],
  publication_sku_price_not_ready: ['An SKU does not have a ready price.', 'Publish requires a positive gross base and ready subscription pricing.', 'Set the missing positive gross base through the authorized action and verify the derived price. Route existing-base corrections to the pricing owner.', 'Retry the same Publish once the intended price is ready.'],
  publication_price_readiness: ['The native readiness check refused publication.', 'A readiness prerequisite remains open.', 'Use the native readiness remedy to repair the prerequisite.', 'Retry the unchanged Publish request with its original key.'],
  expected_state_mismatch: ['An effective or pending base differs from the expected state.', 'Initial setup requires an absent base, or a matching receipt and live price on replay.', "If this command's earlier run set the live price, restore the declared amount to it and resume. Otherwise route the price to the pricing owner. After Activation, change prices with --reprice."],
  readiness_would_fail: ['The owner refused a price write.', 'The write would introduce a readiness finding.', 'Review the typed readiness findings, restore eligibility and repeat the failed step.'],
  sku_archived: ['The selected SKU is archived.', 'Archived SKUs cannot receive a base price.', 'Select an eligible SKU.'],
  price_list_not_active: ['The requested or resolved list is ineffective for this market.', 'Price setup is scoped to the effective settlement list.', 'Restore the effective list for the selected market and recheck.'],
  catalog_price_setup_basis_mismatch: ['The effective list does not use gross prices.', 'This workflow uses the V1 gross price contract.', 'Select an effective gross list or use the pricing owner workflow for an exclusive list.'],
  publisher_not_authorized: ['Publication authority could not be verified for this administrator.', 'Publication actions require active administrator authority.', 'Sign in as an active store administrator and try again.'],
  starter_catalogue_publication_actor_mismatch: ['The verified publication receipt belongs to another administrator.', 'Only the issuing administrator can replay the command.', original],
  publication_authority_unavailable: ['The publication operation could not verify its required authority or evidence.', 'The publication owner could not confirm a prerequisite.', 'Ask the publication owner to verify the required authority and evidence, then retry once they are available.'],
  operator_mismatch: ['The price receipt is bound to another administrator.', 'Only the issuing administrator can replay the price command.', original],
  publication_command_key_reused: ['The publication key binds different bytes.', 'Exact replay requires the original action and fingerprint.', unchanged],
  command_key_reused: ['The price key binds different bytes.', 'Exact replay requires the original price request.', unchanged],
  ...Object.fromEntries(['publication_draft_advanced', 'publication_approval_missing', 'publication_post_state_changed',
    'head_conflict', 'catalog_publication_receipt_invalid'].map(code => [code,
    ['The saved revision, receipt or publication head does not match the proposal.', 'This action requires the same saved evidence reviewed by the administrator.', review]])),
};
const nativePriceRefusal = ['The native price check was refused.', 'The owner could not verify the required evidence.',
  'The price check could not verify the native records named by the reason. Have the store owner verify them. Recent paid orders count for 24 hours. Rerun when the check passes.'];

export function catalogueApplyRefusal({ code, path, subject, reason, issues, message, guidance }, error) {
  const localGuidance = isOperatorSignIn(code, path) ? operatorSignIn : code === 'starter_port_invalid' && path === '/arguments'
    ? ['The command received an invalid OPENLUP_STARTER_PORT.', 'The local starter requires a supported listener port.',
      `${localPortFix} Rerun the same catalogue apply command.`, 'Repeat `npm run catalogue:apply` with the same flags.'] : undefined;
  const applyGuidance = localGuidance ?? (Object.hasOwn(applyRefusals, code) ? applyRefusals[code]
    : /^(?:native_[a-z_]+|settlement_context)_unverified$/u.test(code) ? nativePriceRefusal : undefined);
  const [observed, cause, fix, recheck = applyAgain] = applyGuidance ??
    ['An installed owner refused the action.', 'The action did not meet the installed contract.',
      'Review the reported refusal before restarting catalogue apply.'];
  const known = applyGuidance ?? starterGuidance(code);
  const readiness = known && path === 'pricing.readiness' &&
    /^Observed: (.+?) Cause: (.+?) Fix: (.+?) Recheck: (.+)$/u.exec(message ?? '');
  const owner = !localGuidance && known && (guidance ?? (applyGuidance ? undefined : known));
  const finding = { code, path, ...(subject !== undefined && { subject }), ...(reason !== undefined && { reason }),
    ...(issues !== undefined && { issues }), observed: readiness?.[1] ?? owner?.observed ?? observed,
    cause: readiness?.[2] ?? owner?.cause ?? cause, fix: readiness?.[3] ?? owner?.fix ?? fix,
    recheck: readiness?.[4] ?? owner?.recheck ?? recheck };
  return Object.assign(error === undefined ? new Error(code) : new Error(code, { cause: error }), { finding });
}

export const starterRefusals = Object.freeze(Object.fromEntries(Object.entries({
  ...Object.fromEntries(Object.entries(applyRefusals).map(([code, [, cause, fix, recheck = applyAgain]]) =>
    [code, { cause, fix, recheck }])),
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
  starter_port_invalid: { fix: `Direct host: ${hostPortFix} Lifecycle commands: ${localPortFix}`, recheck: 'Rerun the command that refused the port.' },
  starter_predecessor_cancel_failed: browser('Use the qualified predecessor and verify its seeded subscription and cancellation terms.'),
  starter_price_seed_conflict: { fix: 'If you edited the owned price, discount or rounding inputs after seeding, restore the originals before retrying. Ask the pricing owner to reconcile divergent seed rows with the original demo inputs. Have the owner close other active or open explicit subscription rows or withdraw pending rows while preserving price history. You can also rebuild a disposable demo using the installed guide.', recheck: up },
  starter_product_invalid: checkConfig,
  starter_promotion_seed_conflict: verifySeed,
  starter_public_origin_flag_invalid: { fix: 'Supply the documented public origin option with a valid origin.', recheck: up },
  starter_public_origin_invalid: checkConfig,
  starter_public_origin_not_canonical: checkConfig,
  starter_public_origin_tls_required: { fix: 'Use HTTPS for a non-loopback public origin.', recheck: up },
  starter_purchase_configuration_invalid: checkConfig,
  starter_recovery_configuration_invalid: { fix: 'Supply all required recovery states and message fields in the owned recovery configuration.', recheck: up },
  starter_quote_acceptance_key_invalid: { fix: 'Restore the private demo quote-key directory and its required permissions.', recheck: up },
  starter_runtime_credential_source_invalid: { cause: 'The private project credential source could not be admitted.', fix: 'Restore access to the owner-only state and remove any extra hard links. Move an invalid entry aside in an exclusive maintenance window.', recheck: up },
  starter_runtime_project_busy: { fix: 'Wait for the lifecycle command in this directory to finish, then retry.', recheck: up },
  starter_runtime_project_mismatch: { cause: 'This application directory is assigned to another Compose project.', fix: 'Unset COMPOSE_PROJECT_NAME and run `./lifecycle down` to stop the project in .context/compose-project and clear the record. Then start the new project.', recheck: up },
  starter_runtime_project_record_invalid: { fix: 'Restore the Compose project name in .context/compose-project, then retry.', recheck: up },
  starter_runtime_preflight_handoff_missing: { cause: 'Compose did not receive the empty startup handoff.', fix: 'Use the updated lifecycle command for the same project.', recheck: up },
  starter_runtime_credential_mount_failed: { cause: 'Compose could not mount the private credential file.', fix: 'Restore the source and Docker access to the private state directory.', recheck: up },
  starter_runtime_credential_read_failed: { cause: 'The mounted runtime credential could not be read.', fix: 'Remove any extra hard links, restore the file bind from the correct project, and start that project again.', recheck: up },
  starter_runtime_database_auth_failed: { cause: 'The runtime login or database identity was refused.', fix: 'Rerun the installer through lifecycle up using the retained file and database volume.', recheck: up },
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
