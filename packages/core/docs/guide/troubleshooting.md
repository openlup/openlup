# Troubleshooting

Find the refusal code below, read its cause and repair, then consult the [refusal-code reference](reference/refusal-codes.md) for the declaring type.

## Readiness codes

| Code | Cause | Repair |
| --- | --- | --- |
| `OPENLUP_E_PORT_MISSING` | A required port, route registration or host binding is missing or mismatched. | Supply actual host bindings; bind the selected adapter port and the declared route's actual handler. |
| `OPENLUP_E_EVENT_UNHANDLED` | An event has no handler or owned exemption, or handler descriptors, vocabulary or exemptions are invalid. | Supply valid handler descriptors and vocabulary with owners; register a handler or an explicit owned ignored/dormant declaration with a reason. |
| `OPENLUP_E_EVENT_DUPLICATE` | Vocabulary identities, producer owners or consumers are duplicated, or declared consumers do not match composed descriptors. | Declare each vocabulary identity once; use one non-kernel producer owner and one composed consumer per event, matching each declared consumer to exactly one descriptor. |
| `OPENLUP_E_SCHEDULE_UNBOUND` | A runnable schedule is absent, or its declaration, cadence, callable and trigger binding do not agree. | Supply runnable schedules and bind each actual schedule with its declared cadence to one host trigger. |
| `OPENLUP_E_SCHEMA_BEHIND` | Schema requirements are duplicated, the probe or timeout is invalid, observations are unavailable or incomplete, or database identity, migration identity or objects do not match. | Remove duplicate requirements; supply a bounded schema observation port and complete observations for the exact candidate database. Apply the named migration through your migration chain when the finding calls for it, and observe its version and objects. |
| `OPENLUP_E_SET_MISMATCH` | Candidate observations or manifests are invalid or incomplete, or package versions, contributions, module selection, dependencies or ownership do not agree. | Supply complete valid observations and manifests; observe each loaded package once, including exactly one core kernel, and align package versions. Match each selected module to one contribution, satisfy its declared dependencies using the same or an earlier layer, and declare one module owner per schedule or route. |
| `OPENLUP_E_ENV_MISSING` | A required environment entry is absent or blank. | Supply the named environment variable without exposing its value. |

## Command-line codes

| Code | Cause | Repair |
| --- | --- | --- |
| `OPENLUP_E_CLI_INPUT` | Invalid command or input syntax. | Use `openlup --help` and explicit input paths; check readable JSON snapshots and the schema ordinal. |
| `OPENLUP_E_CLI_FAILURE` | Snapshot admission, a filesystem operation or trusted application loading failed. | Check the command, readable JSON snapshots and schema ordinal, or the trusted `--app` module and its read-only probe. After a partial upgrade, rerun identical snapshots under exclusive access. |
| `OPENLUP_E_APP_UNKNOWN` | No application observations were loaded; the command does not discover or start application code implicitly. | Create an application-owned module exporting `createVerificationInput()` that returns your actual selected contributions, binding identities and read-only schema observer as a `ReadinessInput`; pass its path with `--app`. |

## Subscription engine codes

| Code | Cause | Repair |
| --- | --- | --- |
| `invalid_timestamp` | An input timestamp is invalid, or a cadence, restart or payment shift cannot produce a timestamp in range. | Supply valid timestamps and inputs whose calculated timestamps remain in range. |
| `invalid_template` | Cadence is below one, the template has no lines, or a line quantity is below one. | Supply a positive cadence, at least one line and positive quantities. |
| `inactive_subscription` | Cycle planning, skipping or sliding was requested for a subscription that is not active. | Use these operations only for an active subscription. |
| `edit_window_closed` | The subscription is not active, timestamps are invalid, or the edit cutoff has been reached. | Submit template swaps or permanent add-ons only for an active subscription with valid timestamps before its edit cutoff. |
| `line_not_found` | The source variant for a swap is absent from the template. | Select a source variant present in the template. |
| `duplicate_line` | A swap target or permanent add-on variant is already present. | Select a variant absent from the template. |
| `invalid_slide_target` | The proposed next cycle is not in the future relative to `now`. | Supply a future `newNextCycleAt`. |
| `invalid_transition` | The requested status change or recovery operation is not allowed for the current status, or the cycle belongs to another subscription. | Use a permitted transition for that operation and a cycle belonging to the subscription; ordinary resume requires paused status, reactivation requires cancelled status, and expired-dunning resume requires paused status. |
| `terminal_cycle` | Payment success or failure was submitted for a paid, skipped or cancelled cycle. | Do not pay or retry a terminal cycle. |
| `missing_payment_method` | Reactivation or expired-dunning resume has no required payment method. | Supply a stored method for reactivation or a chargeable method for expired-dunning resume. |
| `dunning_not_exhausted` | An expired-dunning operation received a cycle that has not exhausted the retry ladder. | Use that operation only with a cycle that has exhausted the selected retry cadence. |

For all other codes, consult the [refusal-code reference](reference/refusal-codes.md).
