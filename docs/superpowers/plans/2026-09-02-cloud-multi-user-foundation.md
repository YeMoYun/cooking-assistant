# Cloud Multi-User Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add invitation-only accounts, persistent authentication, per-user data isolation, administrator model control, and AI quotas while retaining a trusted local development mode.

**Architecture:** Shared recipe/catalog tables remain global in one SQLite database. Every personal table receives an owner key, authenticated requests obtain their principal from a persistent opaque session, and repositories require the principal ID explicitly. Browser sessions use HttpOnly cookies plus CSRF; the later Android client uses bearer access/refresh tokens from the same session store.

**Tech Stack:** Node.js 24, Fastify 5, better-sqlite3, Zod 4, React 19, Vitest, built-in `crypto.scrypt`

---

### Task 1: Define authentication and administration contracts

**Files:**
- Create: `packages/shared/src/auth.ts`
- Create: `packages/shared/src/auth.test.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Write focused schema tests**

Cover valid login, invite registration, invalid usernames, weak passwords, unknown fields, auth responses, invitations, and admin quota updates.

- [ ] **Step 2: Run the tests and verify RED**

Run: `npx vitest run src/auth.test.ts` from `packages/shared`

Expected: FAIL because `auth.ts` is missing.

- [ ] **Step 3: Implement the shared contracts**

```ts
export const usernameSchema = z.string().trim().min(3).max(32)
  .regex(/^[A-Za-z0-9_\u4e00-\u9fff]+$/u)
export const passwordSchema = z.string().min(10).max(128)
export const loginInputSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  clientKind: z.enum(['browser', 'android']).default('browser'),
}).strict()
export const registerInputSchema = loginInputSchema.extend({
  inviteCode: z.string().trim().min(12).max(128),
}).strict()
export const authUserSchema = z.object({
  id: z.string().uuid(),
  username: usernameSchema,
  role: z.enum(['admin', 'tester']),
  disabled: z.boolean(),
}).strict()
export const authSessionSchema = z.object({
  user: authUserSchema,
  accessToken: z.string().min(32).optional(),
  refreshToken: z.string().min(32).optional(),
  accessExpiresAt: z.iso.datetime(),
  refreshExpiresAt: z.iso.datetime(),
  csrfToken: z.string().min(32).optional(),
}).strict()
export const createInvitationInputSchema = z.object({
  expiresInHours: z.number().int().min(1).max(720),
}).strict()
export const updateUserQuotaInputSchema = z.object({
  dailyLimit: z.number().int().min(0).max(10_000),
}).strict()
```

- [ ] **Step 4: Export and rerun tests**

Run: `npx vitest run src/auth.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add packages/shared/src/auth.ts packages/shared/src/auth.test.ts packages/shared/src/index.ts
git commit -m "feat: define cloud authentication contracts"
```

### Task 2: Add the cloud ownership migration

**Files:**
- Create: `apps/server/src/db/migrations/005_cloud_accounts.sql`
- Create: `apps/server/src/db/cloud-migration.test.ts`
- Modify: `apps/server/src/db/database.test.ts`

- [ ] **Step 1: Write migration tests**

Create a version-4 database containing one favorite, note, inventory item, shopping item, variant, pending action, recognition draft, voice session, and message. Migrate it and assert every personal row belongs to `00000000-0000-4000-8000-000000000001`, shared recipes remain unchanged, foreign keys pass, and a second migration run is a no-op.

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run src/db/cloud-migration.test.ts` from `apps/server`

Expected: FAIL because migration 005 does not exist.

- [ ] **Step 3: Create account and session tables**

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  username TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK(length(username) BETWEEN 3 AND 32),
  password_hash TEXT NOT NULL CHECK(length(password_hash) BETWEEN 40 AND 512),
  role TEXT NOT NULL CHECK(role IN ('admin','tester')),
  is_disabled INTEGER NOT NULL DEFAULT 0 CHECK(is_disabled IN (0,1)),
  daily_ai_limit INTEGER NOT NULL DEFAULT 100 CHECK(daily_ai_limit BETWEEN 0 AND 10000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE invitations (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  code_hash TEXT NOT NULL UNIQUE CHECK(length(code_hash)=64),
  created_by TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  consumed_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access_hash TEXT NOT NULL UNIQUE CHECK(length(access_hash)=64),
  refresh_hash TEXT NOT NULL UNIQUE CHECK(length(refresh_hash)=64),
  csrf_hash TEXT CHECK(csrf_hash IS NULL OR length(csrf_hash)=64),
  access_expires_at TEXT NOT NULL,
  refresh_expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE TABLE ai_usage_daily (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  usage_date TEXT NOT NULL,
  completed_turns INTEGER NOT NULL DEFAULT 0,
  reserved_turns INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id, usage_date)
);
CREATE TABLE user_data_versions (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id, scope)
);
```

Seed the legacy owner with an unusable hash and initialize inventory, shopping, and variants versions. Cloud startup later refuses an unclaimed legacy owner; trusted local mode uses it directly.

- [ ] **Step 4: Rebuild personal tables with owner keys**

Use SQLite rename/create/copy/drop operations inside the migration transaction. Add `user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE` to `favorites`, `recent_views`, `notes`, `inventory_items`, `shopping_items`, `recipe_variants`, `pending_actions`, `recognition_drafts`, and `voice_sessions`. Change favorites/recent keys to `(user_id, recipe_id)`, item identity to `(user_id, id)`, and add `(user_id, ...)` indexes. `voice_messages` inherits ownership through `voice_sessions`.

- [ ] **Step 5: Rerun database tests**

Run: `npx vitest run src/db/cloud-migration.test.ts src/db/database.test.ts`

Expected: PASS and `PRAGMA foreign_key_check` returns no rows.

- [ ] **Step 6: Commit**

```powershell
git add apps/server/src/db
git commit -m "feat: add multi-user database ownership"
```

### Task 3: Implement passwords, invitations, sessions, and quota state

**Files:**
- Create: `apps/server/src/features/auth/password-hasher.ts`
- Create: `apps/server/src/features/auth/password-hasher.test.ts`
- Create: `apps/server/src/features/auth/auth-repository.ts`
- Create: `apps/server/src/features/auth/auth-repository.test.ts`
- Create: `apps/server/src/features/auth/auth-types.ts`

- [ ] **Step 1: Write RED tests**

Test scrypt hash/verify, malformed hashes, one-time invitation consumption, duplicate usernames, access expiry, refresh rotation, session revocation, disabled users, and quota reservation/completion/release.

- [ ] **Step 2: Run focused tests**

Run: `npx vitest run src/features/auth/password-hasher.test.ts src/features/auth/auth-repository.test.ts`

Expected: FAIL because implementations are absent.

- [ ] **Step 3: Implement password hashing**

Use `scrypt` with a 16-byte salt, `N=32768`, `r=8`, `p=1`, 64-byte output, format `scrypt$32768$8$1$<salt-base64url>$<hash-base64url>`, and `timingSafeEqual` after strict parsing.

- [ ] **Step 4: Implement `AuthRepository`**

```ts
createInvitation(adminId: string, expiresAt: string): { code: string; expiresAt: string }
register(code: string, username: string, passwordHash: string): AuthUser
authenticate(username: string): { user: AuthUser; passwordHash: string } | undefined
createSession(userId: string, kind: 'browser'|'android'): IssuedSession
verifyAccess(token: string): AuthPrincipal | undefined
rotateRefresh(refreshToken: string): IssuedSession
revokeSession(sessionId: string, userId: string): void
revokeAllForUser(userId: string): void
reserveAiTurn(userId: string, date: string): void
completeAiTurn(userId: string, date: string): void
releaseAiTurn(userId: string, date: string): void
```

Store only SHA-256 token/code hashes. Return raw invitation and session tokens once.

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run src/features/auth/*.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add apps/server/src/features/auth
git commit -m "feat: add persistent cloud sessions"
```

### Task 4: Add authentication hooks, routes, and admin bootstrap

**Files:**
- Create: `apps/server/src/features/auth/auth-plugin.ts`
- Create: `apps/server/src/features/auth/auth-routes.ts`
- Create: `apps/server/src/features/auth/auth-routes.test.ts`
- Create: `apps/server/src/features/auth/admin-routes.ts`
- Create: `apps/server/src/features/auth/admin-routes.test.ts`
- Create: `apps/server/src/cli/create-admin.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/package.json`
- Modify: `packages/shared/src/api.ts`

- [ ] **Step 1: Write route tests**

Test invitation registration, login, logout, refresh, browser cookie + CSRF, bearer access, unauthenticated rejection, admin-only endpoints, and cloud startup refusing the unclaimed legacy owner.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run src/features/auth/auth-routes.test.ts src/features/auth/admin-routes.test.ts`

- [ ] **Step 3: Decorate requests with a principal**

Add `request.auth` with `{ userId, username, role, sessionId, transport: 'cookie'|'bearer'|'local' }`. Public routes are only health, bootstrap, login, register, and refresh. `requireAuth()` and `requireAdmin()` return stable `401 authentication_required` and `403 admin_required` errors.

Create a child request logger containing only an HMAC-derived 16-character `actorId`; never log the database user ID, username, cookies, bearer tokens, request prompts, image bodies, or chat text.

- [ ] **Step 4: Implement routes**

Register `/api/auth/register`, `/login`, `/refresh`, `/logout`, `/me`; `/api/admin/invitations`, `/users`, `/users/:userId/disable`, `/users/:userId/quota`, and `/users/:userId/revoke-sessions`. Browser login sets `xiaochu_auth` Secure HttpOnly SameSite=Strict; Android login returns opaque tokens only for `clientKind: 'android'`.

- [ ] **Step 5: Implement admin creation**

Add `npm run admin:create -w @xiaochu/server -- --username <name>`; read the password from `XIAOCHU_ADMIN_PASSWORD`, claim the legacy owner atomically, and never accept or print the password on the command line.

- [ ] **Step 6: Run auth tests and commit**

Run: `npx vitest run src/features/auth/*.test.ts && npm run typecheck`

```powershell
git add apps/server/src/features/auth apps/server/src/cli apps/server/src/app.ts apps/server/package.json packages/shared/src/api.ts
git commit -m "feat: expose invitation-only authentication"
```

### Task 5: Make personal repositories owner-aware

**Files:**
- Modify: `apps/server/src/features/inventory/*`
- Modify: `apps/server/src/features/shopping/*`
- Modify: `apps/server/src/features/recipes/recipe-repository.ts`
- Modify: `apps/server/src/features/recipes/recipe-routes.ts`
- Modify: `apps/server/src/features/recipes/note-routes.ts`
- Modify: `apps/server/src/features/variants/*`
- Modify: `apps/server/src/features/actions/*`
- Modify: `apps/server/src/features/vision/*`
- Modify: `apps/server/src/features/voice/*`
- Modify: `apps/server/src/features/privacy/*`
- Create: `apps/server/src/features/auth/data-isolation.test.ts`

- [ ] **Step 1: Write one cross-feature isolation test**

Create users A and B, create one resource of every personal type for A, then assert B receives empty lists or 404 and cannot mutate A's IDs. Assert both can read the same recipe catalog.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run src/features/auth/data-isolation.test.ts`

- [ ] **Step 3: Thread `userId` through repositories**

Every personal method takes `userId` first and every SQL statement includes it:

```ts
getSnapshot(userId: string): InventorySnapshot
delete(userId: string, itemId: string, expectedVersion: number): void
```

```sql
SELECT ... FROM inventory_items WHERE user_id = ? ORDER BY ...;
DELETE FROM inventory_items WHERE user_id = ? AND id = ? AND version = ?;
```

Inventory recipe matching adds `inv.user_id = @user_id`; versions come from `user_data_versions`. Routes use only `request.auth.userId`, never owner IDs from client input.

- [ ] **Step 4: Scope tools and actions**

AI tools, pending actions, recognition drafts, voice history, variants, privacy clear, notes, favorites and recent views resolve the same principal. Provider profiles and recipe catalog remain global; provider management becomes admin-only.

- [ ] **Step 5: Run server suites and commit**

Run: `npm test -w @xiaochu/server && npm run typecheck`

```powershell
git add apps/server/src/features
git commit -m "feat: isolate personal data by account"
```

### Task 6: Enforce AI quotas and administrator model control

**Files:**
- Create: `apps/server/src/features/auth/ai-quota.ts`
- Create: `apps/server/src/features/auth/ai-quota.test.ts`
- Modify: `apps/server/src/features/voice/stream-route.ts`
- Modify: `apps/server/src/features/variants/variant-routes.ts`
- Modify: `apps/server/src/features/vision/vision-routes.ts`
- Modify: `apps/server/src/features/providers/provider-routes.ts`

- [ ] **Step 1: Write quota tests**

Test reservation before upstream calls, completion after success, release after transport failure/cancel, Asia/Shanghai daily boundary, zero allowance, and concurrent reservations at the final slot.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run src/features/auth/ai-quota.test.ts`

- [ ] **Step 3: Implement the quota guard**

```ts
const reservation = quota.reserve(request.auth.userId, now)
try {
  const result = await invokeModel()
  reservation.complete()
  return result
} catch (error) {
  reservation.release()
  throw error
}
```

Return `429 ai_daily_limit` when exhausted and keep per-minute model routes at 10 for testers.

- [ ] **Step 4: Restrict provider mutations**

Tester provider lists expose enabled profiles without secrets. Create, update, delete and connection-test endpoints require administrator role.

- [ ] **Step 5: Run tests and commit**

Run: `npm test -w @xiaochu/server && npm run typecheck`

```powershell
git add apps/server/src/features
git commit -m "feat: enforce shared AI quotas"
```

### Task 7: Add browser login and administrator screens

**Files:**
- Create: `apps/web/src/features/auth/AuthProvider.tsx`
- Create: `apps/web/src/features/auth/LoginPage.tsx`
- Create: `apps/web/src/features/auth/RegisterPage.tsx`
- Create: `apps/web/src/features/auth/RequireAuth.tsx`
- Create: `apps/web/src/features/auth/auth.css`
- Create: `apps/web/src/features/admin/AdminPage.tsx`
- Create: `apps/web/src/features/auth/AuthFlow.test.tsx`
- Modify: `apps/web/src/main.tsx`
- Modify: `apps/web/src/app/router.tsx`
- Modify: `apps/web/src/app/AppShell.tsx`
- Modify: `apps/web/src/features/my/MyPage.tsx`
- Modify: `apps/web/src/features/providers/ProviderSettingsPage.tsx`
- Modify: `apps/web/src/lib/api-client.ts`

- [ ] **Step 1: Write the browser flow test**

Test login redirect, invitation registration, authenticated navigation, admin-only link, provider denial for testers, session expiry redirect, and logout.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run src/features/auth/AuthFlow.test.tsx` from `apps/web`

- [ ] **Step 3: Implement auth state and routes**

`AuthProvider` loads `/api/auth/me`, exposes `login`, `register`, `logout`, and keeps only user/CSRF state in memory. Add `/login` and `/register` outside `AppShell`, wrap app routes in `RequireAuth`, and add admin-only `/admin` plus `/settings/providers`.

- [ ] **Step 4: Adapt API error handling**

On `401 authentication_required`, clear auth state and navigate to `/login`; never loop or automatically retry mutations.

- [ ] **Step 5: Run web tests/build and commit**

Run: `npm test -w @xiaochu/web && npm run typecheck && npm run build`

```powershell
git add apps/web/src
git commit -m "feat: add invitation login and admin UI"
```

### Task 8: Verify the cloud foundation

**Files:**
- Modify: `docs/acceptance/manual-smoke.md`
- Modify: `README.md`

- [ ] **Step 1: Document manual acceptance**

Include admin creation, invite creation, two-account isolation, shared recipes, AI quota, provider restriction, logout, and trusted local-mode startup.

- [ ] **Step 2: Run fresh verification**

```powershell
npm run lint
npm run typecheck
npm test
npm run build
```

Expected: every command exits 0.

- [ ] **Step 3: Run browser smoke**

Create admin and tester in cloud-test mode. Use Playwright CLI to verify login, invite, separate shopping lists, shared recipes, and one real AI response.

- [ ] **Step 4: Commit docs**

```powershell
git add README.md docs/acceptance/manual-smoke.md
git commit -m "docs: describe cloud account verification"
```
