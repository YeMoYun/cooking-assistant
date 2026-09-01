import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { resolveAppPaths } from './config.js';
import { openDatabase } from './db/database.js';
import { DpapiSecretStore } from './features/providers/dpapi-secret-store.js';

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

const buildDatabaseBackedApp = async (
  options: Parameters<typeof buildApp>[0],
): Promise<FastifyInstance> => {
  const paths = resolveAppPaths();
  const database = openDatabase(paths.databasePath, paths.migrationsDirectory);
  try {
    const secretStore = await DpapiSecretStore.create();
    const app = buildApp({
      ...options,
      database,
      secretStore,
      visionTempDirectory: join(paths.dataDirectory, 'vision-temp'),
    });
    app.addHook('onClose', (_instance, done) => {
      if (database.open) {
        database.close();
      }
      done();
    });
    return app;
  } catch (error) {
    database.close();
    throw error;
  }
};

export const buildProductionApp = (): Promise<FastifyInstance> => (
  buildDatabaseBackedApp({ webDistDirectory: resolveWebDistDirectory() })
);

export const startServer = async (
  app?: FastifyInstance,
): Promise<FastifyInstance> => {
  const resolvedApp = app ?? await buildProductionApp();
  await resolvedApp.listen(LOOPBACK_LISTEN_OPTIONS);
  return resolvedApp;
};

const isMainModule = (): boolean => {
  const entryPoint = process.argv[1];
  return entryPoint !== undefined
    && pathToFileURL(resolve(entryPoint)).href === import.meta.url;
};

if (isMainModule()) {
  const isViteDevelopment = process.argv.includes('--vite-development');
  const appPromise = isViteDevelopment
    ? buildDatabaseBackedApp({
        allowedMutationOrigins: [VITE_DEVELOPMENT_ORIGIN],
        allowLoopbackProviderHttp: true,
      })
    : buildProductionApp();

  void appPromise.then((app) => startServer(app)).catch((error: unknown) => {
    process.stderr.write('Unable to start the local server.\n');
    console.error(error);
    process.exitCode = 1;
  });
}
