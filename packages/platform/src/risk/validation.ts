import { z } from "zod";

// Every browser value import reaches Zod through this module. Configure its
// runtime before a schema can run so the CSP-safe path never probes `eval`.
z.config({ jitless: true });

export { z };
