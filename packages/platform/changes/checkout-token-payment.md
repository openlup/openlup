- Add sandbox token payment on the existing intent and durable attempt owner, with request replay, method binding, locked checkout admission and retry-later errors for unresolved attempts. Add an injected first-purchase method-hold wrapper. Renewal cycles refuse; initial declarations remain eligible. Verified ingress retains settlement ownership and other channels keep their named native refusal.

Migration: Apply the additive checkout-attempt admission forward after atomic guidance. It creates one service-only entry point without replacing existing functions or adding storage.
