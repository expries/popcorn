# 09 — One `canSeekTo` and persisted segment durations

**Severity:** medium. This is also the groundwork for [02](02-restart-alignment.md).

## Root cause

The seekable limit is computed three different ways:

- `progressSSE.ts:125`: `transcodedSegmentCount * session.segmentDuration`. It assumes 6 s per segment, and it's sent as `transcodedDuration`.
- `statsHandler.ts:87`: `(contiguous + 1) * session.segmentDuration`. It assumes 6 s per segment.
- `sessionRegistry.calculateCanSeekTo`: uses the real recorded durations. This is the correct one.

`hlsHandlers.ts:195` also computes `requestedTime = segmentIndex * 6`.

Durations are only held in memory. After a restart, cached segments fall back to 6 s in the playlist, so the player's timeline drifts away from the real video timeline in copy mode.

## Steps

1. **Schema.** Add `segmentDurations: jsonb('segment_durations').$type<Record<string, number>>().notNull().default({})` to `transcodeJobs`. Generate and commit the migration.
2. **Write path.** In `sessionRegistry.markSegmentReady`, mark the session dirty. A per-session debounce (5 s) calls `transcodeJobManager.updateSegmentDurations(infoHash, Object.fromEntries(session.segmentDurations))`. Flush it immediately on FFmpeg close and on shutdown. In `server.ts` `shutdown()`, await the flush with a 2 s timeout before `process.exit`.
3. **Read path.** `getOrCreateSession` (when a job exists) and `transcodeResumer` load `segmentDurations` from the job into the Map, keeping only indices that are in `existingSegments`.
4. **Back-filling older jobs.** For cached segments that have no stored duration, run `ffprobe -v error -show_entries format=duration -of csv=p=0 segment_N.ts` with a concurrency of 4, once, when the session loads. Store the results and persist them.
5. **Clear durations** wherever segments are deleted: `startGeneration`'s invalidation, `deleteSegmentsFrom`, `restartTranscoding`. The in-memory deletes already exist; make sure they're persisted too.
6. **Single calculation.** Every consumer uses `calculateCanSeekTo(session, …)`:
   - In `progressSSE`, set both `canSeekTo` and `transcodedDuration` from it, and compute `transcodeProgress = canSeekTo / totalDuration`.
   - In `statsHandler`, do the same.
   - In the 416 body in `hlsHandlers`, `canSeekTo` already uses it. Change `requestedTime` to `getSegmentStartTime(session.segmentDurations, segmentIndex, session.segmentDuration)`.
7. **Frontend:** `app/src/config.ts` `HLS_SEGMENT_DURATION` is used only for log messages and the sanity warning in `useHlsPlayer`. Downgrade that warning to debug level, because averages different from 6 s are normal in copy mode.

## Tests

- **Unit test:** `calculateCanSeekTo` with durations `{0: 4, 1: 9, 2: 5}` and segments `{0, 1, 2, 4}` gives 18.
- **Unit test:** SSE and stats payload builders, with the builders pulled out as pure functions, both produce 18 for the same session.
- **Unit test:** durations survive a round trip through the job manager mock and are restored on `getOrCreateSession`.

## Done when

After restarting the backend mid-transcode on the HAiKU MKV, the playlist's `#EXTINF` values match those from before the restart, and the seek bar's available marker matches the actual playable end within one segment.
