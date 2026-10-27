# 05 — The safety cap disappears near the download edge

**Severity:** high. FFmpeg reads unwritten, zero-filled parts of a `.part` file, which produces corrupt or rejected segments.
**Depends on:** [02](02-restart-alignment.md), because `startTime` has to be correct before it can be compared with the cap.

## Root cause

- `buildArgs` adds `-t` only when `maxDuration > startTime` (`backend/src/hls/ffmpegProcess.ts:127`). When a restart point is at or past the safe limit, FFmpeg runs with **no limit at all**, which is exactly when the cap matters most.
- The safe limit is `percentDone * totalDuration - 12s`. This has three problems:
  - `percentDone` covers the whole torrent, including samples, subtitles and `.nfo` files, not just the video file.
  - It assumes the downloaded bytes are one contiguous run from the start. Sequential download in Transmission 4.1 is a priority hint, not a guarantee.
  - It assumes bytes map linearly to time (a constant bitrate).
- After a capped run ends, nothing restarts FFmpeg except the next playlist or segment request. The SSE loop only starts transcoding while `waitingForDownload` is true.

## Steps

1. **Measure the downloaded prefix of the video file:**
   - Add `torrentManager.getVideoContiguousPrefix(infoHash): Promise<number>`, returning the byte count downloaded contiguously from the start of the video file. Build it on `getVideoPieceProgress`: take the first range if it starts at 0. Use piece-aligned byte offsets, not fractions.
   - The cap becomes `prefixBytes / fileSize * totalDuration - SAFETY_MARGIN_SEGMENTS * segmentDuration`. When the download is complete, use no cap.
   - Pass the prefix fraction, rather than `progress`, into `startGeneration` / `ensureTranscodingStarted`. Keep the parameter name but document what it means now.
2. **Throttle instead of running without a cap.** In `startGeneration`, before spawning FFmpeg:
   ```ts
   if (isIncomplete && (maxDuration === undefined || maxDuration - startTime < this.segmentDuration)) {
     session.throttled = true;
     return 'throttled';
   }
   session.throttled = false;
   ```
   - Change the return type to `'started' | 'throttled'`, and have `ensureTranscodingStarted` pass it through.
   - In `handleSegmentRequest`, a throttled session with a segment status of `unavailable` and an index at or just beyond the contiguous edge returns 503 with `Retry-After: 2`, not 416. That way hls.js waits instead of jumping back.
3. **Drive restarts from download progress.** In the `progressSSE` tick, call `ensureTranscodingStarted` when `session.throttled || (!session.isGenerating && !session.isComplete && !session.waitingForDownload)`, not only when `waitingForDownload` is true. Use the 1 s memoised stats from plan 10 so this doesn't add RPC calls.
4. Remove `calculateSafeSegmentLimit`, which is unused outside the tests, or switch it to the prefix calculation. Update `downloadTracker.ts`'s `contiguousBytes` to use the real prefix too.

## Tests

- **Unit test:** with the prefix at 10%, a 600 s duration and `startTime` 54, the run is throttled. With the prefix at 20%, FFmpeg is spawned with `-t` equal to 120 − 12 − 54.
- **Unit test:** prefix calculation from a bitfield with holes (`[1,1,1,0,1,1]` → 3 pieces), with a file offset in the middle of a piece.
- **Unit test:** an SSE tick on a throttled session calls `ensureTranscodingStarted`.

## Done when

The FFmpeg command for an incomplete file always includes `-t`, no segments are rejected as "file too small" or "invalid MPEG-TS header" during a slow download, and transcoding resumes on its own as the download advances, even when the player is paused.
