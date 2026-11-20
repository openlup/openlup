import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { z, type ZodType } from "zod";
import { runSettingsCommand } from "./settingsCommand.js";
import { admitDatabaseUrl, checkResultSchema } from "./settingsCommandSupport.js";
import { fileObservationSchema, loadSettingsCatalogue, settingsDocuments } from "./settingsCatalog.js";
import { settingRefusalSchema, toolInputSchema } from "./toolSchema.js";

const contextOptions = { app: { type: "string" }, configuration: { type: "string" }, "database-url": { type: "string" } } as const;
export function settingsMcpContext(args: string[]) {
  const usage = "Use openlup settings mcp [--app <module>] [--configuration <id>] [--database-url <url>].";
  try {
    const { values } = parseArgs({ args, options: contextOptions });
    if (values.app === "" || (values.configuration !== undefined && !values.app)) return { hint: usage };
    const url = values["database-url"];
    const admitted = url === undefined ? undefined : admitDatabaseUrl(url);
    if (admitted && "hint" in admitted) return { hint: admitted.hint };
    if (values.app) values.app = resolve(values.app);
    return { context: values };
  } catch {
    return { hint: usage };
  }
}

type Context = NonNullable<ReturnType<typeof settingsMcpContext>["context"]>;
type Host = Parameters<typeof runSettingsCommand>[2];
export function settingsMcpTools(preview: ZodType) {
  const refusal = settingRefusalSchema([...loadSettingsCatalogue().byCode.keys()]);
  const version = z.literal(1);
  const { showResult, listResult } = settingsDocuments();
  const key = z.string().optional();
  return Object.entries({
    list: ["Find public or app settings by goal.", z.strictObject({ goal: key }), listResult],
    show: ["Read a setting by key.", z.strictObject({ key }), showResult.extend({ observation: fileObservationSchema })],
    explain: ["Explain a setting or a refusal code.", z.strictObject({ keyOrCode: key }), z.union([showResult, z.strictObject({ schemaVersion: version, explanation: refusal })])],
    check: ["Check the app's file settings offline.", z.strictObject({}), checkResultSchema],
    preview: ["Preview a proposed setting value without writing.", z.strictObject({ key, value: z.json().optional(), skus: z.array(z.string()).optional(), asOf: key }), preview],
  } satisfies Record<string, [string, ZodType, ZodType]>).map(([command, [description, input, result]]) => {
    const output = z.union([result, z.strictObject({ schemaVersion: version, refusal })]);
    return { command, input, output, definition: { name: `settings_${command}`, description,
      inputSchema: toolInputSchema(input), outputSchema: { type: "object", ...toolInputSchema(output, "output") },
      annotations: { readOnlyHint: true } } };
  });
}
type Tool = ReturnType<typeof settingsMcpTools>[number];
type ToolArguments = { key?: string; keyOrCode?: string; goal?: string; value?: unknown; skus?: string[]; asOf?: string };
export async function callSettingsTool(tool: Tool, args: ToolArguments, context: Context, host: Host) {
  const { command, output } = tool;
  const argv = [command, "--json"];
  for (const [flag, value] of Object.entries(context)) {
    if (flag !== "database-url" || command === "show" || command === "preview") argv.push(`--${flag}=${value}`);
  }
  if (args.goal !== undefined) argv.push(`--goal=${args.goal}`);
  if (args.asOf !== undefined) argv.push(`--as-of=${args.asOf}`);
  if (args.value !== undefined) argv.push("--value=-");
  for (const sku of args.skus ?? []) argv.push(`--sku=${sku}`);
  const key = args.key ?? args.keyOrCode;
  if (key !== undefined) argv.push("--", key);
  let line = "";
  const exit = await runSettingsCommand(argv, { write: text => { line += text; },
    readStdin: async () => JSON.stringify(args.value) }, host);
  try {
    const document: unknown = JSON.parse(line);
    if (output.safeParse(document).success) return {
      isError: exit !== 0, structuredContent: document, content: [{ type: "text", text: line.trimEnd() }],
    };
  } catch { /* An unreadable command document is an invalid tool result. */ }
  return { isError: true, content: [{ type: "text", text: "The settings command returned an invalid document. Check the installed package version and app binding." }] };
}

// Bound the partial line as in the Core context server, including recovery after an oversized frame.
async function* lines(input: AsyncIterable<Buffer>) {
  const limit = 1024 * 1024;
  let line: Buffer | undefined = Buffer.alloc(0);
  for await (const chunk of input) {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline === -1 ? chunk.length : newline;
      if (line && line.length + end - start > limit) { line = undefined; yield undefined; }
      if (line) line = Buffer.concat([line, chunk.subarray(start, end)]);
      if (newline !== -1) {
        if (line) yield line;
        line = Buffer.alloc(0);
      }
      start = end + 1;
    }
  }
  if (line?.length) yield line;
}

const request = z.object({ jsonrpc: z.literal("2.0"), method: z.string(), id: z.union([z.string(), z.number()]).optional(), params: z.unknown().optional() });
const object = z.record(z.string(), z.unknown());
const initialize = z.object({ protocolVersion: z.string(), capabilities: object, clientInfo: z.object({ name: z.string(), version: z.string() }) });
const call = z.strictObject({ name: z.string(), arguments: z.unknown().optional(), _meta: object.optional() });

export async function runSettingsMcp(input: AsyncIterable<Buffer>, write: (line: string) => void, context: Context, host: Host, preview: ZodType) {
  const tools = settingsMcpTools(preview);
  const { version } = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
  const reply = (id: string | number | null, result: object) => write(JSON.stringify({ jsonrpc: "2.0", id, ...result }) + "\n");
  const invalidTool = "Invalid tool or arguments. See tools/list.";
  const error = (id: string | number | null, code: number, message: string) => reply(id, { error: { code, message } });
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  for await (const line of lines(input)) {
    if (line === undefined) { error(null, -32600, "Message exceeds 1 MiB"); continue; }
    let json: unknown;
    try { json = JSON.parse(decoder.decode(line)); } catch { error(null, -32700, "Parse error"); continue; }
    const parsed = request.safeParse(json);
    if (!parsed.success) { error(null, -32600, "Invalid request"); continue; }
    const { id, method, params } = parsed.data;
    if (id === undefined) continue;
    let validatingArguments = false;
    try {
      if (method === "initialize" && initialize.safeParse(params).success) {
        reply(id, { result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "openlup-settings", version } } });
      } else if (method === "ping" && object.optional().safeParse(params).success) {
        reply(id, { result: {} });
      } else if (method === "tools/list" && z.strictObject({ _meta: object.optional() }).optional().safeParse(params).success) {
        reply(id, { result: { tools: tools.map(tool => tool.definition) } });
      } else if (method === "tools/call") {
        validatingArguments = true;
        const selected = call.safeParse(params);
        const tool = selected.success ? tools.find(item => item.definition.name === selected.data.name) : undefined;
        const args = selected.success && selected.data.arguments !== undefined ? selected.data.arguments : {};
        const valid = tool && tool.input.safeParse(args).success;
        validatingArguments = false;
        if (!valid) error(id, -32602, invalidTool);
        else reply(id, { result: await callSettingsTool(tool, args as ToolArguments, context, host) });
      } else if (["initialize", "ping", "tools/list"].includes(method)) {
        error(id, -32602, "Invalid params");
      } else {
        error(id, -32601, "Method not found");
      }
    } catch {
      if (validatingArguments) error(id, -32602, invalidTool);
      else error(id, -32603, "Internal error");
    }
  }
}
