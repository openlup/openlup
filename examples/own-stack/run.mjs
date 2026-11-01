import { Pool } from "pg";
import { createApplication } from "./app.mjs";

if (!process.env.DATABASE_URL) throw new Error("runtime_database_url_required");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const server = createApplication({ pool, operatorToken: process.env.OPERATOR_TOKEN });
server.listen(Number(process.env.PORT ?? 3000), "127.0.0.1", () => console.log("Own-stack API listening on loopback"));
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  server.close(() => { void pool.end(); });
});
