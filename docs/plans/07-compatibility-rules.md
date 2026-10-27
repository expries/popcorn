# 07 — One set of compatibility rules

**Severity:** high. Also resolves [01](01-mkv-native-strategy.md).

## Root cause

There are three independent rule sets, and they disagree:

| Location | Video OK | Audio OK | Other checks |
|---|---|---|---|
| `hls/codecProbe.ts` (`makeTranscodeDecision`) | h264 | aac, mp3, none | – |
| `hls/streamingStrategy.ts` (`isCodecCompatible`) | h264 | aac, mp3, none | – |
| `routes/stream/utils.ts` (`needsHls`) | h264, vp8, vp9, av1 | aac, mp3, opus, vorbis (**a missing track fails**) | pixel format, H.264 profile and level, moov position, extension |

**Example:** a 10-bit H.264 MP4 gets redirected to HLS by `needsHls`, then `makeTranscodeDecision` returns `copy`. The 10-bit video is passed through unchanged, and the browser still can't play it. A silent MP4 is sent to HLS because of the missing audio track.

There are also two copies of `getContainerFormat` (in `sessionRegistry.ts` and `routes/stream/utils.ts`) and two copies of the codec sets.

## Steps

1. Create `backend/src/hls/compatibility.ts`:
   ```ts
   export interface CompatibilityReport {
     container: { format: string; nativePlayable: boolean; moovOk: boolean };
     video: { codec: string | null; nativeOk: boolean; canCopyToHls: boolean; reasons: string[] };
     audio: { codec: string | null; nativeOk: boolean; canCopyToHls: boolean };
     needsHls: boolean;
     decision: TranscodeDecision;   // only meaningful when needsHls
   }
   export function analyze(fileName: string, codec: CodecInfo): CompatibilityReport;
   export function getContainerFormat(fileName: string): string;
   ```
   Rules:
   - **Container `nativePlayable`:** mp4, m4v, webm, ogv.
   - **`moovOk`:** `moovAtStart !== false`. This matters only for mp4 and mov.
   - **Video `nativeOk`:**
     - h264 qualifies if all of these hold: profile is Baseline, Constrained Baseline, Main or High; level is 4.2 or lower; pixel format is `yuv420p` or `yuvj420p`.
     - vp8, vp9 and av1 qualify only in webm (and av1 in mp4) with 8-bit 4:2:0.
   - **Video `canCopyToHls`:** h264 that meets all the h264 conditions above. MPEG-TS can't practically carry VP9 or AV1.
   - **Audio `nativeOk`:** aac, mp3, opus, vorbis, **or no audio track**.
   - **Audio `canCopyToHls`:** aac, mp3, or no audio track.
   - **`needsHls`:** `!(container.nativePlayable && container.moovOk && video.nativeOk && audio.nativeOk)`.
   - **`decision`:**
     - `videoAction` is copy if `video.canCopyToHls`, otherwise transcode.
     - `audioAction` follows the same rule.
     - `mode` is `copy` if both are copied, `audio_only` if only the video is copied, otherwise `full`.
2. Replace the callers:
   - `codecProbe.makeTranscodeDecision` becomes `analyze(...).decision` (keep the export as a thin wrapper for the tests, or update the tests).
   - `routes/stream/utils.needsHls`, `needsTranscoding` and `needsHlsByExtension` become `analyze(...).needsHls`. Delete the old functions and sets.
   - Delete `streamingStrategy.isCodecCompatible` (see plan 01).
   - `sessionRegistry.getContainerFormat` and `utils.getContainerFormat` become `compatibility.getContainerFormat`.
3. When there's no codec info (the probe failed), `/stream/:hash` currently falls back to native for mp4. Keep that, but log it, and have `/stats` return `requiresHls: null` ("unknown") so the frontend shows "Preparing…" instead of trying native playback.
4. The session key for 10-bit H.264 changes from `_copy` to `_full`. The orphan cleanup in plan 11 removes the old cache directory.
5. Include `reasons` in the `/stats` payload (for example `["pix_fmt yuv420p10le", "audio dts"]`), so the details panel can explain why a file is being transcoded.

## Tests (`backend/tests/compatibility.test.ts`, table-driven)

| File | Expected needsHls | Expected decision |
|---|---|---|
| mp4, h264 High@4.1 yuv420p, aac | false | – |
| mkv, h264 High@4.1 yuv420p, aac | true | copy |
| mp4 with moov at end, h264, aac | true | copy |
| mp4, h264 High 10, yuv420p10le, aac | true | full |
| mp4, h264 High@5.1, aac | true | full |
| mkv, h264, ac3 | true | audio_only |
| mkv, hevc, eac3 | true | full |
| webm, vp9 yuv420p, opus | false | – |
| mkv, vp9, opus | true | full |
| mp4, h264, no audio | false | – |
| avi, h264, mp3 | true | copy |

## Done when

`grep -rn "HLS_COMPATIBLE\|BROWSER_COMPATIBLE" backend/src` finds matches only in `compatibility.ts`, and all the cases in the table pass.
