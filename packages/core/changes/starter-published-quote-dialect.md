### Browse and quote published starter products

The native starter lists published SKUs, keeps exact sibling selections in
product URLs and checks SKU, quantity and currency in the server quote. Active
published products need a document schema distinct from the configured
application document schema and canonical draft JSON encoding.
The starter excludes SKUs without one-time sellability and reports
`starter_catalogue_one_time_required`. Enable one-time sellability through the
catalogue workflow to make the SKU eligible for listing.

Migration: Apply the managed starter upgrade. If you copied a storefront page
into application source, reconcile its SKU links, cart restoration and quote
checks with the candidate. Keep the existing owned card signature. For an
active schema collision, withdraw the colliding product through governed
catalogue commands and repeat the original quote.
