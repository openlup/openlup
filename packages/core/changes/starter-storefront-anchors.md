### The starter's checkout pages carry storefront anchors

The starter's checkout fields, submit and payment-status line carry
`storefrontAnchor` attributes. Behaviour and copy are unchanged.

Migration: Upgrade replaces pristine copies of
`examples/neutral-store/client/forms.ts` and
`examples/neutral-store/client/pages/checkout.ts`, and adds two tests. A
customised checkout page works without anchors. No installed-policy step.
