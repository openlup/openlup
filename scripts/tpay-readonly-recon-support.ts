import { existsSync, readFileSync, writeFileSync } from "node:fs";

export const TPAY_READONLY_RECON_VERSION = "tpay_readonly_recon.v1";

export const TPAY_OAUTH_ENDPOINTS = [
  { name: "sandbox", baseUrl: "https://openapi.sandbox.tpay.com" },
  { name: "production", baseUrl: "https://api.tpay.com" },
] as const;

const SECRET_KEY_RE = /^(clientId|clientSecret|secret|token|accessToken|authorization|password|key|blikToken|signature)$/i;

export type EnvLike = Record<string, string | undefined>;

export type Endpoint = (typeof TPAY_OAUTH_ENDPOINTS)[number];

export type CredentialPair = {
  pair: "primary" | "pair_2" | "sandbox_explicit";
  source: string;
  clientId: string;
  clientSecret: string;
};

export type Channel = {
  id: string;
  name: string;
  fullName: string;
  available: boolean;
  onlinePayment: boolean;
  instantRedirection: boolean;
  groups: Array<{ id: number; name: string }>;
};

export type ResponseLike = {
  ok: boolean;
  status: number;
  clone(): { json(): Promise<unknown> };
};

export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: URLSearchParams;
  },
) => Promise<ResponseLike>;

export type OAuthProbe = {
  endpoint: Endpoint["name"];
  ok: boolean;
  status: number | null;
  providerCode: string | null;
  elapsedMs: number;
  accessToken: string;
};

export type CredentialPairSummary = {
  pair: CredentialPair["pair"];
  source: string;
  hasClientId: boolean;
  hasSecret: boolean;
  oauth: Array<Omit<OAuthProbe, "accessToken">>;
  productionChannels: JsonRecord | null;
};

export type JsonRecord = Record<string, unknown>;

export type ReadonlyReconSummary = {
  ok: true;
  mode: typeof TPAY_READONLY_RECON_VERSION;
  generatedAt: string;
  source: {
    envFile: string;
    envFileLoaded: boolean;
  };
  safety: {
    mutatingCalls: false;
    endpointsCalled: string[];
    sandboxEvidence: false;
    publicActivationAllowed: false;
    productionCredentialsInPreviewOrCi: false;
  };
  findings: {
    productionReadonlyAvailable: boolean;
    productionReadonlyPair: CredentialPair["pair"] | null;
    sandboxCredentialsAvailable: boolean;
    sandboxBlockers: Array<{
      pair: CredentialPair["pair"];
      status: number | null;
      providerCode: string | null;
    }>;
  };
  credentialPairs: CredentialPairSummary[];
};

export function parseEnvText(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index < 0) continue;
    const key = line.slice(0, index).trim();
    if (!key) continue;
    env[key] = parseEnvValue(line.slice(index + 1).trim());
  }
  return env;
}

export function parseEnvValue(value: string): string {
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("'\\''", "'");
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replaceAll('\\"', '"');
  }
  return value;
}

export function loadReconEnv({
  env = process.env,
  envFile = ".env.tpay.local",
}: {
  env?: EnvLike;
  envFile?: string;
} = {}): Record<string, string> {
  const fileEnv = envFile && existsSync(envFile) ? parseEnvText(readFileSync(envFile, "utf8")) : {};
  const explicitEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value !== "") explicitEnv[key] = value;
  }
  return { ...fileEnv, ...explicitEnv };
}

export function credentialPairsFromEnv(env: EnvLike): CredentialPair[] {
  const pairs: CredentialPair[] = [
    {
      pair: "primary",
      source: "TPAY_CLIENT_ID/TPAY_CLIENT_SECRET",
      clientId: env.TPAY_CLIENT_ID ?? env.TPAY_PRODUCTION_CLIENT_ID ?? "",
      clientSecret: env.TPAY_CLIENT_SECRET ?? env.TPAY_PRODUCTION_CLIENT_SECRET ?? "",
    },
    {
      pair: "pair_2",
      source: "TPAY_CREDENTIAL_PAIR_2_CLIENT_ID/TPAY_CREDENTIAL_PAIR_2_CLIENT_SECRET",
      clientId: env.TPAY_CREDENTIAL_PAIR_2_CLIENT_ID ?? "",
      clientSecret: env.TPAY_CREDENTIAL_PAIR_2_CLIENT_SECRET ?? "",
    },
    {
      pair: "sandbox_explicit",
      source: "TPAY_SANDBOX_CLIENT_ID/TPAY_SANDBOX_CLIENT_SECRET",
      clientId: env.TPAY_SANDBOX_CLIENT_ID ?? "",
      clientSecret: env.TPAY_SANDBOX_CLIENT_SECRET ?? "",
    },
  ];
  return pairs.filter((pair) => pair.clientId || pair.clientSecret);
}

export function assertLocalReadonlyReconEnv(env: EnvLike): void {
  if (env.CI === "true" || env.GITHUB_ACTIONS === "true" || env.VERCEL === "1") {
    throw new Error("tpay_readonly_recon_refuses_ci_or_preview");
  }
}

export function normalizeChannel(channel: unknown): Channel {
  const record = asRecord(channel);
  return {
    id: String(record.id ?? ""),
    name: String(record.name ?? ""),
    fullName: String(record.fullName ?? record.name ?? ""),
    available: record.available === true,
    onlinePayment: record.onlinePayment === true,
    instantRedirection: record.instantRedirection === true,
    groups: Array.isArray(record.groups)
      ? record.groups.map((group) => {
        const groupRecord = asRecord(group);
        return {
          id: Number(groupRecord.id ?? 0),
          name: String(groupRecord.name ?? ""),
        };
      })
      : [],
  };
}

export function isBlikChannel(channel: Channel): boolean {
  const text = `${channel.id} ${channel.name} ${channel.fullName} ${channel.groups.map((group) => group.name).join(" ")}`;
  return channel.groups.some((group) => group.id === 150) || /blik/i.test(text);
}

export function isPblChannel(channel: Channel): boolean {
  if (!channel.available || isBlikChannel(channel)) return false;
  return channel.onlinePayment && channel.instantRedirection;
}

export function summarizeCandidates(channels: Channel[]): JsonRecord {
  return {
    total: channels.length,
    available: channels.filter((channel) => channel.available).length,
    candidates: channels.slice(0, 10).map((channel) => ({
      id: channel.id,
      name: channel.name,
      fullName: channel.fullName,
      available: channel.available,
      onlinePayment: channel.onlinePayment,
      instantRedirection: channel.instantRedirection,
      groupIds: channel.groups.map((group) => group.id).filter(Boolean),
    })),
  };
}

export function redact<T>(value: T): T {
  if (Array.isArray(value)) return value.map(redact) as T;
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, raw]) => {
    if (SECRET_KEY_RE.test(key)) return [key, "[redacted]"];
    return [key, redact(raw)];
  })) as T;
}

export function writeReconSummary(path: string, summary: unknown): void {
  writeFileSync(path, `${JSON.stringify(redact(summary), null, 2)}\n`, "utf8");
}

export function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? value as JsonRecord : {};
}
