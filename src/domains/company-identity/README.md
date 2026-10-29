# company-identity domain

Provider-neutral lookup of a company's identity from a tax or registry
identifier: the browser asks one question — "who is the business behind this
number?" — and receives a lookup outcome, an optional normalized company record,
and evidence about the sources consulted.

## Owns / does not own

- **Owns:** the lookup request/response contract, the verification levels, the
  source-evidence shape, identifier normalization, and the browser client.
- **Does not own:** provider credentials, raw provider payloads, caching and
  request dedupe, source precedence, or the invoicing that consumes the answer.
  All of those stay server-side, outside browser code.

Interpret the response fields separately: `status` is the lookup outcome,
`verificationLevel` is the reference service's classification, `company` is the
resolved record or `null`, and `sources` records each consulted source's own
outcome. The neutral contract defines these labels; the current reference
service assigns them using request validity/type, provider outcomes and record
completeness, not from independent proof of a source's authority. In this
composition:

- A valid `custom` request is `manual_unverified` whether or not it includes
  `manualCompany`. With supplied manual data it returns `partial` and a company;
  without it, it returns `not_found` and `company: null`.
- In the non-custom provider chain, a complete retained company returns
  `found` / `registry_verified` when fuller legal-name enrichment is no longer
  pending, including at the final provider slot after a personal-only Polish
  NIP lookup. Loop exhaustion returns `partial` / `provider_verified` only for
  an incomplete retained company; that level does not identify a commercial
  provider. A static fixture can satisfy the complete-record condition, but
  fixture labels and reference classifications do not establish a live or
  authoritative registry response.
- An unavailable consulted source remains visible in `sources`. The aggregate
  status is `provider_unavailable` only when no company survives and at least
  one source was unavailable. A partial or complete surviving company can still
  determine the aggregate result despite another source's failure. The `invalid`
  verification level also accompanies no-company outcomes such as `not_found`,
  `unsupported_country` and `provider_unavailable`; it does not by itself mean
  the submitted identifier failed validation.

The two declared purposes — `checkout_invoice` and
`customer_billing_profile` — let an adapter apply stricter policy where the
consequence is larger. Hosts still own that policy and must interpret the
status, returned data and source evidence for their chosen composition.

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
  described below. It extends the imported core request input schema and uses
  the core's public `normalizeCompanyIdentityLookupRequest`; it does not copy
  the neutral schema or normalization. Optional registry fields survive the
  local extension. National tax-id normalization and validation stay here.
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

With no explicit mode, the lookup composition falls back to the static fixture
provider outside a Vercel preview and to the MF VAT provider in preview. A static
fixture miss has status `not_found`. The reference composition does not use
`manual_unverified` as a fallback for `pl_nip`; see the response classifications
above for custom requests and provider-source outcomes. The BFF lookup is also
feature-gated by `COMMERCE_ACCOUNTING_INVOICE_DATA_LOOKUP_ENABLED` (preview
enables it by default); checkout behavior depends on its caller and is not
established by this lookup composition.

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
