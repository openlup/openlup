import { createBffResponder, type BffResponderOptions } from "../bff/index.js";
export type IdentityResponseOptions = BffResponderOptions;
export const createIdentityResponder = createBffResponder;
