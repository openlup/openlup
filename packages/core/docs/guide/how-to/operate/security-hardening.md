# Harden a deployment

Configure the host's trust boundaries before exposing its routes or enabling
provider effects. Start with the [security model](../../concepts/security-model.md)
and apply the steps for the capabilities you actually compose.

## Restrict database authority

Use the selected installation's role bindings and grants from [database
provisioning](../../upgrade/database-migrations.md#select-the-complete-catalogue).
Keep migration/admin credentials on their direct connection and restricted
runtime credentials on request and scheduler-lock connections, following
[connection separation](connect-postgresql.md#preserve-role-separation).
Do not substitute an owner login for missing runtime grants.

Supply verified actor claims to the gateway's actor lane and use its service
lane for service work; the [gateway](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/platform/src/data/postgresGateway.ts)
sets claims and selected roles transaction-locally. Keep role-free lanes scoped
to their named capability rather than using them for generic service work.

## Keep secrets on the server

Pass database credentials, session-signing keys and provider secrets only to
server bindings, as described in [host configuration](self-host.md#supply-configuration-and-storage).
Keep them out of browser build inputs, source, fixtures, persisted diagnostics
and logs. Use the [configuration reference](../../reference/configuration.md)
and each selected adapter's inputs when separating browser-public values from
server settings.

## Admit outbound effects

Put each new mail network sender behind `createGuardedEmailTransport` with an
explicit host policy selecting credential, effective recipient and environment.
The [email admission implementation](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/platform/src/communications/emailEgress.ts)
refuses unavailable, invalid or blocked decisions before sender entry; raw
transports passed through the guard return `email_egress_unadmitted`.
Follow [provider adapter composition](../extend/provider-adapters.md#node-email-protocol-template)
for suppression and refusal handling.

## Verify webhook callbacks before interpreting events

Bind callback routes to the selected adapter's signature verifier and preserve
the original request bytes, following [provider verification](../extend/provider-adapters.md).
Do not verify a reserialized parsed object: the [raw-body helper](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/platform/src/http/webhookSignature.ts)
cannot reconstruct the wire bytes from it. Bind the receiver environment and
apply the selected protocol's signature and timestamp policy before lookup or
writes. Keep explicit body and deadline policies for stream-first handlers;
[HTTP admission](self-host.md#declare-http-admission) explains raw-stream handling.

## Configure origins and HTTP policy

Supply the Node host's security-header policy, content security policy and route
authorization through [HTTP composition](self-host.md#declare-http-admission).
Configure magic-link origins explicitly and retain same-origin JSON admission
on direct operator challenge requests and redemption. The [operator handlers](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/platform/src/identity/operatorAuthHandlers.ts)
reject a mismatched Origin or content type with `FORBIDDEN`.
Use [Identity](../../concepts/identity.md#magic-link-destinations) for redirect
policy and live authorization rather than trusting browser-supplied roles.

## Preserve audit and retention

Keep diagnostic reads behind the [authorized, atomic access-audit boundary](diagnostics-and-retention.md#authorize-reads);
an audit failure returns `UPSTREAM_UNAVAILABLE` with reason `audit_unavailable`.
Enable retained collection only with its [retention drain](diagnostics-and-retention.md#retention-drain)
and inspect deletion outcomes. Leave deletion enabled after collection stops so
stored history can expire. Register each [personal-data owner](../../concepts/personal-data.md)
and its retention policy; identity erasure does not delete every retained resource.

## Limits

- Managed identity erasure refuses with `MANAGED_PRIVACY_ERASURE_UNAVAILABLE`;
  the shipped managed store supplies export only, as [Personal data](../../concepts/personal-data.md#export-and-erasure)
  explains.
- There is no bug bounty or guaranteed security-response timeline; consult the
  [response posture](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/.github/SECURITY_RESPONSE_POSTURE.md)
  and use the private [reporting route](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/SECURITY.md).
