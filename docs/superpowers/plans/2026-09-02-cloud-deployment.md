# Cloud Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy the authenticated XiaoChu application on Ubuntu 22.04 with Docker Compose, Nginx, persistent storage, IP-address HTTPS certificates, backups, and rollback.

**Architecture:** A multi-stage image builds the monorepo and runs Fastify on an internal Docker network. Nginx is the only public container and serves the web build plus reverse-proxies API and cover requests. Host-mounted data, cover, certificate, secret, log, and backup directories survive container replacement.

**Tech Stack:** Docker Compose, Node.js 24, Nginx, Certbot 5.4+, Ubuntu systemd timers, SQLite

---

### Task 1: Make runtime configuration and encrypted secrets portable

**Files:**
- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/src/index.ts`
- Create: `apps/server/src/features/providers/aes-gcm-secret-store.ts`
- Create: `apps/server/src/features/providers/aes-gcm-secret-store.test.ts`
- Create: `apps/server/src/features/providers/create-secret-store.ts`
- Create: `.env.production.example`

- [ ] **Step 1: Write RED tests**

Test Linux data paths, host/port/origin parsing, missing 32-byte master key, AES-GCM round trip, tamper rejection, nonce uniqueness, atomic persistence, and Windows DPAPI selection in local mode.

- [ ] **Step 2: Implement runtime configuration**

Parse `XIAOCHU_MODE`, `XIAOCHU_DATA_DIR`, `XIAOCHU_HOST`, `XIAOCHU_PORT`, `XIAOCHU_PUBLIC_ORIGIN`, and `XIAOCHU_MASTER_KEY_FILE`. Cloud defaults are `/data`, `0.0.0.0`, and `4173`; cloud mode requires a valid HTTPS origin and readable master-key file.

- [ ] **Step 3: Implement AES-256-GCM secret storage**

Persist this document behind the existing `SecretStore` interface:

```ts
interface EncryptedSecretDocument {
  readonly version: 1
  readonly secrets: Readonly<Record<string, {
    readonly nonce: string
    readonly ciphertext: string
    readonly tag: string
  }>>
}
```

Use a 32-byte binary key, 12-byte random nonce, key reference as AAD, atomic temp-file rename, and `0600` permissions.

- [ ] **Step 4: Run tests and commit**

Run: `npx vitest run src/features/providers/aes-gcm-secret-store.test.ts && npm run typecheck`

```powershell
git add apps/server/src .env.production.example
git commit -m "feat: support secure Ubuntu runtime configuration"
```

### Task 2: Create production containers

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `compose.yaml`
- Create: `deploy/nginx/xiaochu.conf.template`
- Create: `deploy/nginx/entrypoint.sh`
- Create: `deploy/scripts/validate-compose.ps1`

- [ ] **Step 1: Add a container contract check**

The validation script runs `docker compose config` and asserts no app port is published, required mounts exist, health checks exist, and Nginx alone publishes 80/443.

- [ ] **Step 2: Implement the multi-stage image**

Use `node:24-bookworm-slim`. Install compilation prerequisites only in the builder, run `npm ci` and `npm run build`, then copy production modules, `apps/server/dist`, and `apps/web/dist` into a non-root runtime stage. `EXPOSE 4173` is metadata only.

- [ ] **Step 3: Implement Compose**

Define `app` and `nginx` services, read-only application filesystems, `no-new-privileges`, restart policies, internal network, health checks, 2-core/4-GiB-compatible limits, and mounts under `/srv/xiaochu`. Only Nginx maps host ports.

- [ ] **Step 4: Implement Nginx**

Serve web assets; proxy `/api` and `/api/recipe-covers`; limit uploads to 10 MiB; pass request IDs and forwarding headers; enable HSTS only in the valid HTTPS server; return a closed response instead of serving the application over plain HTTP except ACME challenges.

- [ ] **Step 5: Validate and commit**

Run: `powershell -File deploy/scripts/validate-compose.ps1`

Expected: valid config and only Nginx publishes ports.

```powershell
git add Dockerfile .dockerignore compose.yaml deploy/nginx deploy/scripts/validate-compose.ps1
git commit -m "feat: containerize XiaoChu cloud service"
```

### Task 3: Automate Ubuntu provisioning and IP HTTPS

**Files:**
- Create: `deploy/scripts/bootstrap-ubuntu.sh`
- Create: `deploy/scripts/issue-ip-certificate.sh`
- Create: `deploy/scripts/renew-ip-certificate.sh`
- Create: `deploy/systemd/xiaochu-cert-renew.service`
- Create: `deploy/systemd/xiaochu-cert-renew.timer`
- Create: `deploy/scripts/validate-shell.ps1`

- [ ] **Step 1: Add shell validation**

Run ShellCheck through a pinned Docker image and assert scripts use `set -Eeuo pipefail`, quote variables, use absolute `/srv/xiaochu` targets, and never echo secrets.

- [ ] **Step 2: Implement idempotent host bootstrap**

Install Docker Engine from Docker's apt repository, Compose plugin, UFW, curl, OpenSSL, and Certbot 5.4+ in an isolated Python virtual environment. Create system user `xiaochu` and `/srv/xiaochu/{app,data,covers,backups,certbot,logs,secrets}` with least-privilege ownership. Open 22/80/443 in UFW; do not alter Alibaba security groups automatically.

- [ ] **Step 3: Implement certificate issuance**

Use Certbot webroot with `--preferred-profile shortlived --ip-address "$PUBLIC_IP"`; support staging first, then production. Copy the validated fullchain/key to mounted paths atomically and reload Nginx only after `openssl x509 -checkend` succeeds.

- [ ] **Step 4: Implement renewal timer**

Run four times daily with randomized delay. Failure exits nonzero and leaves the last valid certificate untouched; success reloads Nginx. Never fall back to HTTP application traffic.

- [ ] **Step 5: Validate and commit**

Run: `powershell -File deploy/scripts/validate-shell.ps1`

```powershell
git add deploy/scripts deploy/systemd
git commit -m "feat: automate Ubuntu and IP HTTPS setup"
```

### Task 4: Add database backup, restore, deploy, and rollback

**Files:**
- Create: `apps/server/src/cli/backup-database.ts`
- Create: `apps/server/src/cli/backup-database.test.ts`
- Modify: `apps/server/package.json`
- Create: `deploy/scripts/backup.sh`
- Create: `deploy/scripts/restore.sh`
- Create: `deploy/scripts/deploy.sh`
- Create: `deploy/scripts/rollback.sh`
- Create: `deploy/systemd/xiaochu-backup.service`
- Create: `deploy/systemd/xiaochu-backup.timer`

- [ ] **Step 1: Write backup tests**

Test a live WAL backup, `PRAGMA integrity_check`, manifest SHA-256, overwrite refusal, corrupt restore rejection, and retention selection for 7 daily plus 4 weekly files.

- [ ] **Step 2: Implement application-level backup**

Use better-sqlite3's online backup API, open the destination read-only, require `integrity_check = ok`, and write a JSON manifest containing timestamp, schema version, byte size, and SHA-256.

- [ ] **Step 3: Implement operational scripts**

`backup.sh` calls the CLI and retention logic. `restore.sh` requires an explicit backup, verifies manifest/hash/integrity, stops writes, preserves the current DB, restores, migrates, and health-checks. `deploy.sh` creates a pre-deploy backup, builds a tagged image, migrates, starts, and records the tag. `rollback.sh` restores the prior tag and restores DB only when given the matching pre-deploy backup.

- [ ] **Step 4: Run tests and commit**

Run: `npx vitest run src/cli/backup-database.test.ts && npm run typecheck`

```powershell
git add apps/server/src/cli apps/server/package.json deploy/scripts deploy/systemd
git commit -m "feat: add cloud backup and rollback tooling"
```

### Task 5: Add administrator operations status and APK hosting

**Files:**
- Create: `apps/server/src/features/admin/operations-status.ts`
- Create: `apps/server/src/features/admin/operations-status.test.ts`
- Create: `apps/server/src/features/admin/operations-routes.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/web/src/features/admin/AdminPage.tsx`
- Modify: `compose.yaml`
- Modify: `deploy/nginx/xiaochu.conf.template`

- [ ] **Step 1: Write RED status tests**

Test administrator-only access, certificate remaining time, disk free bytes, last valid backup timestamp, database integrity state, aggregate daily AI usage, missing optional paths, and rejection for tester accounts.

- [ ] **Step 2: Implement safe operations status**

Return only `{ databaseOk, certificateExpiresAt, diskFreeBytes, lastBackupAt, activeUsers, aiTurnsToday }`. Read paths from validated cloud configuration, cap filesystem work to metadata/integrity checks, and never return environment variables, secret paths, usernames, tokens, prompts, or model keys.

- [ ] **Step 3: Add the administrator panel**

Render service, certificate, disk, backup, user-count and AI-usage cards with explicit unavailable/error states. Refresh only on user action; do not poll continuously.

- [ ] **Step 4: Host signed APK artifacts**

Mount `/srv/xiaochu/releases` read-only into Nginx and serve only exact `.apk`, `.aab`, and `.sha256` files under `/downloads/`; disable directory listing, uploads, script execution, and cache of checksum files.

- [ ] **Step 5: Test and commit**

Run: `npx vitest run src/features/admin/operations-status.test.ts && npm run typecheck && npm run build`

```powershell
git add apps/server/src/features/admin apps/server/src/app.ts apps/web/src/features/admin compose.yaml deploy/nginx
git commit -m "feat: add cloud operations status"
```

### Task 6: Write and verify the deployment runbook

**Files:**
- Create: `docs/operations/cloud-ubuntu-deployment.md`
- Create: `docs/operations/cloud-recovery.md`
- Modify: `README.md`

- [ ] **Step 1: Document the operator flow**

Include Alibaba security group 22/80/443, SSH key setup, upload, environment creation, non-echoing 32-byte key generation, admin creation, recipe import, staging/production IP certificate, Compose start, invite creation, logs, certificate status, APK upload/checksum, backup, restore, update, rollback, Tailscale fallback, and the later IP-to-domain migration.

- [ ] **Step 2: Perform a clean container smoke test**

```powershell
docker compose build
docker compose up -d
curl.exe -f http://127.0.0.1/api/health
docker compose down
```

Expected: image builds, health returns 200, and test data survives container recreation.

- [ ] **Step 3: Run repository verification**

Run: `npm run typecheck && npm test && npm run build`

- [ ] **Step 4: Commit**

```powershell
git add README.md docs/operations
git commit -m "docs: add Ubuntu cloud operations runbook"
```
