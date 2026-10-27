# 11 — Smaller issues

Each fix is small. Commit each one separately.

---

## 11a. A rejected segment leaves a permanent gap

**Problem:** `checkForNewSegments` deletes a segment that fails validation and moves on. The contiguous count then stops at that gap, so `canSeekTo` and the playlist stop advancing, while FFmpeg keeps producing segments beyond it.

**Plan:**
- Accept a short **final** segment when the run reached EOF, meaning it was uncapped and exited with code 0 (see plan 03). The last segment of a video is normally short. In `processRemainingSegments`, pass `isLastOfRun` and skip the `minDuration` check for it.
- Accept the final segment of a *capped* run too. `-t` cuts mid-GOP, so a short tail is expected. It still has to pass the sync-byte and size checks.
- If a segment is rejected in the middle of a run, call `stopGeneration` and then `startGeneration(session, rejectedIndex, …)`. This depends on plan 02 for correct alignment. Count it toward the failure counter from plan 06, so a file that is genuinely corrupt can't loop forever.

**Test:** with validation mocked, a rejection in the middle of a run triggers exactly one restart from the rejected index.

---

## 11b. An old `close` handler clobbers the new run (`ffmpegProcess.ts:343`)

**Problem:** the `close` and `error` handlers call `this.processes.delete(sessionKey)` and set `session.isGenerating = false` without checking which run they belong to. If a run is stopped and a new one started before the old process emits `close`, the old handler deletes the new run's state. The poller then stops moving segments, and a third FFmpeg can be spawned.

**Plan:**
- Add `stopped: boolean` to `FFmpegState`. `stopGeneration` sets it before it kills the process.
- In `close` and `error`, check `const current = this.processes.get(key); const isCurrent = current?.runId === state.runId;`. Only delete the entry and set `isGenerating = false` when `isCurrent` is true.
- Skip `processRemainingSegments` when `state.stopped` is true. The temp directory is being deleted anyway, and the segments it would move belong to an index range that has just been invalidated.
- Guard against overlapping `checkForNewSegments` calls with a per-state `polling` flag, because `setInterval` doesn't wait for the previous async call to finish.

**Test:** start run A, stop it, start run B, then manually fire A's `close` → `processes.get(key).runId === B` and `isGenerating === true`.

---

## 11c. `getTotalCacheSize` returns 0 when a stray directory exists

**Problem:** `getAllSessionKeys` returns every directory in the cache. `getSessionStats` throws on names that don't match the key pattern, and the outer `try` swallows the error and returns a total of 0, so LRU eviction never runs.

**Plan:**
- Filter `getAllSessionKeys` with `VALID_SESSION_KEY_PATTERN`.
- Add an orphan pass to `cacheEvictor.evict()`. Delete any cache directory that has an invalid name, or a valid name with no in-memory session **and** no database job whose `session_key` matches. This also covers the mode-change orphans in 11e.

**Test:** with a temp cache containing `junk/` plus one valid session, the total size equals the valid session's size, and the orphan pass deletes `junk/`.

---

## 11d. The server's SSE `error` event triggers a client reconnect

**Problem:** `progressSSE` sends `event: error` for "torrent not found" and for exceptions. `useProgressSSE`'s `addEventListener('error')` receives both those events and real connection failures, so it tears down the connection and reconnects with backoff.

**Plan:**
- Server: rename the event to `stream-error`. Wrap `sendEvent` in a try/catch that clears the interval when `enqueue` throws (the client has disconnected), and attach a `.catch` to `sendUpdate()` calls.
- Client: handle `stream-error` by setting `connectionError` to the message *without* reconnecting. Keep the native `onerror` for real failures, and give it a single handler, so there's no `addEventListener('error')` as well as `onerror`.

---

## 11e. A transcode mode change orphans the old cache directory

**Problem:** sessions are keyed `{hash}_{mode}`, but the database job is keyed by `hash`. If the mode changes (because plan 07 changed the rules, or a re-probe reports a different audio codec), the old `{hash}_{oldMode}` directory is never deleted.

**Plan:** in `getOrCreateSession`, if `existingJob.sessionKey !== sessionKey`, call `segmentCache.deleteSession(existingJob.sessionKey)`, discard that job's progress (it belongs to a different output), and let `createOrUpdateJob` overwrite the row. The orphan pass in 11c handles leftovers from before this fix.

---

## 11f. `fetchTorrentInfo` will fetch any URL

**Problem:** `torrentClient.fetchTorrentInfo` fetches any URL the client sends, from the server. It also follows redirects with no depth limit, and calls itself with `undefined` when `Location` is missing.

**Plan:**
- Accept only `http:` and `https:` URLs whose origin matches `JACKETT_BASE_URL`. Jackett's download links are proxied through Jackett itself.
- Add a `depth` parameter and allow at most 5 redirects.
- Throw if a 3xx response has no `Location` header. Resolve relative `Location` values against the current URL.
- Allow magnet redirects (`magnet:`) to any target, as now.

**Test:** an off-origin URL is rejected, a redirect chain of 6 fails, and a 302 to `magnet:?xt=…` returns the magnet.

---

## 11g. `getSessionByInfoHash` returns the first match

**Problem:** with several modes per hash, the session it returns is arbitrary.

**Plan:** after 11e, there's at most one session per hash. Enforce it in `registerSession` and in session creation: if another session exists for the same hash, stop it and remove it first, and log a warning.

---

## 11h. Miscellaneous

- Replace FFmpeg flags that newer versions deprecate:
  - `-vsync cfr` → `-fps_mode cfr`
  - `-async 1` → `-af aresample=async=1`
  
  Check the installed ffmpeg version in the Dockerfile image first (`ffmpeg -version`).
- Route the `console.log` calls in `routes/stream/index.ts`, `nativeStream.ts`, `statsHandler.ts` and `torrentManager.ts` through `createLogger`, so log levels apply consistently.
- `RateLimiter.processQueue` schedules a new timer on every `acquire` while requests are queued. Keep one pending timer handle and skip scheduling when one is already set.
