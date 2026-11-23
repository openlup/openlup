import { once } from 'node:events';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function bindScenarioServer() {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('starter_scenario_port_required');
  // Recovery already supplies its bound forwarding port. The other scenarios
  // give the starter the port of this listener before server.ts loads.
  if (!process.argv.includes('--port')) process.argv.push('--port', String(address.port));
  return { server, port: address.port, base: `http://${address.address}:${address.port}` };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server, base } = await bindScenarioServer();
  const { parseHostArguments } = await import('../../examples/neutral-store/shared/config.ts');
  const { selectConfiguration } = await import('../../examples/neutral-store/owned/store.config.ts');
  const { composeNativeBindings } = await import('../../examples/neutral-store/host/native-composition.ts');
  const { createOriginPolicy } = await import('../../examples/neutral-store/host/origin-policy.ts');
  const { readQuoteAcceptanceKeyring } = await import('../../examples/neutral-store/host/quote-secret.ts');
  const { createApplication } = await import('../../examples/neutral-store/host/server.ts');
  const options = parseHostArguments(process.argv.slice(2));
  const config = selectConfiguration(options.configuration);
  const keyring = await readQuoteAcceptanceKeyring(options.quoteAcceptanceKeyFile);
  const bindings = await composeNativeBindings(options.databaseUrl, createOriginPolicy(config, options.port), config, keyring);
  server.on('request', createApplication(bindings).listeners('request')[0]);
  server.requestTimeout = 25000;
  server.headersTimeout = 10000;

  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    server.close(() => { void bindings.close().finally(() => { process.exitCode = 0; }); });
    server.closeIdleConnections();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.stdout.write(`Neutral store local candidate: ${base}\n`);
}
