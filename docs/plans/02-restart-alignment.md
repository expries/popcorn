# 02 — Restart start time is wrong in copy and audio_only modes

**Severity:** high. The result is duplicated or skipped video at every FFmpeg restart, and restarts happen routinely while a file is still downloading.
**Depends on:** [09](09-can-seek-to.md) for persisted segment durations.

## Root cause

- `startGeneration` computes `startTime = fromSegment * this.segmentDuration` (`backend/src/hls/ffmpegProcess.ts:274`). In copy mode, FFmpeg can only cut at source keyframes, so real segment lengths vary (for example 4.2 s, 8.3 s, 6.1 s). Segment N therefore does not start at `N * 6`.
- Every run passes `-start_at_zero`, so each restarted run's timestamps begin again at 0. hls.js places fragments by PTS, so the restarted fragments land in the wrong place on the timeline.
- `getSegmentStartTime` in `hls/types.ts` computes the right value, but nothing calls it.
- Durations are kept only in memory, so after a server restart the real segment boundaries are lost.

## Steps

1. **Persist durations.** This is done in plan 09. It's a prerequisite.
2. **Compute the start time from real boundaries** in `startGeneration`:
   ```ts
   const unknown = firstIndexWithoutDuration(session.segmentDurations, fromSegment);
   if (unknown !== null && unknown < fromSegment) fromSegment = unknown; // don't guess
   const startTime = getSegmentStartTime(session.segmentDurations, fromSegment, this.segmentDuration);
   const seekTime = session.decision.videoAction === 'copy' ? startTime + 0.1 : startTime;
   ```
   - Input `-ss` seeks to the nearest keyframe at or before the target. In copy mode the segment boundary *is* a keyframe, so adding 0.1 s keeps a rounding error in `#EXTINF` from landing just before the boundary keyframe and repeating a whole GOP.
   - The invalidation code above this point (which deletes segments from `fromSegment` onward) must use the adjusted `fromSegment`.
3. **Keep timestamps continuous.** Remove `-start_at_zero` and add `-output_ts_offset <startTime>` after the input. Segment N's PTS then matches its playlist position, so no `#EXT-X-DISCONTINUITY` is needed.
   - Check this against the transcode path too. With `-force_key_frames expr:gte(t,n_forced*6)`, `t` is the output time, so set the expression to `gte(t,${startTime}+n_forced*6)`, or confirm that the keyframes still fall on the 6 s grid.
4. **Check alignment.** After the first segment of a restarted run validates, run `ffprobe -show_entries packet=pts_time -read_intervals %+#1` on it. If its first PTS differs from `startTime` by more than 0.5 s, log a warning, stop the run, and restart from `fromSegment - 1`. Allow only one realignment per run, so this can't loop.
5. Remove the now-redundant "truncated previous segment" check if step 4 covers it. Otherwise keep it.

## Tests

- **Unit test:** start-time calculation with durations `{0: 4.2, 1: 8.3, 2: 6.1}`, restarting from segment 3, gives 18.6 s. If segment 1's duration is unknown, `fromSegment` falls back to 1.
- **Integration test** (skip when `ffmpeg` isn't on PATH):
  - Generate a 60 s H.264/AAC MKV fixture with irregular GOPs: `ffmpeg -f lavfi -i testsrc … -g 100 -keyint_min 30 -sc_threshold 0 …`.
  - Run copy mode, stop after 3 segments, then restart.
  - Concatenate all segments and check with ffprobe that the packet PTS values only increase, with no gaps or overlaps larger than one frame.

## Done when

On the HAiKU MKV, pausing the download partway (forcing capped runs and restarts) and then watching across the restart point plays without a repeat or a jump.
