# Security model

Identify which code may trust a request, access data or contact a provider before
exposing a capability. Use [Harden a deployment](../how-to/operate/security-hardening.md)
to configure these boundaries.

## Browser, server and host

Browser code consumes portable contracts and clients; server code authorizes
requests and accesses persistence through ports. Keep database credentials,
signing keys and provider secrets in server bindings, outside browser assets,
source and logs.

The host supplies routes, authorization bindings, HTTP security policy and
provider selection. Importing a package does not activate a provider or start a
host. [Architecture and ownership](architecture-and-ownership.md#runtime-boundaries)
explains the package and application responsibilities.

## Identity and database authority

Authentication establishes a principal; operator membership separately grants
authority. [Identity](identity.md) owns verified sign-in, live membership checks,
human and machine separation, session rules and redirect policy. A database
service role does not authorize an HTTP caller.

The PostgreSQL gateway sets actor claims and roles within each transaction;
service calls select `service_role`. Capability-local role-free lanes belong
only to their named owner authority. Runtime and migration connections must keep
the selected installation's principal and grant separation: changing the endpoint
does not change privileges. Follow [connection roles](../how-to/operate/connect-postgresql.md#preserve-role-separation)
and [migration provisioning](../upgrade/database-migrations.md#select-the-complete-catalogue).

## Provider admission and callbacks

Email transport admission requires a host policy before sender entry; a raw
transport passed through the guard refuses with `email_egress_unadmitted`.
The policy selects credentials, recipient and environment for each send.
Webhook authenticity is a separate boundary: verify the selected protocol over
the original request bytes before interpreting an event. See [provider adapters](../how-to/extend/provider-adapters.md#node-email-protocol-template)
for admission, signature and environment handling.

## Audit and personal data

Customer diagnostic reads require an active operator and an access-audit write
in the same transaction; audit failure refuses the read. [Diagnostic history
and retention](../how-to/operate/diagnostics-and-retention.md#authorize-reads)
explains that boundary and the deletion drain.

[Personal data](personal-data.md) owns contributor coverage, erasure assessment
and retained obligations. An identity erasure receipt does not establish deletion
across all platform data or remote processors.

## Vulnerability reports

Use the repository [security policy](https://github.com/openlup/openlup/blob/openlup-core-v0.42.0/SECURITY.md)
to report privately. The [security response posture](https://github.com/openlup/openlup/blob/openlup-core-v0.42.0/.github/SECURITY_RESPONSE_POSTURE.md)
defines maintenance eligibility; it provides neither a bug bounty nor a
guaranteed response timeline.
