/** @experimental Offline communications adapter conformance and scripted transport fake. */
export { runCommunicationsAdapterConformance } from "../adapterConformance.js";
export type {
  CommunicationsAdapterConformanceEvidence,
  CommunicationsAdapterConformanceSubject,
  CommunicationsConformanceOptions,
  CommunicationsQualification,
  CommunicationsQualificationLedgerEntry,
  EmailFaultCertificationHarness,
  EmailFullCertificationScenarios,
} from "../adapterConformance.js";
export { createInMemoryEmailTransport } from "../emailTransport.js";
export {
  createScriptedCommunicationsFake,
  ScriptedCommunicationsTransportError,
} from "../scriptedCommunicationsFake.js";
export type {
  RecordedCommunicationsFault,
  ScriptedCommunicationsFake,
  ScriptedCommunicationsOutcome,
} from "../scriptedCommunicationsFake.js";
