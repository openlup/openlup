- Keep lower-maturity declarations referenced by stable `@openlup/platform` APIs in the stable snapshots so maintainers can detect type narrowing. The snapshot tool also checks that every reachable declaration appears in a report and that entrypoint directories have a single owner.

  Migration: No adopter action is required. Installed exports and runtime behavior are unchanged.
