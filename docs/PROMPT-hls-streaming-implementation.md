# Implementation Prompt: HLS Streaming While Downloading

Use this prompt with an AI coding assistant to implement the HLS streaming while downloading feature.

---

## Prompt

```
Implement the HLS streaming while downloading feature for the Popcorn application based on the specification in docs/IMPLEMENTATION-SPEC-hls-streaming-while-downloading.md.

## Context

This is a video streaming application that downloads content via BitTorrent (using Transmission) and serves it via HLS transcoding (using FFmpeg). The goal is to allow users to watch video content while it's still downloading.

## Key Design Decisions (already made - do not change)

1. **Binary streaming mode**: `'native' | 'hls'` - determined once at session start, no mode switching
2. **Native fallback for H.264**: H.264+AAC content uses native streaming even with moov-at-end
3. **Permanent segment storage**: Transcoded segments are stored permanently, not cached
4. **SSE for real-time updates**: Replace polling with Server-Sent Events
5. **Single progress indicator**: One "available to play" bar instead of multiple technical indicators
6. **Safety margin transcoding**: Stay 2 segments behind download to prevent EOF errors
7. **Incomplete file flags**: Use `-fflags +genpts` and related flags for partial files

## Implementation Order

Implement in this order, testing each phase before moving to the next:

### Phase 1: SSE Progress Endpoint
- Create `backend/src/routes/stream/progressSSE.ts`
- Create `app/src/hooks/useProgressSSE.ts`
- Modify `app/src/hooks/useTorrentStats.ts` to use hybrid SSE + initial fetch
- Test: Verify SSE connection works and progress updates flow

### Phase 2: Streaming Mode Determination
- Create `backend/src/hls/streamingStrategy.ts`
- Modify `backend/src/hls/sessionRegistry.ts` to include streaming mode
- Test: Verify correct mode is determined for MKV, MP4 moov-start, MP4 moov-end, H.264 vs HEVC

### Phase 3: Safety Margin Transcoding
- Modify `backend/src/hls/ffmpegProcess.ts` to add incomplete file flags
- Add safety margin calculation
- Create `backend/src/hls/downloadTracker.ts`
- Test: Verify FFmpeg doesn't hit EOF errors during download

### Phase 4: Permanent Segment Storage
- Create or modify `backend/src/hls/segmentStore.ts`
- Ensure segments persist across FFmpeg restarts
- Test: Verify repeat playback uses stored segments

### Phase 5: Frontend - Transcode-Aware Seeking
- Create `app/src/hooks/useTranscodeAwareSeek.ts`
- Create `app/src/components/TranscodeWaitOverlay.tsx`
- Modify `app/src/components/VideoControls.tsx` for single progress bar
- Test: Verify seeking behavior within and beyond transcoded range

### Phase 6: VideoPlayer Integration
- Modify `app/src/components/VideoPlayer.tsx`
- Add all overlays and states
- Test: Full end-to-end testing with various file types

## Existing Code to Reference

- `backend/src/hls/ffmpegProcess.ts` - Current FFmpeg process management
- `backend/src/hls/sessionRegistry.ts` - Current session management
- `backend/src/hls/codecProbe.ts` - Codec detection with moov atom checking
- `backend/src/hls/segmentCache.ts` - Current segment caching (to be replaced/modified)
- `app/src/components/VideoPlayer.tsx` - Current video player
- `app/src/components/VideoControls.tsx` - Current video controls
- `app/src/hooks/useTorrentStats.ts` - Current polling-based stats

## Success Criteria

- MKV files stream within 10s of 2% download
- MP4 moov-at-start streams within 15s of 5% download
- MP4 moov-at-end with H.264 uses native streaming immediately
- MP4 moov-at-end with HEVC shows clear "waiting for download" message
- No FFmpeg EOF crashes during normal operation
- SSE connections remain stable for 30+ minute sessions
- Single "available to play" progress bar works correctly

## Important Notes

- Use TypeScript throughout
- Follow existing code patterns in the codebase
- Add appropriate error handling
- Use contextual logging with session IDs: `console.log(\`[\${level}] [\${session.sessionKey}] \${message}\`)`
- The spec file has complete code examples - use them as a starting point

Read the full specification at docs/IMPLEMENTATION-SPEC-hls-streaming-while-downloading.md before starting.
```
