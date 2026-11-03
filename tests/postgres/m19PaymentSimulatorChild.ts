// A fresh Node process: only the runtime connection and request identities cross restart.
import { Pool } from "pg";
import { createPostgresSandboxPaymentSimulator } from "@openlup/platform/payments";
const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const db = new Pool({ connectionString: input.connectionString });
try {
  const simulator = createPostgresSandboxPaymentSimulator(db, input.options);
  if (input.command === "stale") {
    try { await simulator.recordObservation(input.observation); process.stdout.write(JSON.stringify({ refused: false })); }
    catch (error) { process.stdout.write(JSON.stringify({ refused: true, reason: (error as Error).message })); }
  } else {
    const before = await simulator.readAttempt(input.identity);
    const begun = await simulator.beginAttempt(input.begin);
    const response = await simulator.ingress.receive({ rawBody: new TextEncoder().encode(JSON.stringify(input.delivery)), headers: {}, receivedAt: "2030-01-01T00:00:00Z" });
    process.stdout.write(JSON.stringify({ before, begun, response }));
  }
} finally { await db.end(); }
