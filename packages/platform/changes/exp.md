- Mark unbound catalogue extension symbols `@experimental`; retain the
  starter's consumed product-type input without the tag.

Migration: no runtime, signature, export or database change. The added TSDoc tags
identify experimental symbols for compatibility guidance; existing readers keep
their contracts.
