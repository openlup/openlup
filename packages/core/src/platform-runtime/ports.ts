/** Structural request shape for host HTTP adapters. */
/** @beta */
export interface PlatformHttpRequest {
  url?: string;
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string | string[] | undefined>;
  cookies?: Record<string, string>;
  body?: unknown;
}

/** Structural response shape for host HTTP adapters. */
/** @beta */
export interface PlatformHttpResponse {
  statusCode?: number;
  headersSent?: boolean;
  writableEnded?: boolean;
  status(code: number): this;
  setHeader?(name: string, value: string | number | readonly string[]): this;
  json(body: unknown): this;
  send(body: unknown): this;
  end?(body?: unknown): this;
  redirect(url: string): this;
  redirect(status: number, url: string): this;
}

/** Host runtime: turn an incoming request into a handled response + mount a server. */
/** @beta */
export interface HttpRuntimePort {
  /** Dispatch a single request through downstream routes. */
  handle(req: PlatformHttpRequest, res: PlatformHttpResponse): Promise<unknown> | unknown;
  /** Start listening. Serverless adapters may no-op. */
  listen?(options: { port: number; host?: string }): Promise<void> | void;
}

/** Scheduled jobs: register cron-like work. */
/** @beta */
export interface SchedulerPort {
  register(input: { jobId: string; schedule: string; handler: () => Promise<void> | void }): void;
  /** Verify a scheduler invocation is authentic. */
  verifyInvocation(req: PlatformHttpRequest): boolean;
}

/** Object storage. */
/** @beta */
export interface BlobStoragePort {
  upload(
    key: string,
    data: Uint8Array,
    options?: { contentType?: string },
  ): Promise<{ url: string; pathname: string }>;
  exists(key: string): Promise<boolean>;
  delete(keyOrUrl: string): Promise<void>;
  list(prefix?: string): Promise<{ keys: string[] }>;
  urlFor(key: string): string;
}

/** Persistence gateway: run reads/writes as a given actor. */
/** @beta */
export interface DataGatewayPort {
  /** Execute a unit of work bound to an actor's claims. */
  asActor<T>(
    claims: { sub?: string; role?: string } | null,
    work: (gateway: unknown) => Promise<T>,
  ): Promise<T>;
  /** Service-role/elevated access. */
  asService<T>(work: (gateway: unknown) => Promise<T>): Promise<T>;
}

/** Schema apply. */
/** @beta */
export interface MigrationRunnerPort {
  status(): Promise<{ pending: string[]; applied: string[] }>;
  apply(options?: { dryRun?: boolean }): Promise<{ applied: string[] }>;
}

/** Frontend analytics. */
/** @beta */
export interface AnalyticsPort {
  trackPageView(pathname: string): void;
  trackEvent(name: string, properties?: Record<string, unknown>): void;
}

/** Transactional runtime for queue/function dispatch. */
/** @beta */
export interface TransactionalRuntimePort {
  invoke(functionName: string, payload: unknown): Promise<{ ok: boolean; status: number }>;
}
