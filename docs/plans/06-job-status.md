# 06 — Database job status is never updated during normal playback

**Severity:** medium.

## Root cause

- `sessionRegistry.markTranscodingStarted` and `markTranscodingCompleted` are defined but never called. `markInProgress` and `markCompleted` are only called from the evictor's resume path and the boot resumer.
- `createOrUpdateJob` writes `status: session.isGenerating ? 'in_progress' : 'pending'` on every call, which can overwrite `completed`.
- As a result, during normal playback:
  - jobs stay `pending`
  - `resumeIncompleteTranscodes` (which looks for `in_progress`) never resumes them after a server restart
  - the evictor's "skip completed" protection never applies
  - the collections page shows "pending"

## Steps

1. In `transcodeJobManager.createOrUpdateJob`, write `status` only on **insert**. Updates must not touch it. Add an explicit `resetJob(infoHash)` for `restartTranscoding`, or keep using the existing `deleteJob`.
2. In `ffmpegProcess.startGeneration`, after `spawn` succeeds, call `transcodeJobManager.markInProgress(infoHash)` (fire and forget, with `withRetry`).
3. In the FFmpeg `close` handler:
   - **Uncapped run that ended at EOF (see plan 03):** call `markCompleted`.
   - **Capped run that exited with code 0:** keep `in_progress`.
   - **Non-zero exit code that we didn't cause by stopping it (use the `stopped` flag from plan 11):** increment `session.consecutiveFailures`. When it reaches 3, call `markFailed`, set `session.failed = true`, and have `ensureTranscodingStarted` refuse to spawn again until `restartTranscoding` clears the session.
   - Reset `consecutiveFailures` to 0 in `markSegmentReady`.
4. Expose `failed` in the SSE and `/stats` payloads. In the frontend, show "Transcoding failed — Restart transcoding". A `restartTranscoding` mutation already exists.
5. Delete `sessionRegistry.markTranscodingStarted` and `markTranscodingCompleted`, so the FFmpeg lifecycle is the only place status changes.
6. Pull the `withRetry` helper out of `sessionRegistry.ts` into `utils/retry.ts`, so `ffmpegProcess` can use it.

## Tests

With `transcodeJobManager` mocked:
- spawn → `markInProgress`
- uncapped close with code 0 → `markCompleted`
- capped close → no status call
- three closes with code 1 → `markFailed` once, and a further `ensureTranscodingStarted` doesn't spawn
- `createOrUpdateJob` on an existing completed row leaves `status` unchanged

## Done when

After a playback is interrupted by a server restart, transcoding resumes on boot without the user doing anything. Completed movies show as completed on the collections page and are never evicted by the LRU pass.
