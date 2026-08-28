import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';

export const LOOPBACK_LISTEN_OPTIONS = {
  host: '127.0.0.1',
  port: 4_173,
} as const;

export const VITE_DEVELOPMENT_ORIGIN = 'http://localhost:5173';

export const resolveWebDistDirectory = (
  moduleUrl: string = import.meta.url,
): string => resolve(
  dirname(fileURLToPath(moduleUrl)),
  '..',
  '..',
  'web',
  'dist',
);

export const buildProductionApp = (): FastifyInstance => buildApp({
  webDistDirectory: resolveWebDistDirectory(),
});

export const startServer = async (
  app: FastifyInstance = buildProductionApp(),
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
  const isViteDevelopment = process.argv.includes('--vite-development');
  const app = isViteDevelopment
    ? buildApp({ allowedMutationOrigins: [VITE_DEVELOPMENT_ORIGIN] })
    : buildProductionApp();

  void startServer(app).catch(() => {
    process.stderr.write('Unable to start the local server.\n');
    process.exitCode = 1;
  });
}
