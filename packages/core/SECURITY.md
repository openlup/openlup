# Security Policy

## Release Support

There are no public releases and therefore no supported public versions today.
The package is a private portability proof with publication blocked.
`0.1.0-rc.1` is a private proof version, not a supported public release. A
future support policy belongs to phase-5 public platform governance, not to a
separate package release channel.

## Vulnerability Reporting

Use GitHub Private Vulnerability Reporting for the repository named by this
package's source metadata. It is the primary route for suspected vulnerabilities.
If that private route is unavailable, use the fallback named by the canonical
[repository security policy](https://github.com/openlup/openlup/security/policy).
Never use a public issue, pull request, or discussion for a vulnerability report.
Packages do not define separate reporting routes.

## Safe Handling

Never include credentials, access tokens, private keys, personal data, or live
service payloads in an issue, pull request, test fixture, or reproduction.
Sanitize logs and use synthetic identifiers. If a secret is exposed, revoke or
rotate it at the system that issued it before sharing any follow-up evidence.

Security changes should include the smallest non-sensitive regression test that
demonstrates the repaired boundary. Public disclosure belongs after affected
users can obtain a fix and must follow the reporting policy established before
launch.
