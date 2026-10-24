/** Direct donor extraction: host supplies attachment kinds, durable provider
 * references, status/event keys, hashing and recording. Downloads confer no blob
 * storage proof. The optional observation mode retains polling without adding
 * another public runner/export or provider-specific status vocabulary. */
export async function syncAcceptedInvoiceDocuments<Target, Status, Document>(input: {
  target: Target;
  status: Status;
  downloads: readonly ((target: Target) => Promise<Document>)[];
  record(target: Target, status: Status, documents: readonly Document[]): Promise<unknown>;
}): Promise<void>;
export async function syncAcceptedInvoiceDocuments<Target, Status, Document>(input: {
  targets(): Promise<readonly Target[]>;
  observe(target: Target): Promise<Status>;
  recordStatus(target: Target, status: Status): Promise<unknown>;
  accepted(status: Status): boolean;
  downloads: readonly ((target: Target) => Promise<Document>)[];
  record(target: Target, status: Status, documents: readonly Document[]): Promise<unknown>;
}): Promise<{ ok: boolean; checked: number; updated: number; skipped: false; failures: number }>;
export async function syncAcceptedInvoiceDocuments<Target, Status, Document>(input: {
  target?: Target;
  status?: Status;
  targets?: () => Promise<readonly Target[]>;
  observe?: (target: Target) => Promise<Status>;
  recordStatus?: (target: Target, status: Status) => Promise<unknown>;
  accepted?: (status: Status) => boolean;
  downloads: readonly ((target: Target) => Promise<Document>)[];
  record(target: Target, status: Status, documents: readonly Document[]): Promise<unknown>;
}): Promise<void | { ok: boolean; checked: number; updated: number; skipped: false; failures: number }> {
  const sync = async (target: Target, status: Status) => {
    const documents = await Promise.all(input.downloads.map(download => download(target)));
    await input.record(target, status, documents);
  };
  if (!input.targets) {
    await sync(input.target as Target, input.status as Status);
    return;
  }
  const targets = await input.targets();
  let updated = 0;
  let failures = 0;
  for (const target of targets) {
    try {
      const status = await input.observe!(target);
      await input.recordStatus!(target, status);
      if (input.accepted!(status)) await sync(target, status);
      updated += 1;
    } catch {
      failures += 1;
    }
  }
  return { ok: failures === 0, checked: targets.length, updated, skipped: false as const, failures };
}
