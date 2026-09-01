import { resolveAppPaths } from '../../apps/server/src/config.js';
import { openDatabase } from '../../apps/server/src/db/database.js';

const paths = resolveAppPaths();
const database = openDatabase(paths.databasePath, paths.migrationsDirectory);
try {
  const row = database.prepare(`
    SELECT
      COUNT(*) AS active,
      SUM(CASE WHEN tier IN ('video', 'detailed') THEN 1 ELSE 0 END) AS videos,
      SUM(CASE WHEN tier = 'detailed' THEN 1 ELSE 0 END) AS detailed
    FROM recipes
    WHERE is_active = 1
  `).get() as { readonly active: number; readonly videos: number | null; readonly detailed: number | null };
  process.stdout.write(`${JSON.stringify({
    active: row.active,
    videos: row.videos ?? 0,
    detailed: row.detailed ?? 0,
  })}\n`);
} finally {
  database.close();
}
