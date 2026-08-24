import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AppPaths {
  readonly dataDirectory: string;
  readonly databasePath: string;
  readonly migrationsDirectory: string;
}

export interface AppPathOptions {
  readonly dataDirectory?: string;
  readonly moduleUrl?: string;
}

const requireLocalAppData = (): string => {
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData === undefined || localAppData.length === 0) {
    throw new Error(
      'LOCALAPPDATA is required unless dataDirectory is provided',
    );
  }
  return localAppData;
};

export const resolveAppPaths = (
  options: AppPathOptions = {},
): AppPaths => {
  const dataDirectory = options.dataDirectory
    ?? join(requireLocalAppData(), 'XiaoChu');
  const moduleDirectory = dirname(fileURLToPath(
    options.moduleUrl ?? import.meta.url,
  ));

  return {
    dataDirectory,
    databasePath: join(dataDirectory, 'xiaochu.sqlite'),
    migrationsDirectory: join(moduleDirectory, 'db', 'migrations'),
  };
};
