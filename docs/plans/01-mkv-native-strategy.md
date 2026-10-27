# 01 — MKV with H.264/AAC is treated as native inside an HLS session

**Severity:** high. This affects the most common torrent format.
**Resolved by:** [07](07-compatibility-rules.md). This file records the specific changes and tests.

## Root cause

`determineStreamingStrategy` (`backend/src/hls/streamingStrategy.ts:44`) returns `mode: 'native'` whenever the codecs are compatible, without considering the container. MKV always goes to HLS (`needsHlsByExtension`). So an H.264/AAC MKV gets an HLS session with these settings:

- `streamingMode: 'native'`
- `useIncompleteFileFlags: false`, so FFmpeg gets no `-t` safety cap and reads into the undownloaded part of the file
- `waitingForDownload: false` at 0% downloaded
- `calculateCanSeekTo` based on download progress instead of finished segments, so the UI allows seeks to positions that haven't been transcoded

## Steps

1. Remove the `isCodecCompatible → native` branch from `determineStreamingStrategy`. Its job becomes deciding *when* transcoding may start, based on the container and the moov atom position. Rename it to `determineTranscodeReadiness` to make that clear.
2. Remove `mode` from `StreamingDecision`. Set `HlsSession.streamingMode` to the constant `'hls'`, or drop the field and update its readers: `progressSSE`, `calculateCanSeekTo`, `getAllDownloads`, and the `streaming_mode` column (keep the column and always write `'hls'`).
3. In `calculateCanSeekTo`, keep the download-progress branch only for `session === null`, which is native streaming.
4. Delete `isCodecCompatible` from `streamingStrategy.ts`. The compatibility module from 07 replaces it.

## Tests (`backend/tests/streamingStrategy.test.ts`)

- MKV with H.264+AAC at 1% downloaded → waiting, `useIncompleteFileFlags: true`, minimum 2%.
- The same file at 3% → `canTranscodeNow: true`.
- MP4 with `moovAtStart: false` and H.264+AAC at 50% → waiting, minimum 100%.
- AVI at 99% → waiting. AVI at 100% → can transcode.

## Done when

The HAiKU MKV starts playing while it is still downloading, the logs show `-t` on its FFmpeg command, and the seek bar's available region matches the transcoded segments.
