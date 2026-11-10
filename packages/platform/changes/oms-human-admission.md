- Allow a preprovisioned Commerce operator with active human admin membership and no control row to resolve for OMS commands. Preserve the existing active machine-control route, SQL STABLE invoker header and ACL.

Migration:

Install the complete selected native prefix through `20261110160000_oms_human_operator_admission.sql`. The owner must provision one Commerce row per human admin and never delete it; withdraw authority by revoking membership. The existing creator ON DELETE SET NULL hazard remains. Hosts enforce human-admin admission and resolve before every command and replay. Starter route binding is separate.

- Documentation gzip measures 83,212 B, crossing the merged 83,177 B cap by 35 B; the documentation cap is 84,877 B (measured × 1.02, rounded up). Other caps and the released baseline are retained.
