# company-identity domain

Provider-neutral lookup of a company's registry identity from a tax or registry
identifier: the browser asks one question — "who is the business behind this
number?" — and receives a normalized company record with an explicit statement
of how much it can be trusted.

⚠️ This README is the whole documentation for this domain. Nothing about it is
covered by the maintainer canons in the private overlay.

## Owns / does not own

- **Owns:** the lookup request/response contract, the verification levels, the
  source-evidence shape, identifier normalization, and the browser client.
- **Does not own:** provider credentials, raw provider payloads, caching and
  request dedupe, source precedence, or the invoicing that consumes the answer.
  All of those stay server-side, outside browser code.

Verification level is the point of the contract. An answer is
`registry_verified` (an authoritative registry confirmed it), `provider_verified`
(a commercial data source did, which is weaker), `manual_unverified` (the user
typed it and nobody checked), or `invalid` (the identifier failed its format or
existence check). A caller that ignores this field is treating a typed string as
a registry fact. The two declared purposes — `checkout_invoice` and
`customer_billing_profile` — let an adapter apply stricter policy where the
consequence is larger.

## Ports and seams

- Engine: `packages/core/src/company-identity/`, exposed as
  `@openlup/core/company-identity` — the neutral request/response contract and
  `CompanyIdentityLookupPort`. The core keeps `country` an open ISO-3166
  alpha-2 code and lets the host adapter decide which identifier kinds it
  accepts. An adapter never throws for "not found" or "unsupported country";
  both are response statuses, so callers branch on data rather than exceptions.
- `ports.ts` — a re-export shim over that port. This is the seam an adopter
  implements to plug in a national registry, a commercial provider, or a manual
  store.
- `companyIdentityContracts.ts` — the local layer on top of the neutral base:
  downstream registry extensions and the country-specific normalization
  described below.
- `companyIdentityClient.ts` — the browser client for
  `/api/bff/company-identity/lookup`.
- `server/domains/company-identity/companyIdentityService.ts` — composes an
  ordered provider list per country and walks it until a record is complete,
  recording each source's outcome as evidence.
- `server/domains/company-identity/vendorCompanyIdentityProvider.ts` — the
  generic HTTP provider, the neutral way to attach any external lookup service.
- `server/bff/company-identity/{lookup,shared}.ts` — the route handler and the
  composition root that builds the provider list.

## What an adopter configures

Every key below is server-only.

- `COMPANY_IDENTITY_LOOKUP_MODE` — which provider chain runs. `static` uses a
  fixture chain and calls nothing external; any other value selects the live
  chain. When unset it falls back to the legacy
  `COMMERCE_ACCOUNTING_INVOICE_DATA_LOOKUP_MODE`, and failing that defaults to
  the static chain outside preview deployments.
- `COMPANY_IDENTITY_VENDOR_ENABLED`, `..._BASE_URL`, `..._LOOKUP_PATH`,
  `..._API_TOKEN`, `..._TIMEOUT_MS`, `..._PROVIDER_KIND` — the generic HTTP
  provider. Setting `ENABLED=true` plus a base URL is the whole integration; the
  provider kind is a free label that lands in the evidence, defaulting to
  `commercial_company_lookup`.
- The country-specific adapters listed below, if you want them.

A deployment that configures none of this still answers: the lookup returns a
`manual_unverified` record rather than failing, so a checkout never blocks on a
registry being unreachable.

## Known non-neutrality (this deployment)

This is the densest concentration of one country's registry integrations in the
tree, and it is worth naming plainly rather than discovering it later.

- The neutral core is neutral; this domain's local layer is not. The
  `pl_nip` identifier kind is normalized and checksum-validated through the
  canonical national tax-identifier helpers, and that branch is keyed on the
  literal country code `"PL"`. Any other country falls through to a
  length-only check.
- Three country-specific adapters ship under `server/adapters/`:
  - `mfVat/` — the tax authority's VAT-payer register, keyed
    `mf_vat_whitelist`, configured with `MF_VAT_LOOKUP_BASE_URL`,
    `MF_VAT_LOOKUP_PROVIDER_KIND` and `MF_VAT_LOOKUP_TIMEOUT_MS`. It runs first
    and supplies VAT status and address.
  - `ceidg/` — the sole-proprietor business register's v3 API, configured with
    `CEIDG_API_TOKEN`, `CEIDG_LOOKUP_BASE_URL`, `CEIDG_LOOKUP_PROVIDER_KIND`
    and `CEIDG_LOOKUP_TIMEOUT_MS`. It supplies the fuller legal name that the
    VAT register abbreviates for sole proprietors.
  - `gusCeidg/` — an HTTP proxy over the statistical office's view of the same
    register, keyed `gus_ceidg`, configured with `GUS_CEIDG_LOOKUP_ENABLED`,
    `..._BASE_URL`, `..._PATH`, `..._API_TOKEN`, `..._PROVIDER_KIND` and
    `..._TIMEOUT_MS`. It is the fallback when no token is configured for the
    previous one.
- The response carries a `regon` field — a national statistical number with no
  equivalent elsewhere. It is optional and nullable, so a different country's
  adapter simply leaves it null.

None of the three adapters is required. They are reference implementations of
`CompanyIdentityLookupPort`, and an adopter in another jurisdiction replaces
them at that seam without touching the contract, the client, or the service.
