import { expect, it, vi } from "vitest";
import { createPostgresOutboxStore, createPostgresOutboxCompactor } from "../src/postgres.js";
import { buildOutboxEnqueue } from "../src/enqueue.js";
it("binds external values instead of interpolating identifiers or payloads",async()=>{
  const query=vi.fn(async()=>({rows:[{value:true}]})),store=createPostgresOutboxStore({query} as never);
  await store.markProcessed({eventId:"synthetic-id",claimToken:"quote'",metadata:{example:"value'"}});
  expect(query.mock.calls[0][0]).not.toContain("quote'");expect(query.mock.calls[0][1]).toEqual(["synthetic-id","quote'",JSON.stringify({example:"value'"})]);
  const enqueue=buildOutboxEnqueue({eventType:"example.created",aggregateType:"example",aggregateId:"id",idempotencyKey:"dedupe",payload:{}});expect(enqueue.text).toContain("on conflict (event_type, idempotency_key) do nothing");
});
it("refuses malformed acknowledgement/compaction responses",async()=>{
  const store=createPostgresOutboxStore({query:async()=>({rows:[{value:"not-boolean"}]})} as never);
  await expect(store.markProcessed({eventId:"id",claimToken:"token"})).rejects.toThrow("invalid_response");
  await expect(createPostgresOutboxCompactor({query:async()=>({rows:[{value:-1}]})} as never).compact({processedDays:30,discardedDays:90,limit:500})).rejects.toThrow("invalid_response");
});
