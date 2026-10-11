import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { resolve } from 'node:path';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = createApp(config, { databasePath: resolve(process.cwd(), '.sayland/workspace.sqlite') });
  let closing = false;
  async function close(): Promise<void> {
    if (closing) return;
    closing = true;
    await app.close();
  }
  process.once('SIGINT', () => { void close(); });
  process.once('SIGTERM', () => { void close(); });
  await app.listen({ host: '127.0.0.1', port: config.port });
  process.stdout.write(`Sayland API listening at http://127.0.0.1:${config.port}\n`);
}

main().catch(() => {
  // Provider/configuration errors may contain sensitive input; only a stable message is printed.
  process.stderr.write('Sayland API could not start. Check the local configuration and port.\n');
  process.exitCode = 1;
});
