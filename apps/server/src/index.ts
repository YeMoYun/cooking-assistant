import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';

export const LOOPBACK_LISTEN_OPTIONS = {
  host: '127.0.0.1',
  port: 4_173,
} as const;

export const startServer = async (
  app: FastifyInstance = buildApp(),
): Promise<FastifyInstance> => {
  await app.listen(LOOPBACK_LISTEN_OPTIONS);
  return app;
};

const isMainModule = (): boolean => {
  const entryPoint = process.argv[1];
  return entryPoint !== undefined
    && pathToFileURL(resolve(entryPoint)).href === import.meta.url;
};

if (isMainModule()) {
  void startServer().catch(() => {
    process.stderr.write('Unable to start the local server.\n');
    process.exitCode = 1;
  });
}
