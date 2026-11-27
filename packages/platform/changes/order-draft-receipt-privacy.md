### Native order draft receipt privacy

Native privacy export and erasure recognize the order draft receipt owner once the database declares it. Export reports missing receipt principal links as incomplete coverage. Erasure clears both receipt owner references and retains the order owner's order reference, the derived replay key and the original draft outcome.

Hosts with a custom native privacy composition can register the experimental `createOrderDraftReceiptsPrivacyContributor` factory from the stable `@openlup/platform/identity` subpath. An installation owner must reconcile earlier erasures that lack recorded order draft receipt coverage before they can replay under the new declaration.
