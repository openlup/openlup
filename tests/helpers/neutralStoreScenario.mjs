import { once } from 'node:events';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function bindScenarioServer() {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('starter_scenario_port_required');
  // The starter reads its origin policy from the arguments when server.ts loads.
  process.argv.push('--port', String(address.port));
  return { server, port: address.port, base: `http://${address.address}:${address.port}` };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Recovery keeps its listener across child restarts and hands us the sockets.
  const endpoint = process.connected ? undefined : await bindScenarioServer();
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
  const application = createApplication(bindings);
  const server = endpoint?.server ?? application;
  server.requestTimeout = 25000;
  server.headersTimeout = 10000;

  const sockets = new Set();
  if (endpoint) {
    server.on('request', application.listeners('request')[0]);
  } else {
    process.on('message', (_message, socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      server.emit('connection', socket);
      socket.resume();
    });
  }
  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    const closeBindings = () => { void bindings.close().finally(() => { process.exitCode = 0; }); };
    if (endpoint) {
      server.close(closeBindings);
      server.closeIdleConnections();
    } else {
      process.disconnect();
      for (const socket of sockets) socket.destroy();
      closeBindings();
    }
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.stdout.write(`Neutral store local candidate: ${endpoint?.base ?? `http://127.0.0.1:${options.port}`}\n`);
}
