export {
  AXIOM_PROVIDER_KIND,
  AXIOM_STATIC_CAPABILITIES,
  DEFAULT_AXIOM_MAX_BATCH_SIZE,
  DEFAULT_AXIOM_SERVICE,
  createAxiomTelemetryAdapter,
  mapTelemetryEventToAxiomRecord,
  projectAxiomStaticCapabilities,
  type CreateAxiomTelemetryAdapterOptions,
} from "./adapter.js";
export {
  AXIOM_DATASET_PATTERN,
  AXIOM_ORIGIN,
  AxiomClientError,
  assertValidAxiomApiToken,
  assertValidAxiomDataset,
  createAxiomHttpClient,
  type AxiomClient,
  type AxiomEventRecord,
  type AxiomHttpClientOptions,
  type AxiomIngestFailure,
  type AxiomIngestResponse,
  type FetchLike,
} from "./client-contract.js";
