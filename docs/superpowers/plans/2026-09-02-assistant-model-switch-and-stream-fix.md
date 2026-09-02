# AI Assistant Model Switching and Stream Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AI replies complete normally and let users change the active text model without losing conversation history.

**Architecture:** Keep one active voice session and update its provider/model snapshots when the user switches models, so existing `voice_messages` remain the next model's history. Isolate stream disconnect handling in a small lifecycle helper, and make the client treat `turn.error` as a real rejected turn instead of an empty reply.

**Tech Stack:** React 19, TypeScript, TanStack Query, Fastify, SQLite/better-sqlite3, Zod, Vitest, NDJSON streaming.

---

### Task 1: Add the session model-switch contract and repository behavior

**Files:**
- Modify: `packages/shared/src/voice.ts`
- Modify: `apps/server/src/features/voice/voice-repository.ts`
- Create: `apps/server/src/features/voice/voice-repository.test.ts`

- [ ] **Step 1: Write the failing repository test**

Create two enabled text provider profiles, an active voice session using provider A, and two complete messages. Call the wished-for `changeProvider` method and assert the session now snapshots provider B while `history(sessionId)` still returns both original messages. Also assert an ended session rejects switching.

```ts
const updated = sessions.changeProvider(session.id, {
  providerId: providerB.id,
  providerName: providerB.name,
  modelId: providerB.modelId,
});
expect(updated).toMatchObject({ providerId: providerB.id, modelId: providerB.modelId });
expect(sessions.history(session.id)).toEqual([
  { role: 'user', content: '上一轮问题' },
  { role: 'assistant', content: '上一轮回答' },
]);
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npx vitest run src/features/voice/voice-repository.test.ts` from `apps/server`.

Expected: FAIL because `VoiceRepository.changeProvider` does not exist.

- [ ] **Step 3: Add the shared request schema and minimal repository update**

Add this schema to `packages/shared/src/voice.ts`:

```ts
export const changeVoiceSessionProviderInputSchema = z.object({
  providerId: z.string().uuid(),
}).strict();
```

Add `VoiceRepository.changeProvider` using one guarded update:

```ts
changeProvider(id: string, provider: {
  readonly providerId: string;
  readonly providerName: string;
  readonly modelId: string;
}): VoiceSession {
  const result = this.db.prepare(`
    UPDATE voice_sessions
    SET provider_id = ?, provider_name_snapshot = ?, model_id_snapshot = ?
    WHERE id = ? AND status = 'active'
  `).run(provider.providerId, provider.providerName, provider.modelId, id);
  if (result.changes !== 1) {
    const current = this.get(id);
    if (current.status !== 'active') {
      throw new AppError('voice_session_ended', '会话已经结束', 409);
    }
  }
  return this.get(id);
}
```

- [ ] **Step 4: Run the test and verify GREEN**

Run: `npx vitest run src/features/voice/voice-repository.test.ts` from `apps/server`.

Expected: PASS.

### Task 2: Fix stream cancellation and expose model switching through the API

**Files:**
- Create: `apps/server/src/features/voice/stream-lifecycle.ts`
- Create: `apps/server/src/features/voice/stream-lifecycle.test.ts`
- Modify: `apps/server/src/features/voice/stream-route.ts`

- [ ] **Step 1: Write the failing lifecycle test**

Use `EventEmitter` request/response fakes. Assert a request `close` event does not abort, a request `aborted` event does abort, and a response `close` aborts only while `writableEnded` is false.

```ts
const cleanup = bindStreamCancellation(request, response, controller);
request.emit('close');
expect(controller.signal.aborted).toBe(false);
response.emit('close');
expect(controller.signal.aborted).toBe(true);
cleanup();
```

- [ ] **Step 2: Run the lifecycle test and verify RED**

Run: `npx vitest run src/features/voice/stream-lifecycle.test.ts` from `apps/server`.

Expected: FAIL because `bindStreamCancellation` does not exist.

- [ ] **Step 3: Implement the lifecycle helper and route changes**

Implement a helper that subscribes only to request `aborted` and response `close`, checks `response.writableEnded`, and returns an unsubscribe function. Replace the current `request.raw.once('close', ...)` block with that helper.

Add `PATCH /api/voice/sessions/:sessionId/provider`. Parse `changeVoiceSessionProviderInputSchema`, require an enabled text provider, then call `sessions.changeProvider` and return the updated session. Use `ROUTE_SECURITY_CONFIGS.confirmation`.

Change the stream catch block to retain the caught error and send a safe Chinese `turn.error`; cancellation remains `cancelled`, while other errors use a known model error code/message when available and otherwise return `voice_turn_failed`.

- [ ] **Step 4: Run server voice tests and verify GREEN**

Run: `npx vitest run src/features/voice/voice-repository.test.ts src/features/voice/stream-lifecycle.test.ts` from `apps/server`.

Expected: PASS.

### Task 3: Make the client surface errors and preserve the transcript while switching

**Files:**
- Create: `apps/web/src/features/assistant/turn-controller.test.ts`
- Modify: `apps/web/src/features/assistant/turn-controller.ts`
- Modify: `apps/web/src/features/assistant/AssistantPage.tsx`
- Modify: `apps/web/src/features/inventory/kitchen.css`

- [ ] **Step 1: Write the failing controller test**

Feed an NDJSON response containing `turn.started` followed by `turn.error`. Assert `start()` rejects with the server message and state becomes `error`.

```ts
await expect(controller.start('你好', EMPTY_CONTEXT))
  .rejects.toThrow('模型服务额度或余额不足');
expect(states.at(-1)).toBe('error');
```

- [ ] **Step 2: Run the controller test and verify RED**

Run: `npx vitest run src/features/assistant/turn-controller.test.ts` from `apps/web`.

Expected: FAIL because `turn.error` currently changes state without rejecting.

- [ ] **Step 3: Implement error propagation and model switching UI**

In `TurnController.start`, throw after receiving `turn.error`:

```ts
if (frame.type === 'turn.error') {
  this.onState('error');
  throw new Error(frame.error.message);
}
```

In `AssistantPage`, add an async model-change handler. With no session, update local selection immediately. With an existing session, call the new PATCH endpoint; on success update `providerId` while leaving `lines` unchanged, and on failure leave the previous selection selected. Disable the select while state is `thinking` or `speaking`.

In `send` error handling, remove only the final assistant line when its text is still empty, then show the thrown message. Add an always-visible `Link` labelled `添加或管理模型` beside the selector. Add focused layout styles for the selector/link row.

- [ ] **Step 4: Run the client test and verify GREEN**

Run: `npx vitest run src/features/assistant/turn-controller.test.ts` from `apps/web`.

Expected: PASS.

### Task 4: Verify the complete fix with the configured provider

**Files:**
- Modify only if verification reveals a directly related defect.

- [ ] **Step 1: Run static and regression verification**

Run from repository root:

```powershell
npm run typecheck
npm test
npm run build
```

Expected: all commands exit 0. The existing PWA deprecation warning is non-blocking.

- [ ] **Step 2: Restart the local service**

Run: `powershell -ExecutionPolicy Bypass -File .\scripts\start-local.ps1`.

Expected: `http://localhost:4173/api/health` returns 200.

- [ ] **Step 3: Perform a real model turn**

Open `/assistant`, send `你好，请用一句话告诉我炒鸡蛋应该用什么火候？`, and verify the transcript receives non-empty assistant text, the turn reaches `idle`, and the latest database assistant message has status `complete`.

- [ ] **Step 4: Verify model-management and history behavior**

Confirm `添加或管理模型` opens `/settings/providers`. If at least two enabled text providers exist, switch after one completed turn and ask `我刚才问的是什么？`; verify the new model references the earlier question while the visible transcript remains unchanged.

- [ ] **Step 5: Commit the implementation**

```powershell
git add -- packages/shared/src/voice.ts apps/server/src/features/voice apps/web/src/features/assistant apps/web/src/features/inventory/kitchen.css
git commit -m "fix: restore assistant replies and model switching"
```
