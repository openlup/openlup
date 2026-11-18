/** Private persistence seam. Domain owners supply validation and compatibility defaults. */
export function installedPolicy<T>(db: {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}, key: string, validate: (value: unknown) => T, fallback: T, code: string) {
  async function readOverride(): Promise<T | undefined> {
    const { rows } = await db.query("SELECT value_text FROM public.commerce_settings WHERE key=$1", [key]);
    if (!rows.length) return undefined;
    let value: unknown;
    try {
      if (typeof rows[0]?.value_text !== "string") throw new Error(code);
      value = JSON.parse(rows[0].value_text);
    } catch { throw new Error(code); }
    return validate(value);
  }
  return {
    readOverride,
    async read(): Promise<T> {
      return await readOverride() ?? { ...fallback };
    },
    async install(value: T): Promise<void> {
      const policy = validate(value);
      await db.query(`INSERT INTO public.commerce_settings(key,value_text) VALUES($1,$2)
        ON CONFLICT(key) DO UPDATE SET value_text=EXCLUDED.value_text`, [key, JSON.stringify(policy)]);
    },
  };
}
