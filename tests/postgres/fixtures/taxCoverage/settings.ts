import { runSettingsCommand, type SettingReader } from "@openlup/platform/operations/server";

export async function showCoverageSetting(databaseUrl?: string, reader?: SettingReader) {
  let output = "";
  const args = ["show", "tax.coverage", "--json", ...(databaseUrl ? ["--database-url", databaseUrl] : [])];
  const readers: Record<string, SettingReader> = reader ? { "tax.coverage": reader } : {};
  const status = await runSettingsCommand(args, {
    write: text => { output += text; }, readStdin: async () => "",
  }, { bind: async () => ({ readers }) });
  return { status, body: JSON.parse(output) as unknown };
}
