# 03 — The planned segment count can be wrong, so transcoding never finishes

**Severity:** high.
**Depends on:** [06](06-job-status.md), which records the completed status.

## Root cause

`totalSegments = Math.ceil(duration / segmentDuration)` (in `sessionRegistry.getOrCreateSession`). In copy mode, FFmpeg cuts at the first keyframe after each 6 s mark, so it usually produces *fewer*, longer segments. The code treats `totalSegments` as exact, which causes these problems:

- `playlistGenerator.ts:44`: `isComplete` requires `availableSegments >= totalSegments`, so the playlist never gets `#EXT-X-ENDLIST` and stays an EVENT playlist.
- `ensureTranscodingStarted`: always finds a "gap" at the real segment count and starts FFmpeg again near the end of the file on every request.
- `handleSegmentRequest`: the `>= totalSegments` → 400 check is wrong in both directions.
- `cacheEvictor.tryResumeSession` and `transcodeResumer`: use `highest >= totalSegments - 1` as the completion test, which is wrong for the same reason.

## Steps

1. Add `isComplete: boolean` to `HlsSession`. When a session is restored from the database, initialise it from the job's `status === 'completed'`.
2. In `startGeneration`, record on the run state whether a cap was applied: `capped = maxDuration !== undefined && maxDuration < session.totalDuration - 0.5`.
3. In the FFmpeg `close` handler, after processing the remaining segments: if `code === 0`, the run was not capped, and the segments are contiguous from 0 up to the highest, then:
   - set `session.isComplete = true`
   - set `session.totalSegments = session.highestGeneratedSegment + 1`
   - call `transcodeJobManager.markCompleted` and persist `totalSegments`
4. In `playlistGenerator.calculatePlaylistState`, set `isComplete = session.isComplete && contiguous === session.highestGeneratedSegment`.
5. In `ensureTranscodingStarted`:
   - return `false` immediately if `session.isComplete`
   - otherwise find the first gap in `[0, highestGeneratedSegment + 1]`, with no `totalSegments` bound
6. In `handleSegmentRequest`:
   - if `isComplete` and the index is above the highest generated segment, return 404 `{ error: 'Segment out of range' }`
   - if not complete, don't validate the upper bound and let `getSegmentStatus` decide
   - in `getSegmentStatus`, compute `remainingSegments` from the estimate but floor it at 0
7. In the frontend `useHlsPlayer`, treat 404 like the current 400 handling (reload the playlist).
8. Progress figures: `getAllDownloads`, SSE and `/stats` report `transcodedDuration / totalDuration`, clamped to [0, 1] and set to 1 when `isComplete`. The segment counts stay in the payload, labelled as estimates.
9. Replace the `highest >= totalSegments - 1` checks in the evictor and resumer with `isComplete`, or with the job's status.

## Tests

- **Unit test:** a session with `totalSegments` 10 and segments 0–7 is not complete. After a simulated uncapped close with code 0, it is complete, `totalSegments` is 8, and the playlist contains `ENDLIST`.
- **Unit test:** after completion, `ensureTranscodingStarted` doesn't spawn FFmpeg (mock `spawn`).
- **Integration test** (with ffmpeg): a copy-mode fixture with 10 s GOPs ends with a VOD playlist.

## Done when

After a copy-mode file finishes transcoding, the logs show no new FFmpeg runs during playback, and the player shows the final duration.
