import { resolveAppPaths } from '../../apps/server/src/config.js';
import { openDatabase } from '../../apps/server/src/db/database.js';

const paths = resolveAppPaths();
const database = openDatabase(paths.databasePath, paths.migrationsDirectory);
try {
  const row = database.prepare(`
    SELECT
      COUNT(*) AS active,
      SUM(CASE WHEN tier IN ('video', 'detailed') THEN 1 ELSE 0 END) AS videos,
      SUM(CASE WHEN tier = 'detailed' THEN 1 ELSE 0 END) AS detailed,
      SUM(CASE WHEN content_version = 'mirecipe-rich2' THEN 1 ELSE 0 END) AS rich,
      SUM(CASE WHEN cover_remote_url IS NOT NULL THEN 1 ELSE 0 END) AS covers
    FROM recipes
    WHERE is_active = 1
  `).get() as {
    readonly active: number;
    readonly videos: number | null;
    readonly detailed: number | null;
    readonly rich: number | null;
    readonly covers: number | null;
  };
  const stepRow = database.prepare(`
    SELECT
      COUNT(*) AS steps,
      SUM(CASE WHEN
        duration_seconds_min IS NOT NULL
        AND duration_seconds_max IS NOT NULL
        AND heat_or_device IS NOT NULL
        AND completion_cue IS NOT NULL
        AND common_mistake IS NOT NULL
        AND safety_requirement IS NOT NULL
      THEN 1 ELSE 0 END) AS guided
    FROM recipe_steps rs
    JOIN recipes r ON r.id = rs.recipe_id
    WHERE r.is_active = 1
  `).get() as { readonly steps: number; readonly guided: number | null };
  process.stdout.write(`${JSON.stringify({
    active: row.active,
    videos: row.videos ?? 0,
    detailed: row.detailed ?? 0,
    rich: row.rich ?? 0,
    covers: row.covers ?? 0,
    steps: stepRow.steps,
    guidedSteps: stepRow.guided ?? 0,
  })}\n`);
} finally {
  database.close();
}
