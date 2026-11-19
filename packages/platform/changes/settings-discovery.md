- Discover settings, capability gaps and invariants from the installed catalogue
  and refusal vocabulary. The read-only settings API and the domain discovery
  exports are experimental.

Migration: Existing operations and installed-policy APIs keep their current
behavior. To opt into connected settings discovery, inject a reader for each
installed key you want to inspect. The reader reports row presence separately
from its value.
