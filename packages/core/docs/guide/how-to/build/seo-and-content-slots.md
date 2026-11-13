# Compose SEO and content slots

Build page metadata and structured data from your application's routes, company
facts and content. Render the returned descriptors through your own head manager
and page components.

## Choose the imports

Import runtime helpers from `@openlup/platform/marketing` and content types
from `@openlup/platform/marketing/contracts`. See the
[runtime API report](https://github.com/openlup/openlup/blob/openlup-core-v0.40.0/packages/platform/api/marketing.api.md) and
[contracts API report](https://github.com/openlup/openlup/blob/openlup-core-v0.40.0/packages/platform/api/marketing-contracts.api.md)
for the available helpers and types. These helpers take values, without
database or transport ports. Your application supplies route lookup,
translations, content and document updates.

## Build the head descriptor

Describe each route with `id`, `locale`, `canonicalPath` and an optional
`alternateRouteId`. `normalizeSitePath` adds a leading slash and removes a
trailing slash from a non-root path. `absoluteSiteUrl` and
`canonicalUrlForRoute` combine that path with your origin.

Call `buildHeadDescriptor` with `HeadFacts`: origin, selected route, route list,
default locale, document language, title, description, site name and social
image facts. Supply image dimensions and the required social account handle as
well as image URLs. Select `noindex` when the descriptor should emit
`noindex, nofollow`.

Render its `htmlLang`, `title`, ordered `tags` and optional `jsonLd` payload.
The ordered tags always include `og:image:width`, `og:image:height` and
`twitter:site`. An alternate route produces locale-sorted hreflang links plus
`x-default`. If the requested default locale is absent from the pair, the first
sorted route becomes the default. An unresolved alternate produces no hreflang
links. The alternate social locale tag appears only when you supply its value.

## Assemble structured data

Use `organizationLd`, `brandLd`, `websiteLd`, `contactPageLd`, `productLd`,
`faqPageLd` and `breadcrumbLd` with facts you own. `entityIds` derives shared
organization, website and brand identifiers from your origin. `schemaWeight`
converts `unscaled` and `scale` to a quantitative value; `GRAM` and `G` map to
`GRM`.

Combine nodes with `jsonLdGraph`. It removes each node's local `@context` and
keeps the first node with a repeated nonempty `@id`. `serializeJsonLd` escapes
script-breaking characters while retaining the parsed JSON value. Passing nodes
to `buildHeadDescriptor` performs graph assembly and serialization for you;
without nodes its `jsonLd` is null. The helpers return data and strings; your
renderer owns inserting the structured-data script into the document.

## Supply contact and legal content

Pass `ContactContent` to `contactContent`. The result contains `supportEmail`
and company lines in legal-name, address, registration-identifiers and optional
registration-authority order. Identifier label/value pairs keep their input
order, separated by ` · `. Supplied blank lines are preserved.

Pass `LegalDocumentContent` to `legalDocumentContent` to retain the title,
introduction, ordered title/body sections and optional `lastUpdated` text.
Use `PrivacyProcessorDisclosure` to type your own processor inventory; it has
no runtime renderer.

## Handle missing or invalid facts

These helpers define no domain refusal-code result and perform no content
validation. Validate your route, company and content inputs before composition.
Missing alternate routes and empty structured-data inputs produce the empty
outputs described above. The package supplies no legal wording or processor
inventory, and formatting content establishes no legal outcome.
