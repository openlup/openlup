// Reference-application binding: this path keeps its importers while the implementation lives in
// @openlup/platform. One binding set, with the real supabase-js `createClient`, owns the bundle
// data port cache; the process environment is the default.

import { createDataBindings, type DataPortBindingOptions } from "@openlup/platform/data";
import { supabaseCreateClient } from "../adapters/supabase/dataGatewayClientFactory.js";

type Env = Record<string, string | undefined>;

const bindings = createDataBindings({ createSupabaseClient: supabaseCreateClient });

export function bindDataPort(dataKind: string, env: Env = process.env, requestOptions: DataPortBindingOptions = {}) {
  return bindings.bindDataPort(dataKind, env, requestOptions);
}

export function bindRequestActorDataPort(
  accessToken: string,
  env: Env = process.env,
  requestOptions: DataPortBindingOptions = {},
) {
  return bindings.bindRequestActorDataPort(accessToken, env, requestOptions);
}

export function bindBundleDataPort(env: Env = process.env) {
  return bindings.bindBundleDataPort(env);
}
