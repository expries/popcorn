# HLS Transcoding Rewrite: Streaming While Downloading

## Executive Summary

This document analyzes the implementation of concurrent download and transcoding, allowing users to stream video content while it's still being downloaded. The design incorporates specific mitigations for FFmpeg complications, uses Server-Sent Events (SSE) for efficient progress updates, and handles edge cases like MP4 files with moov atoms at the end.

---

## Current Architecture Overview

```
Current Flow:
  Transmission Download ─────────────────────────→ [Complete]
                                                        ↓
                                              FFmpeg Transcode
                                                        ↓
                                                  HLS Stream
```

**Limitations:**
- Users must wait for significant download progress before playback
- Transcoding only starts when file is substantially available
- No visibility into transcode progress

---

## Proposed Architecture

```
Proposed Flow:
  Transmission Download (Sequential) ─────────────────────────→
           ↓ (bytes available)
  FFmpeg Transcode (with safety margin) ─────────────────────→
           ↓ (segments ready)
  HLS Stream ─────────────────────────────────────────────────→
           ↑
  SSE Progress Updates ←──────────────────────────────────────
```

---

## Pros and Cons Analysis

### Pros

#### 1. Significantly Faster Time-to-Playback
- Users can start watching within seconds of a torrent beginning to download
- No need to wait for full download completion before streaming begins
- Competitive with commercial streaming services like Netflix or Disney+
- Particularly valuable for large files (4K movies at 10-50GB) where full download could take 30+ minutes

#### 2. Improved User Experience
- **Real-time progress visibility**: Users see exactly how much content is available to watch
- **Informed decisions**: Users can decide whether to wait or watch what's available
- **Single unified progress bar**: One indicator showing "available to play" - no technical clutter
- **Predictable behavior**: No mode switching during playback - streaming mode is determined once at start

#### 3. Efficient Resource Utilization
- **Parallel processing**: Download and transcode operations run concurrently
- **Reduced total wait time**: Instead of sequential download→transcode, both happen together
- **CPU utilization during download**: Keeps system busy transcoding while waiting for network I/O

#### 4. Better Network Efficiency with SSE
- **90% reduction in API calls**: Single persistent connection vs polling every second
- **Lower latency**: Real-time push updates vs polling interval delays
- **Reduced bandwidth overhead**: No repeated HTTP headers for each update
- **Server load reduction**: O(clients) vs O(clients × poll_frequency)

#### 5. Graceful Degradation
- **Moov-at-end MP4s with compatible codecs**: Fall back to native streaming with clear user communication
- **Moov-at-end MP4s with incompatible codecs**: Clear messaging that transcoding will begin after download completes
- **Slow downloads**: Users can still watch available transcoded content while waiting
- **Network interruptions**: Recovery mechanisms prevent total failure

#### 6. Future-Proof Architecture
- SSE infrastructure can support additional real-time features (chat, notifications)
- Modular design allows easy addition of new streaming modes
- Clear separation between static and dynamic data

---

### Cons

#### 1. Increased Implementation Complexity
- **More state to manage**: Download position, transcode position, safe margins, pending seeks
- **Race conditions**: Multiple async operations (download, transcode, playback) must be coordinated
- **Error handling**: More failure modes to handle (EOF, network drops, SSE disconnects)
- **Testing difficulty**: Hard to simulate all combinations of download speeds, seek patterns, file types

#### 2. Container Format Limitations (Pre-existing)
> **Note**: These limitations already exist in the current implementation. The current system avoids them by waiting for full download before transcoding. This feature simply makes them visible since we're attempting to transcode earlier.

- **MP4 with moov at end**: Cannot transcode until fully downloaded (~30-40% of MP4 files). FFmpeg needs the moov atom to seek and extract codec parameters. This is a fundamental FFmpeg/MP4 limitation, not introduced by this feature.
- **AVI files**: Lack of index until file is complete. FFmpeg struggles to seek accurately in partial AVI files.
- **Some MKV features**: Certain advanced MKV features (like complex seeking with Matroska cues at the end) may not work with partial files, though MKV generally handles progressive reading better than MP4.
- **Codec detection**: `ffprobe` may fail or return incomplete data on partial downloads if critical metadata hasn't been downloaded yet.

#### 3. Seeking Restrictions
- **Cannot seek beyond transcoded point**: Users must wait if they want to skip ahead
- **UX friction**: "Waiting for transcode" overlay interrupts viewing experience
- **Unpredictable wait times**: Depends on download speed and transcode speed ratio

#### 4. Resource Overhead
- **Memory usage**: SSE connections consume server memory per client
- **FFmpeg restarts**: Seeking backward or far forward requires restarting FFmpeg
- **Duplicate work**: If user seeks back, previously transcoded segments may need regeneration
- **Disk I/O**: Continuous segment writing while downloading

#### 5. Edge Cases and Failure Modes
- **Variable bitrate files**: Safety margin calculation assumes constant bitrate (may be inaccurate)
- **Very slow downloads**: Transcode may catch up to download, causing stalls
- **Corrupt partial files**: FFmpeg may produce artifacts or fail on incomplete data
- **Browser SSE limits**: Some browsers limit concurrent SSE connections

#### 6. Debugging and Monitoring Challenges
- **Harder to reproduce issues**: Bugs may only occur at specific download/transcode ratios
- **Log correlation**: Must correlate download, transcode, and playback logs
- **State inspection**: More complex session state to monitor and debug

#### 7. User Confusion Potential
- **Different wait times**: MKV streams immediately while moov-at-end MP4s must wait for download
- **Technical messaging**: Users may not understand why some files play faster than others

---

### Disadvantage Mitigations

#### Mitigating Con 1: Implementation Complexity

| Problem | Mitigation |
|---------|------------|
| **More state to manage** | Use a single `StreamingSession` class that encapsulates all state with clear invariants. State transitions are explicit via a state machine pattern. |
| **Race conditions** | Use mutex/lock patterns for critical sections. The existing `acquireLock()` pattern in ffmpegProcess.ts is a good foundation. |
| **Error handling** | Implement a centralized error handler with typed error classes. Each error type maps to a recovery strategy. |
| **Testing difficulty** | Create a `MockTransmissionClient` that simulates download speeds. Use property-based testing for seek patterns. |

```typescript
// Centralized state management
class StreamingSession {
  private state: SessionState;
  private readonly lock = new AsyncLock();

  async transition(event: SessionEvent): Promise<void> {
    return this.lock.acquire(async () => {
      const nextState = this.stateMachine.transition(this.state, event);
      await this.executeTransition(this.state, nextState);
      this.state = nextState;
    });
  }
}

// Typed error hierarchy
class StreamingError extends Error {
  constructor(
    message: string,
    public readonly recoverable: boolean,
    public readonly retryStrategy: 'immediate' | 'backoff' | 'none'
  ) {
    super(message);
  }
}

class FFmpegEOFError extends StreamingError {
  constructor() {
    super('FFmpeg reached end of downloaded content', true, 'backoff');
  }
}
```

#### Mitigating Con 2: Container Format Limitations

Already addressed by the **Three-Tier Streaming Strategy** in Section 0. Additional mitigations:

| Problem | Mitigation |
|---------|------------|
| **MP4 moov at end** | Detect during first probe attempt. If probe fails with "moov not found", mark as Tier 3 and offer native streaming. |
| **AVI files** | Treat same as moov-at-end MP4. AVI is rare for modern video; acceptable to wait for full download. |
| **Codec detection failure** | Retry probe with exponential backoff as download progresses. Cache successful probe results. |

**Exponential Backoff Strategy for Codec Detection:**

When probing fails due to insufficient data, retry with increasing intervals:

```
Retry Schedule:
  Attempt 1: Immediate (on first request)
  Attempt 2: After 2% more download progress OR 5 seconds
  Attempt 3: After 5% more download progress OR 15 seconds
  Attempt 4: After 10% more download progress OR 30 seconds
  Attempt 5: After 20% more download progress OR 60 seconds
  Final:     Wait for 100% download
```

```typescript
// Robust container detection with exponential backoff
interface ProbeRetryState {
  attempts: number;
  lastAttemptProgress: number;
  lastAttemptTime: number;
  cachedResult: ProbeResult | null;
}

const BACKOFF_SCHEDULE = [
  { progressDelta: 0.02, minDelayMs: 5000 },   // 2% or 5s
  { progressDelta: 0.05, minDelayMs: 15000 },  // 5% or 15s
  { progressDelta: 0.10, minDelayMs: 30000 },  // 10% or 30s
  { progressDelta: 0.20, minDelayMs: 60000 },  // 20% or 60s
];

class ProbeRetryManager {
  private states = new Map<string, ProbeRetryState>();

  async probeWithBackoff(
    infoHash: string,
    filePath: string,
    downloadProgress: number
  ): Promise<ProbeResult> {
    const state = this.getOrCreateState(infoHash);

    // Return cached successful result
    if (state.cachedResult?.status === 'success') {
      return state.cachedResult;
    }

    // Check if we should retry yet
    if (!this.shouldRetry(state, downloadProgress)) {
      return state.cachedResult ?? { status: 'pending_retry' };
    }

    try {
      const result = await probeFile(filePath);
      state.cachedResult = { status: 'success', codecInfo: result };
      return state.cachedResult;
    } catch (error) {
      state.attempts++;
      state.lastAttemptProgress = downloadProgress;
      state.lastAttemptTime = Date.now();

      if (error.message.includes('moov atom not found')) {
        state.cachedResult = {
          status: 'moov_at_end',
          fallbackMode: 'hls_wait_for_download',
        };
        return state.cachedResult;
      }

      // Schedule next retry based on backoff schedule
      const schedule = BACKOFF_SCHEDULE[Math.min(state.attempts - 1, BACKOFF_SCHEDULE.length - 1)];
      state.cachedResult = {
        status: 'retry_scheduled',
        retryAfterProgress: downloadProgress + schedule.progressDelta,
        retryAfterMs: schedule.minDelayMs,
      };
      return state.cachedResult;
    }
  }

  private shouldRetry(state: ProbeRetryState, currentProgress: number): boolean {
    if (state.attempts === 0) return true;  // First attempt

    const schedule = BACKOFF_SCHEDULE[Math.min(state.attempts - 1, BACKOFF_SCHEDULE.length - 1)];
    const progressSinceLastAttempt = currentProgress - state.lastAttemptProgress;
    const timeSinceLastAttempt = Date.now() - state.lastAttemptTime;

    // Retry if EITHER condition is met
    return progressSinceLastAttempt >= schedule.progressDelta ||
           timeSinceLastAttempt >= schedule.minDelayMs;
  }
}
```

#### Mitigating Con 3: Seeking Restrictions

| Problem | Mitigation |
|---------|------------|
| **Cannot seek beyond transcoded** | Show estimated wait time based on transcode speed. Offer "jump to latest available" button. |
| **UX friction** | Keep overlay simple with clear options: wait or jump to available position. |
| **Unpredictable wait times** | Calculate and display ETA based on: `(targetSegment - currentSegment) / transcodeRate` |

```typescript
// Calculate seek wait time estimate
function estimateSeekWaitTime(
  targetTime: number,
  transcodedDuration: number,
  transcodeRate: number  // segments per second
): { canSeekNow: boolean; estimatedWaitSeconds?: number } {
  if (targetTime <= transcodedDuration) {
    return { canSeekNow: true };
  }

  const segmentsNeeded = Math.ceil((targetTime - transcodedDuration) / SEGMENT_DURATION);
  const estimatedWaitSeconds = segmentsNeeded / transcodeRate;

  return {
    canSeekNow: false,
    estimatedWaitSeconds: Math.ceil(estimatedWaitSeconds),
  };
}
```

**Simple overlay with two options:**

```tsx
// Show wait time estimate to user with simple choices
<TranscodeWaitOverlay
  estimatedWaitSeconds={waitTime}
  targetTime={targetTime}
  availableTime={transcodedDuration}
  onWatchFromAvailable={() => seekTo(transcodedDuration - 2)}
  onCancel={() => resumeAtCurrentPosition()}
/>

// The overlay auto-proceeds when transcode catches up - no "wait in background" needed
// User either waits (overlay shows progress) or jumps to available content
```

#### Mitigating Con 4: Resource Overhead

| Problem | Mitigation |
|---------|------------|
| **SSE memory usage** | Use connection pooling. Limit to 1 SSE connection per client (not per video). Implement heartbeat timeout to clean up stale connections. |
| **FFmpeg restarts** | Store transcoded segments permanently. Only restart FFmpeg if seeking to segment that doesn't exist yet. |
| **Duplicate work** | **Permanent storage strategy**: Once transcoded, segments are never regenerated. After full transcoding, ONLY serve transcoded version. |
| **Disk I/O** | Store segments directly to persistent storage. No temporary files needed. |

**Permanent Transcoded File Strategy:**

The transcoded HLS segments are stored permanently and become the canonical source for streaming:

```
Lifecycle:
1. First request → Start transcoding → Store segments permanently
2. Subsequent requests → Serve from stored segments (no FFmpeg needed)
3. Full transcode complete → Mark as "transcoded" → Only serve HLS
4. Original file → Keep for seeding, but never used for streaming after transcode
```

```typescript
// Permanent segment storage - no eviction, no regeneration
class PermanentSegmentStore {
  private readonly segmentDir: string;

  constructor(baseDir: string, sessionKey: string) {
    this.segmentDir = join(baseDir, 'transcoded', sessionKey);
  }

  /**
   * Check if transcode is complete for this session
   */
  isTranscodeComplete(totalSegments: number): boolean {
    for (let i = 0; i < totalSegments; i++) {
      if (!existsSync(this.getSegmentPath(i))) {
        return false;
      }
    }
    return true;
  }

  /**
   * Get segment - always from permanent storage
   * Returns null if segment doesn't exist yet (still transcoding)
   */
  getSegment(segmentIndex: number): Buffer | null {
    const path = this.getSegmentPath(segmentIndex);
    if (existsSync(path)) {
      return readFileSync(path);
    }
    return null;
  }

  /**
   * Store segment permanently - called by FFmpeg process
   */
  storeSegment(segmentIndex: number, data: Buffer): void {
    const path = this.getSegmentPath(segmentIndex);
    ensureDirSync(dirname(path));
    writeFileSync(path, data);
  }

  private getSegmentPath(index: number): string {
    return join(this.segmentDir, `segment_${index}.ts`);
  }
}

// Session registry with transcoded file preference
class SessionRegistry {
  async getStreamingSource(infoHash: string): Promise<StreamingSource> {
    const store = this.getSegmentStore(infoHash);
    const session = this.getSession(infoHash);

    // If fully transcoded, ONLY serve HLS - never fall back to original
    if (store.isTranscodeComplete(session.totalSegments)) {
      return {
        mode: 'hls_only',
        source: 'transcoded',
        reason: 'Transcoding complete - serving optimized HLS stream',
      };
    }

    // Still transcoding - serve what's available
    return {
      mode: 'hls_progressive',
      source: 'transcoding',
      availableSegments: session.highestGeneratedSegment + 1,
      totalSegments: session.totalSegments,
    };
  }
}
```

**Benefits of permanent storage:**
- No duplicate transcoding work ever
- Instant playback for repeat views
- Consistent quality (always transcoded version)
- Simpler code (no cache eviction logic)

**Disk space management:**
- Transcoded files are tied to torrent lifecycle
- When torrent is removed, transcoded segments are deleted
- Storage ~= 1.0-1.2x original file size (transcoded is similar or smaller)

**SSE connection management:**

```typescript
// Single SSE connection per client with multiplexing
class SSEConnectionManager {
  private connections = new Map<string, SSEConnection>();
  private readonly maxConnectionAge = 30 * 60 * 1000;  // 30 minutes
  private readonly heartbeatInterval = 15 * 1000;  // 15 seconds

  getOrCreateConnection(clientId: string): SSEConnection {
    let conn = this.connections.get(clientId);

    if (!conn || conn.isStale()) {
      conn?.close();
      conn = new SSEConnection(clientId);
      this.connections.set(clientId, conn);
    }

    return conn;
  }

  // Cleanup stale connections periodically
  startCleanupLoop(): void {
    setInterval(() => {
      for (const [id, conn] of this.connections) {
        if (conn.lastHeartbeat < Date.now() - this.heartbeatInterval * 2) {
          conn.close();
          this.connections.delete(id);
        }
      }
    }, this.heartbeatInterval);
  }
}
```

#### Mitigating Con 5: Edge Cases and Failure Modes

| Problem | Mitigation |
|---------|------------|
| **Variable bitrate** | Track actual bytes-per-segment from completed segments. Adjust safety margin dynamically. |
| **Very slow downloads** | Implement "transcode pause" when within 1 segment of download. Resume when 3+ segments available. |
| **Corrupt partial files** | Validate segment output with quick ffprobe check. Re-transcode if corrupt. |
| **Browser SSE limits** | Use single multiplexed connection. Fall back to long-polling if SSE fails. |

```typescript
// Dynamic safety margin based on actual bitrate
class AdaptiveSafetyMargin {
  private segmentSizes: number[] = [];

  recordSegmentSize(segmentIndex: number, sizeBytes: number): void {
    this.segmentSizes[segmentIndex] = sizeBytes;
  }

  calculateSafeSegmentLimit(
    contiguousDownloadedBytes: number,
    currentSegment: number
  ): number {
    // Use actual segment sizes if available
    if (this.segmentSizes.length > 5) {
      const avgSegmentSize = this.getRecentAverageSize();
      const downloadedSegments = Math.floor(contiguousDownloadedBytes / avgSegmentSize);
      return Math.max(0, downloadedSegments - 2);  // 2-segment buffer
    }

    // Fall back to estimate for first few segments
    return this.estimateFromTotalSize(contiguousDownloadedBytes);
  }

  private getRecentAverageSize(): number {
    const recent = this.segmentSizes.slice(-10).filter(Boolean);
    return recent.reduce((a, b) => a + b, 0) / recent.length;
  }
}

// Segment validation
async function validateSegment(segmentPath: string): Promise<boolean> {
  try {
    const result = spawnSync('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_type',
      '-of', 'csv=p=0',
      segmentPath
    ], { timeout: 5000 });

    return result.status === 0 && result.stdout.toString().includes('video');
  } catch {
    return false;
  }
}
```

#### Mitigating Con 6: Debugging and Monitoring Challenges

> **📋 Wave 2 Implementation**: The advanced debugging features below are planned for a second implementation phase. The initial release will use standard logging. These features will be added once the core streaming functionality is stable and validated.

| Problem | Wave 1 (Initial) | Wave 2 (Future) |
|---------|------------------|-----------------|
| **Hard to reproduce** | Standard error logging with context | Deterministic replay mode using recorded events |
| **Log correlation** | Console logs with session ID prefix | Structured JSON logging with correlation IDs |
| **State inspection** | Manual log review | Debug endpoint + admin dashboard |

**Wave 1 Implementation (Initial Release):**

```typescript
// Simple contextual logging - sufficient for initial debugging
function logWithContext(session: HlsSession, level: string, message: string, data?: object) {
  console.log(`[${level}] [${session.sessionKey}] ${message}`, data ?? '');
}

// Usage
logWithContext(session, 'INFO', 'Starting transcoding', { fromSegment: 5 });
logWithContext(session, 'WARN', 'FFmpeg EOF detected, pausing');
logWithContext(session, 'ERROR', 'FFmpeg process crashed', { exitCode: 1 });
```

**Wave 2 Implementation (Future):**

```typescript
// Correlation ID for tracing
interface StreamingContext {
  correlationId: string;
  sessionId: string;
  infoHash: string;
  timestamp: number;
}

function createLogger(ctx: StreamingContext) {
  return {
    info: (msg: string, data?: object) =>
      console.log(JSON.stringify({
        level: 'info',
        ...ctx,
        message: msg,
        ...data,
        timestamp: Date.now(),
      })),
    // ... other levels
  };
}

// Debug endpoint for state inspection
app.get('/debug/session/:infoHash', (req, res) => {
  const session = sessionRegistry.getSessionByInfoHash(req.params.infoHash);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  res.json({
    sessionKey: session.sessionKey,
    state: session.state,
    downloadProgress: session.downloadProgress,
    transcodeProgress: session.transcodeProgress,
    ffmpegState: session.ffmpegState,
    generatedSegments: Array.from(session.generatedSegments),
    cachedSegments: session.cachedSegmentCount,
    lastError: session.lastError,
    timings: {
      created: session.createdAt,
      lastAccess: session.lastAccessedAt,
      transcodeStarted: session.transcodeStartedAt,
    },
  });
});

// Event replay for debugging (Wave 2)
class EventRecorder {
  private events: StreamingEvent[] = [];

  record(event: StreamingEvent): void {
    this.events.push({
      ...event,
      timestamp: Date.now(),
    });
  }

  exportForReplay(): string {
    return JSON.stringify(this.events);
  }
}

class EventReplayer {
  async replay(events: StreamingEvent[]): Promise<void> {
    for (const event of events) {
      await this.processEvent(event);
    }
  }
}
```

#### Mitigating Con 7: User Confusion Potential

**Simplified Binary Logic:** Instead of complex mode switching, use a simple decision tree:

```
Is the video codec browser-compatible (H.264 + AAC)?
├── YES → Native streaming (no transcoding needed)
└── NO  → HLS transcoding required
         ├── Container allows progressive reading (MKV, MP4-moov-start)?
         │   └── YES → Progressive HLS transcoding while downloading
         └── Container requires full file (MP4-moov-end, AVI)?
             └── YES → Wait for download, then HLS transcode
```

| Scenario | Streaming Mode | User Experience |
|----------|----------------|-----------------|
| H.264 + AAC (any container) | **Native** | Direct playback, no transcoding |
| H.264 + AAC in MP4 (moov at end) | **Native** | Direct playback (native handles moov-at-end fine) |
| Non-H.264 in MKV | **HLS** | Progressive transcoding while downloading |
| Non-H.264 in MP4 (moov at start) | **HLS** | Progressive transcoding while downloading |
| Non-H.264 in MP4 (moov at end) | **HLS (wait)** | Must wait for download, then transcode |
| Non-H.264 in AVI | **HLS (wait)** | Must wait for download, then transcode |

**Key principle:** There is NO mode switching during playback. The streaming mode is determined once when playback starts and remains constant.

```typescript
// Simple streaming mode determination - no runtime switching
type StreamingMode = 'native' | 'hls';

function determineStreamingMode(codecInfo: CodecInfo): StreamingMode {
  const isH264 = codecInfo.videoCodec === 'h264';
  const isCompatibleAudio = ['aac', 'mp3'].includes(codecInfo.audioCodec ?? '');

  // Binary decision: either native works or we transcode
  if (isH264 && isCompatibleAudio) {
    return 'native';
  }
  return 'hls';
}

// For HLS mode, determine if we can start immediately or must wait
function canStartTranscodingNow(
  codecInfo: CodecInfo,
  containerFormat: string,
  downloadProgress: number
): { canStart: boolean; reason: string } {
  // MKV: always progressive-friendly
  if (containerFormat === 'matroska' || containerFormat === 'webm') {
    return { canStart: downloadProgress >= 0.02, reason: 'MKV supports progressive reading' };
  }

  // MP4 with moov at start: can transcode progressively
  if (codecInfo.moovAtStart === true) {
    return { canStart: downloadProgress >= 0.05, reason: 'MP4 moov at start' };
  }

  // MP4 with moov at end or AVI: must wait for full download
  return {
    canStart: downloadProgress >= 1.0,
    reason: 'Container requires full download before transcoding',
  };
}
```

**UI messaging - always consistent:**

```tsx
// No mode-specific language - user just sees "available to watch"
function getAvailabilityText(stats: TorrentStats): string {
  const percent = Math.floor(getAvailableFraction(stats) * 100);

  if (percent >= 100) {
    return 'Fully available';
  }

  return `${percent}% available to watch`;
}

// For files that must wait for download
function getWaitingMessage(codecInfo: CodecInfo): string | null {
  if (codecInfo.moovAtStart === false) {
    return 'This video will be available for streaming once the download completes.';
  }
  return null;
}
```

**Benefits of simplified approach:**
- No confusing mode switches during playback
- User always knows what to expect from the start
- Simpler implementation (no transition handling code)
- Predictable behavior across all file types

---

### Trade-off Summary

| Aspect | Benefit | Cost |
|--------|---------|------|
| Time-to-playback | Much faster (~10x) | Implementation complexity |
| Seeking | Works within available range | Blocked beyond available point |
| Network efficiency | 90% fewer API calls | SSE connection management |
| File compatibility | Works with most files | MP4 moov-at-end needs fallback (pre-existing limitation) |
| Resource usage | Parallel CPU/network use | Higher memory per connection |
| User experience | Single unified "available" progress bar | Internal state complexity |
| Reliability | Graceful degradation | More failure modes to handle |

---

### Recommendation

**Proceed with implementation** - The benefits significantly outweigh the costs:

1. **User value is high**: Faster playback is the #1 requested feature for streaming applications
2. **Mitigations are solid**: The proposed solutions for FFmpeg EOF, moov atoms, and seeking are well-designed
3. **Complexity is manageable**: Phased implementation reduces risk
4. **Fallbacks exist**: Native streaming fallback ensures users are never completely blocked

**Key success factors:**
- Thorough testing across file types (MKV, MP4-moov-start, MP4-moov-end, AVI)
- Clear UI communication about streaming modes and limitations
- Robust error recovery and logging
- Performance monitoring for SSE connection scaling

---

## Detailed Design

### 0. Optimized Design for Streaming Downloading Files

This section outlines an architecture specifically optimized for transcoding files that are still being downloaded via BitTorrent.

#### Key Insight: Container Format Strategy

The fundamental challenge with incomplete files is **container format limitations**, not FFmpeg itself. The solution is to work *with* these limitations rather than against them:

| Container | Progressive Reading | Moov Atom | Recommendation |
|-----------|---------------------|-----------|----------------|
| **MKV** | Excellent | N/A (no moov) | Preferred for transcoding |
| **MPEG-TS** | Excellent | N/A | Already used for HLS output |
| **MP4 (moov at start)** | Good | At start | Can transcode immediately |
| **MP4 (moov at end)** | Impossible | At end | Must wait for full download |
| **AVI** | Poor | Index at end | Must wait for full download |

**Design principle**: Detect container capabilities early and choose the optimal streaming strategy.

#### Optimized FFmpeg Flags for Incomplete Files

```typescript
// Optimized FFmpeg input flags for reading incomplete/growing files
const INCOMPLETE_FILE_FLAGS = [
  '-fflags', '+genpts',           // Generate PTS for incomplete headers
  '-analyzeduration', '5000000',  // 5 seconds analysis (not too long)
  '-probesize', '32768',          // Probe first 32KB only (fast startup)
  '-thread_queue_size', '512',    // Buffer for slow I/O
];
```

**Why these flags matter:**

| Flag | Purpose | Impact |
|------|---------|--------|
| `+genpts` | Generate presentation timestamps | Handles missing/incomplete metadata |
| `analyzeduration 5M` | Limit analysis time | Prevents hanging on incomplete files |
| `probesize 32K` | Limit probe bytes | Fast startup, don't wait for distant data |
| `thread_queue_size 512` | I/O buffer | Prevents stalling when file grows slowly |

#### Three-Tier Streaming Strategy

Based on container analysis, use one of three strategies:

```
┌─────────────────────────────────────────────────────────────────┐
│                    Container Detection                          │
└─────────────────────────────────────────────────────────────────┘
                              │
           ┌──────────────────┼──────────────────┐
           ▼                  ▼                  ▼
   ┌───────────────┐  ┌───────────────┐  ┌───────────────┐
   │  TIER 1: MKV  │  │ TIER 2: MP4   │  │ TIER 3: MP4   │
   │  Progressive  │  │ moov at start │  │ moov at end   │
   └───────────────┘  └───────────────┘  └───────────────┘
           │                  │                  │
           ▼                  ▼                  ▼
   ┌───────────────┐  ┌───────────────┐  ┌───────────────┐
   │ Start transcod│  │ Start transcod│  │ Wait for full │
   │ immediately   │  │ immediately   │  │ download, then│
   │ with genpts   │  │ with genpts   │  │ transcode     │
   └───────────────┘  └───────────────┘  └───────────────┘
```

```typescript
// New file: backend/src/hls/streamingStrategy.ts

type StreamingTier = 'progressive' | 'progressive_with_caution' | 'wait_for_complete';

interface StreamingStrategy {
  tier: StreamingTier;
  canTranscodeNow: boolean;
  reason: string;
  minimumDownloadPercent: number;  // Wait for this % before starting
  useIncompleteFileFlags: boolean;
}

function determineStreamingStrategy(
  codecInfo: CodecInfo,
  containerFormat: string,
  downloadProgress: number
): StreamingStrategy {
  // Tier 1: MKV - best for progressive transcoding
  if (containerFormat === 'matroska' || containerFormat === 'webm') {
    return {
      tier: 'progressive',
      canTranscodeNow: downloadProgress >= 0.02,  // Start after 2%
      reason: 'MKV supports progressive reading',
      minimumDownloadPercent: 2,
      useIncompleteFileFlags: true,
    };
  }

  // Tier 2: MP4 with moov at start
  if ((containerFormat === 'mov' || containerFormat === 'mp4') && codecInfo.moovAtStart === true) {
    return {
      tier: 'progressive_with_caution',
      canTranscodeNow: downloadProgress >= 0.05,  // Start after 5%
      reason: 'MP4 with moov at start - can read progressively',
      minimumDownloadPercent: 5,
      useIncompleteFileFlags: true,
    };
  }

  // Tier 3: MP4 with moov at end, AVI, or unknown
  return {
    tier: 'wait_for_complete',
    canTranscodeNow: downloadProgress >= 1.0,
    reason: 'Container requires full download for metadata access',
    minimumDownloadPercent: 100,
    useIncompleteFileFlags: false,
  };
}
```

#### Continuous Transcoding with Download Monitoring

Instead of a fixed safety margin, dynamically adjust transcoding based on real-time download progress:

```typescript
// New file: backend/src/hls/progressiveTranscoder.ts

interface TranscodeState {
  lastDownloadedBytes: number;
  lastTranscodedSegment: number;
  downloadStallCount: number;
  isWaitingForDownload: boolean;
}

class ProgressiveTranscoder {
  private state: TranscodeState;
  private readonly SEGMENT_BYTES_ESTIMATE: number;  // Estimated bytes per segment

  /**
   * Calculate how many segments we can safely transcode based on download progress.
   * Uses piece-level granularity from Transmission for accuracy.
   */
  calculateSafeSegmentLimit(
    downloadedBytes: number,
    totalBytes: number,
    totalSegments: number,
    currentSegment: number
  ): number {
    // Estimate bytes per segment (accounts for variable bitrate)
    const bytesPerSegment = totalBytes / totalSegments;

    // Calculate downloaded segments with 1-segment safety buffer
    const downloadedSegments = Math.floor(downloadedBytes / bytesPerSegment);
    const safeSegmentLimit = Math.max(0, downloadedSegments - 1);

    return safeSegmentLimit;
  }

  /**
   * Monitor FFmpeg stderr for download-related issues
   */
  handleFFmpegStderr(stderr: string): 'continue' | 'pause' | 'abort' {
    // Indicators that we've caught up to download
    const downloadCatchupPatterns = [
      'end of file',
      'Invalid data found when processing input',
      'moov atom not found',
    ];

    for (const pattern of downloadCatchupPatterns) {
      if (stderr.toLowerCase().includes(pattern.toLowerCase())) {
        this.state.downloadStallCount++;

        if (this.state.downloadStallCount >= 3) {
          // Too many stalls - pause and wait for more download
          return 'pause';
        }
        return 'continue';  // Retry once
      }
    }

    // Reset stall count on successful processing
    this.state.downloadStallCount = 0;
    return 'continue';
  }
}
```

#### Optimized FFmpeg Process Lifecycle

```
┌─────────────────────────────────────────────────────────────────┐
│                    FFmpeg Process Lifecycle                      │
└─────────────────────────────────────────────────────────────────┘

  Download: [████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░] 25%
                        ↓
  Transcode: [████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░] 18%
                      ↑
              Safety margin (1-2 segments behind download)

State Machine:
┌─────────┐    download > threshold    ┌──────────────┐
│  IDLE   │ ─────────────────────────→ │  TRANSCODING │
└─────────┘                            └──────────────┘
                                              │
                                              │ transcode catches up
                                              ▼
                                       ┌──────────────┐
                                       │   WAITING    │
                                       │ (for download)│
                                       └──────────────┘
                                              │
                                              │ download progresses
                                              ▼
                                       ┌──────────────┐
                                       │   RESUMING   │
                                       └──────────────┘
                                              │
                                              └──────→ back to TRANSCODING
```

```typescript
// Enhanced FFmpeg state machine
type FFmpegState = 'idle' | 'transcoding' | 'waiting_for_download' | 'resuming' | 'complete';

interface FFmpegLifecycle {
  state: FFmpegState;
  currentSegment: number;
  safeSegmentLimit: number;

  // Transition rules
  shouldPause(): boolean {
    return this.currentSegment >= this.safeSegmentLimit - 1;
  }

  shouldResume(newSafeLimit: number): boolean {
    return this.state === 'waiting_for_download' &&
           newSafeLimit > this.currentSegment + 2;  // Resume when 2+ segments available
  }
}
```

#### Transmission Integration for Accurate Progress

Use Transmission's piece-level data for precise download tracking:

```typescript
// Enhanced: backend/src/services/torrentManager.ts

interface PieceInfo {
  pieceSize: number;
  totalPieces: number;
  completedPieces: Set<number>;
  contiguousBytes: number;  // Bytes available from start without gaps
}

/**
 * Get contiguous downloaded bytes from the start of the file.
 * This is more accurate than total downloaded bytes for streaming.
 */
async function getContiguousDownloadedBytes(infoHash: string): Promise<number> {
  const torrent = await this.client.getTorrent(infoHash);
  const pieceBitfield = decodePieceBitfield(torrent.pieces);

  let contiguousBytes = 0;
  for (let i = 0; i < torrent.pieceCount; i++) {
    if (!pieceBitfield.has(i)) {
      break;  // Gap found - stop counting
    }
    contiguousBytes += torrent.pieceSize;
  }

  return Math.min(contiguousBytes, torrent.sizeWhenDone);
}
```

**Why contiguous bytes matter:**

```
Scenario: 50% downloaded, but with gaps

Total downloaded:  [██░░██░░██░░██░░██░░██░░██░░██░░██░░██░░██░░] 50%
Contiguous from 0: [████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░] 20%

For transcoding, only the contiguous 20% is usable!
```

With sequential download enabled (already in your codebase), this is less of an issue, but it's still the correct metric to track.

---

### 1. FFmpeg EOF Mitigation Strategy

#### Problem
FFmpeg may fail or behave unpredictably when reading files that are still downloading.

#### Solution: Safety Margin Transcoding

The transcoder will only process content up to a calculated "safe point" that trails behind the download position.

```typescript
// New file: backend/src/hls/downloadTracker.ts

interface DownloadProgress {
  downloadedBytes: number;
  contiguousBytes: number;  // More accurate for streaming
  totalBytes: number;
  downloadedDuration: number;  // Calculated from bytes
  totalDuration: number;
}

const SAFETY_MARGIN_SEGMENTS = 2;  // Always stay 2 segments behind download

function calculateSafeSegmentLimit(
  downloadProgress: DownloadProgress,
  totalSegments: number,
  segmentDuration: number
): number {
  // Use contiguous bytes for accuracy
  const downloadFraction = downloadProgress.contiguousBytes / downloadProgress.totalBytes;
  const downloadedSegments = Math.floor(downloadFraction * totalSegments);

  // Apply safety margin
  return Math.max(0, downloadedSegments - SAFETY_MARGIN_SEGMENTS);
}
```

#### FFmpeg Invocation Changes

```typescript
// Modified: backend/src/hls/ffmpegProcess.ts

function buildFFmpegArgs(options: {
  filePath: string;
  startTime: number;
  maxDuration?: number;  // NEW: Limit transcoding to safe point
  transcodeMode: TranscodeMode;
  outputDir: string;
  isIncompleteFile: boolean;  // NEW: Flag for incomplete file handling
}): string[] {
  const args: string[] = [];

  // NEW: Add incomplete file flags first (before input)
  if (options.isIncompleteFile) {
    args.push(
      '-fflags', '+genpts',
      '-analyzeduration', '5000000',
      '-probesize', '32768',
      '-thread_queue_size', '512',
    );
  }

  // Seek position
  if (options.startTime > 0) {
    args.push('-ss', String(options.startTime));
  }

  args.push('-i', options.filePath);

  // NEW: Add duration limit if transcoding incomplete file
  if (options.maxDuration !== undefined) {
    args.push('-t', String(options.maxDuration - options.startTime));
  }

  // ... rest of encoding args
  return args;
}
```

#### Graceful EOF Recovery

```typescript
// Modified: backend/src/hls/ffmpegProcess.ts

function handleFFmpegOutput(
  stderr: string,
  session: HlsSession,
  onEOF: () => void
): void {
  // Detect EOF conditions
  const eofPatterns = [
    'End of file',
    'Invalid data found',
    'moov atom not found',
    'could not find codec parameters',
  ];

  for (const pattern of eofPatterns) {
    if (stderr.includes(pattern)) {
      logger.warn(`FFmpeg hit EOF condition: ${pattern}`);
      onEOF();
      return;
    }
  }
}

// Recovery strategy
async function recoverFromEOF(session: HlsSession): Promise<void> {
  // Stop current FFmpeg process gracefully
  await stopFFmpegProcess(session);

  // Wait for more download progress
  await waitForDownloadProgress(session, {
    additionalBytes: SAFETY_MARGIN_BYTES,
    timeoutMs: 30000,
  });

  // Resume transcoding from last completed segment
  const resumeSegment = session.highestGeneratedSegment + 1;
  await startFFmpegFromSegment(session, resumeSegment);
}
```

---

### 2. MP4 Moov Atom Handling

#### Problem
MP4 files with the moov atom at the end cannot be parsed until fully downloaded.

#### Solution: Detect and Fall Back to Native Streaming

```typescript
// Modified: backend/src/hls/sessionRegistry.ts

interface StreamingDecision {
  mode: 'hls' | 'native';
  reason: string;
  canTranscodeNow: boolean;
  waitingForDownload?: boolean;  // True if HLS mode but must wait for download
}

function determineStreamingMode(
  codecInfo: CodecInfo,
  downloadProgress: number
): StreamingDecision {
  const needsTranscode = !isHlsCompatible(codecInfo);

  // MP4 with moov at end - special handling
  if (codecInfo.moovAtStart === false) {
    if (downloadProgress < 1.0) {
      return {
        mode: 'hls',
        reason: 'MP4 moov atom at end - must wait for download to complete before transcoding',
        waitingForDownload: true,
        canTranscodeNow: false,
      };
    }
    // Download complete - can now transcode
    return {
      mode: needsTranscode ? 'hls' : 'native',
      reason: 'Download complete, moov atom now accessible',
      canTranscodeNow: true,
    };
  }

  // Standard case - can transcode progressively
  return {
    mode: needsTranscode ? 'hls' : 'native',
    reason: needsTranscode
      ? 'Codec requires transcoding'
      : 'Codec is browser-compatible',
    canTranscodeNow: true,
  };
}
```

#### Stats Response Enhancement

```typescript
// Modified: backend/src/routes/stream/statsHandler.ts

interface EnhancedTorrentStats extends TorrentStats {
  codecInfo: CodecInfo & {
    moovAtStart: boolean | null;
    moovPosition: 'start' | 'end' | 'unknown';  // Human-readable
  };
  streamingMode: 'hls' | 'native';
  streamingModeReason: string;
  transcodeAvailable: boolean;
}
```

#### Frontend Disclaimer Component

```tsx
// New component: app/src/components/MoovAtomWarning.tsx

interface MoovAtomWarningProps {
  moovPosition: 'start' | 'end' | 'unknown';
  downloadProgress: number;
}

export function MoovAtomWarning({ moovPosition, downloadProgress }: MoovAtomWarningProps) {
  if (moovPosition !== 'end') return null;

  const isDownloadComplete = downloadProgress >= 1.0;

  return (
    <div className="flex items-center gap-2">
      <span className="text-sm">Moov Position: {moovPosition}</span>
      <div className="group relative">
        <QuestionMarkIcon className="w-4 h-4 text-muted-foreground cursor-help" />
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2
                        bg-popover border border-input rounded-lg shadow-lg
                        opacity-0 group-hover:opacity-100 transition-opacity
                        w-64 text-xs text-muted-foreground pointer-events-none z-50">
          {isDownloadComplete ? (
            <p>Download complete. HLS transcoding is now available.</p>
          ) : (
            <p>
              This MP4 file has metadata at the end, which prevents transcoding
              until the download completes. Native streaming is available in the
              meantime if your browser supports the codec.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
```

#### Integration in Stream Info Panel

```tsx
// Modified: app/src/components/VideoPlayer.tsx (Stream Info Panel section)

{/* Codec Info */}
{stats.codecInfo && (
  <div>
    <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
      Codec Information
    </h3>
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      {/* ... existing codec info cards ... */}

      {/* NEW: Moov Position Card */}
      <div className="bg-muted/30 rounded-lg p-3">
        <p className="text-xs text-muted-foreground mb-1">Moov Position</p>
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium">
            {stats.codecInfo.moovPosition === 'end' ? (
              <span className="text-yellow-500">End</span>
            ) : stats.codecInfo.moovPosition === 'start' ? (
              <span className="text-green-500">Start</span>
            ) : (
              <span>N/A</span>
            )}
          </p>
          {stats.codecInfo.moovPosition === 'end' && (
            <MoovAtomWarning
              moovPosition={stats.codecInfo.moovPosition}
              downloadProgress={stats.progress}
            />
          )}
        </div>
      </div>

      {/* NEW: Stream Mode with explanation */}
      <div className="bg-muted/30 rounded-lg p-3">
        <p className="text-xs text-muted-foreground mb-1">Stream Mode</p>
        <p className="text-sm font-medium">
          {stats.streamingMode === 'hls' && stats.waitingForDownload ? (
            <span className="text-yellow-500">HLS (waiting for download)</span>
          ) : stats.streamingMode === 'hls' ? (
            <span className="text-blue-500">HLS (Transcoding)</span>
          ) : (
            <span className="text-green-500">Native</span>
          )}
        </p>
      </div>
    </div>
  </div>
)}
```

---

### 3. Server-Sent Events (SSE) for Progress Updates

#### Why SSE Over Polling

| Aspect | Polling | SSE |
|--------|---------|-----|
| Connections | New connection every interval | Single persistent connection |
| Latency | Up to poll interval | Real-time push |
| Server load | O(clients × frequency) | O(clients) |
| Bandwidth | Headers on every request | Minimal overhead |
| Complexity | Simple | Moderate |

#### Backend SSE Endpoint

```typescript
// New file: backend/src/routes/stream/progressSSE.ts

import { Router, Request, Response } from 'express';
import { sessionRegistry } from '../../hls/sessionRegistry';
import { torrentManager } from '../../services/torrentManager';

const router = Router();

interface ProgressUpdate {
  // Download progress
  downloadProgress: number;
  downloadedBytes: number;
  totalBytes: number;
  downloadSpeed: number;
  uploadSpeed: number;
  numPeers: number;

  // Transcode progress (only when HLS mode)
  transcodeProgress?: number;
  transcodedDuration?: number;
  transcodedSegments?: number;
  totalSegments?: number;

  // Streaming info
  streamingMode: 'hls' | 'native';
  canSeekTo: number;  // Max seekable position in seconds

  // Status
  isTranscoding: boolean;
  isDownloading: boolean;
}

router.get('/:infoHash/progress', async (req: Request, res: Response) => {
  const { infoHash } = req.params;

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

  // Send initial connection confirmation
  res.write(`event: connected\ndata: ${JSON.stringify({ infoHash })}\n\n`);

  const sendUpdate = async () => {
    try {
      const torrentStats = await torrentManager.getTorrentStats(infoHash);
      const session = sessionRegistry.getSession(infoHash);

      if (!torrentStats) {
        res.write(`event: error\ndata: ${JSON.stringify({ error: 'Torrent not found' })}\n\n`);
        return;
      }

      const update: ProgressUpdate = {
        // Download stats
        downloadProgress: torrentStats.progress,
        downloadedBytes: torrentStats.downloaded,
        totalBytes: torrentStats.totalSize,
        downloadSpeed: torrentStats.downloadSpeed,
        uploadSpeed: torrentStats.uploadSpeed,
        numPeers: torrentStats.numPeers,

        // Streaming mode
        streamingMode: session?.streamingMode ?? 'native',
        canSeekTo: session?.transcodedDuration ?? torrentStats.duration ?? 0,

        // Status flags
        isDownloading: torrentStats.progress < 1.0,
        isTranscoding: session?.isGenerating ?? false,
      };

      // Add transcode progress if in HLS mode
      if (session && session.streamingMode === 'hls') {
        update.transcodeProgress = session.transcodedDuration / session.totalDuration;
        update.transcodedDuration = session.transcodedDuration;
        update.transcodedSegments = session.highestGeneratedSegment + 1;
        update.totalSegments = session.totalSegments;
      }

      res.write(`event: progress\ndata: ${JSON.stringify(update)}\n\n`);
    } catch (error) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: String(error) })}\n\n`);
    }
  };

  // Send updates every second
  const interval = setInterval(sendUpdate, 1000);

  // Send initial update immediately
  sendUpdate();

  // Cleanup on disconnect
  req.on('close', () => {
    clearInterval(interval);
  });
});

export default router;
```

#### Frontend SSE Hook

```typescript
// New file: app/src/hooks/useProgressSSE.ts

import { useState, useEffect, useCallback, useRef } from 'react';

const STREAM_SERVER_URL = 'http://localhost:3002';

export interface ProgressData {
  // Download
  downloadProgress: number;
  downloadedBytes: number;
  totalBytes: number;
  downloadSpeed: number;
  uploadSpeed: number;
  numPeers: number;

  // Transcode
  transcodeProgress?: number;
  transcodedDuration?: number;
  transcodedSegments?: number;
  totalSegments?: number;

  // Streaming
  streamingMode: 'hls' | 'native';
  canSeekTo: number;

  // Status
  isTranscoding: boolean;
  isDownloading: boolean;
}

interface UseProgressSSEOptions {
  enabled?: boolean;
  onError?: (error: string) => void;
}

export function useProgressSSE(
  infoHash: string | null,
  options: UseProgressSSEOptions = {}
) {
  const { enabled = true, onError } = options;
  const [progress, setProgress] = useState<ProgressData | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const connect = useCallback(() => {
    if (!infoHash || !enabled) return;

    // Clean up existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const url = `${STREAM_SERVER_URL}/stream/${infoHash}/progress`;
    const eventSource = new EventSource(url);
    eventSourceRef.current = eventSource;

    eventSource.addEventListener('connected', () => {
      setIsConnected(true);
      setConnectionError(null);
    });

    eventSource.addEventListener('progress', (event) => {
      try {
        const data: ProgressData = JSON.parse(event.data);
        setProgress(data);
      } catch (e) {
        console.error('Failed to parse progress data:', e);
      }
    });

    eventSource.addEventListener('error', (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data);
        setConnectionError(data.error);
        onError?.(data.error);
      } catch {
        // Connection error, not a message error
        setIsConnected(false);
        setConnectionError('Connection lost');

        // Attempt reconnection after 3 seconds
        reconnectTimeoutRef.current = setTimeout(() => {
          connect();
        }, 3000);
      }
    });

    eventSource.onerror = () => {
      setIsConnected(false);
      // EventSource will auto-reconnect, but we track state
    };
  }, [infoHash, enabled, onError]);

  useEffect(() => {
    connect();

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, [connect]);

  return {
    progress,
    isConnected,
    connectionError,
    reconnect: connect,
  };
}
```

#### Replacing Polling with SSE

The current implementation uses React Query polling (`refetchInterval: 1000`). With SSE:

```typescript
// Modified: app/src/hooks/useTorrentStats.ts

import { useQuery } from '@tanstack/react-query';
import { useProgressSSE, ProgressData } from './useProgressSSE';

// Keep initial fetch for non-realtime data (codec info, file name, etc.)
export function useTorrentStats(infoHash: string | null) {
  // One-time fetch for static data
  const staticQuery = useQuery({
    queryKey: ['torrentStatsStatic', infoHash],
    queryFn: () => fetchTorrentStats(infoHash!),
    enabled: !!infoHash,
    staleTime: Infinity,  // Static data doesn't change
    refetchInterval: false,  // No polling
  });

  // Real-time updates via SSE
  const { progress: realtimeProgress, isConnected } = useProgressSSE(infoHash);

  // Merge static and realtime data
  const mergedStats = useMemo(() => {
    if (!staticQuery.data) return null;
    if (!realtimeProgress) return staticQuery.data;

    return {
      ...staticQuery.data,
      // Override with real-time values
      progress: realtimeProgress.downloadProgress,
      downloadSpeed: realtimeProgress.downloadSpeed,
      uploadSpeed: realtimeProgress.uploadSpeed,
      numPeers: realtimeProgress.numPeers,
      // New real-time fields
      transcodeProgress: realtimeProgress.transcodeProgress,
      transcodedDuration: realtimeProgress.transcodedDuration,
      canSeekTo: realtimeProgress.canSeekTo,
      streamingMode: realtimeProgress.streamingMode,
      isTranscoding: realtimeProgress.isTranscoding,
    };
  }, [staticQuery.data, realtimeProgress]);

  return {
    data: mergedStats,
    isLoading: staticQuery.isLoading,
    isConnected,
  };
}
```

#### SSE for All Video Stats - Analysis

**Should codec/resolution/seeders/download stats also use SSE?**

| Data Type | Update Frequency | SSE Appropriate? | Recommendation |
|-----------|-----------------|------------------|----------------|
| Download progress | Every second | Yes | Include in SSE |
| Download/upload speed | Every second | Yes | Include in SSE |
| Peer count | Every few seconds | Yes | Include in SSE |
| Transcode progress | Every second | Yes | Include in SSE |
| Codec info | Never changes | No | Initial fetch only |
| Resolution | Never changes | No | Initial fetch only |
| File name/size | Never changes | No | Initial fetch only |
| Moov position | Never changes | No | Initial fetch only |

**Recommendation:** Use a hybrid approach:
- **SSE**: All dynamic/real-time stats (progress, speeds, peers, transcode)
- **Initial fetch**: All static metadata (codec, resolution, file info)

This is already reflected in the `useTorrentStats` modification above.

---

### 4. Seeking Past Transcoded Content

#### Problem
User seeks to a position that hasn't been transcoded yet.

#### Solution: "Waiting for Transcode" Overlay with Seek-Back Capability

```typescript
// New file: app/src/hooks/useTranscodeAwareSeek.ts

interface TranscodeAwareSeekOptions {
  canSeekTo: number;           // Max transcoded position in seconds
  totalDuration: number;
  currentTime: number;
  onSeekBlocked: (targetTime: number) => void;
  onSeekAllowed: (targetTime: number) => void;
}

export function useTranscodeAwareSeek({
  canSeekTo,
  totalDuration,
  currentTime,
  onSeekBlocked,
  onSeekAllowed,
}: TranscodeAwareSeekOptions) {
  const [pendingSeek, setPendingSeek] = useState<number | null>(null);
  const [isWaitingForTranscode, setIsWaitingForTranscode] = useState(false);

  // Handle seek request
  const requestSeek = useCallback((targetTime: number) => {
    if (targetTime <= canSeekTo) {
      // Seek is within transcoded range - allow immediately
      setPendingSeek(null);
      setIsWaitingForTranscode(false);
      onSeekAllowed(targetTime);
    } else {
      // Seek is beyond transcoded range - show waiting state
      setPendingSeek(targetTime);
      setIsWaitingForTranscode(true);
      onSeekBlocked(targetTime);
    }
  }, [canSeekTo, onSeekAllowed, onSeekBlocked]);

  // Watch for transcode progress to catch up to pending seek
  useEffect(() => {
    if (pendingSeek !== null && canSeekTo >= pendingSeek) {
      // Transcode has caught up - execute the seek
      setIsWaitingForTranscode(false);
      onSeekAllowed(pendingSeek);
      setPendingSeek(null);
    }
  }, [canSeekTo, pendingSeek, onSeekAllowed]);

  // Cancel pending seek (user seeks back to available range)
  const cancelPendingSeek = useCallback(() => {
    setPendingSeek(null);
    setIsWaitingForTranscode(false);
  }, []);

  // Seek back to last available position
  const seekToTranscoded = useCallback(() => {
    cancelPendingSeek();
    // Seek to slightly before the max to ensure smooth playback
    const safePosition = Math.max(0, canSeekTo - 2);
    onSeekAllowed(safePosition);
  }, [canSeekTo, cancelPendingSeek, onSeekAllowed]);

  return {
    requestSeek,
    cancelPendingSeek,
    seekToTranscoded,
    isWaitingForTranscode,
    pendingSeekTarget: pendingSeek,
    transcodeProgress: canSeekTo / totalDuration,
  };
}
```

#### "Waiting for Transcode" Overlay Component

```tsx
// New file: app/src/components/TranscodeWaitOverlay.tsx

interface TranscodeWaitOverlayProps {
  isVisible: boolean;
  pendingSeekTarget: number | null;
  canSeekTo: number;
  transcodeProgress: number;
  onSeekBack: () => void;
  onCancel: () => void;
}

export function TranscodeWaitOverlay({
  isVisible,
  pendingSeekTarget,
  canSeekTo,
  transcodeProgress,
  onSeekBack,
  onCancel,
}: TranscodeWaitOverlayProps) {
  if (!isVisible) return null;

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div
      className="absolute inset-0 flex items-center justify-center bg-black/50 z-20"
      onClick={onCancel}  // Click anywhere to cancel and resume
    >
      <div
        className="flex flex-col items-center gap-4 text-white p-6 rounded-xl bg-black/70"
        onClick={(e) => e.stopPropagation()}  // Prevent cancel when clicking dialog
      >
        {/* Spinner - same style as buffering */}
        <svg className="w-12 h-12 animate-spin" viewBox="0 0 24 24" fill="none">
          <circle
            className="opacity-25"
            cx="12" cy="12" r="10"
            stroke="currentColor"
            strokeWidth="3"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
          />
        </svg>

        {/* Status message */}
        <div className="text-center">
          <p className="text-sm font-medium">Waiting for transcode...</p>
          <p className="text-xs text-gray-400 mt-1">
            Seeking to {formatTime(pendingSeekTarget ?? 0)}
          </p>
          <p className="text-xs text-gray-400">
            Transcoded up to {formatTime(canSeekTo)} ({(transcodeProgress * 100).toFixed(0)}%)
          </p>
        </div>

        {/* Progress bar */}
        <div className="w-48 h-2 bg-gray-700 rounded-full overflow-hidden">
          <div
            className="h-full bg-primary transition-all duration-300"
            style={{ width: `${transcodeProgress * 100}%` }}
          />
        </div>

        {/* Action buttons */}
        <div className="flex gap-3 mt-2">
          <button
            onClick={onSeekBack}
            className="px-4 py-2 bg-primary hover:bg-primary/80 rounded-lg text-sm
                       transition-colors cursor-pointer"
          >
            Watch from {formatTime(canSeekTo)}
          </button>
          <button
            onClick={onCancel}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm
                       transition-colors cursor-pointer"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
```

#### Integration in VideoPlayer

```tsx
// Modified: app/src/components/VideoPlayer.tsx

export function VideoPlayer({ stats, status }: VideoPlayerProps) {
  // ... existing state ...

  // NEW: Transcode-aware seeking
  const {
    requestSeek,
    cancelPendingSeek,
    seekToTranscoded,
    isWaitingForTranscode,
    pendingSeekTarget,
    transcodeProgress,
  } = useTranscodeAwareSeek({
    canSeekTo: stats.canSeekTo ?? stats.duration ?? 0,
    totalDuration: stats.duration ?? 0,
    currentTime: controls.currentTime,
    onSeekBlocked: (target) => {
      // Pause video while waiting
      videoElement?.pause();
    },
    onSeekAllowed: (target) => {
      // Execute the actual seek
      if (videoElement) {
        videoElement.currentTime = target;
        videoElement.play().catch(console.error);
      }
    },
  });

  // Modified seek handler - goes through transcode-aware logic
  const handleSeekBarClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const fraction = (e.clientX - rect.left) / rect.width;
    const targetTime = fraction * duration;

    // Use transcode-aware seek instead of direct seek
    requestSeek(targetTime);
  };

  return (
    <div className="flex flex-col gap-4">
      {canStream ? (
        <div ref={containerRef} className={cn('relative ...', ...)}>
          <video ... />

          {/* Existing overlays */}
          {videoError && <ErrorOverlay ... />}
          {requiresHls && !hasStarted && !isHlsLoading && <PlayButton ... />}
          {(isHlsLoading || controls.isBuffering) && requiresHls && <BufferingOverlay ... />}

          {/* NEW: Transcode wait overlay */}
          <TranscodeWaitOverlay
            isVisible={isWaitingForTranscode}
            pendingSeekTarget={pendingSeekTarget}
            canSeekTo={stats.canSeekTo ?? 0}
            transcodeProgress={transcodeProgress}
            onSeekBack={seekToTranscoded}
            onCancel={cancelPendingSeek}
          />

          {/* Video controls with transcode progress */}
          {requiresHls && hasStarted && (
            <VideoControls
              ...
              transcodedFraction={transcodeProgress}  // NEW prop
              ...
            />
          )}
        </div>
      ) : (
        <WaitingOverlay ... />
      )}

      {/* Stream Info Panel */}
      ...
    </div>
  );
}
```

#### Progress Bar - Unified "Available to Play" Indicator

The progress bar uses a **single indicator** showing how much of the video is available to play. This replaces the previous multi-layer approach (download + transcode + buffer) with one intuitive visual:

```
Progress Bar Layout:
┌─────────────────────────────────────────────────────────────┐
│█████████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│
│←── Available ──────→←───────── Not yet available ─────────→│
│        ▲                                                    │
│   Playhead                                                  │
└─────────────────────────────────────────────────────────────┘
```

**Key principle**: The user only needs to know "what can I watch?" - not the technical details of download vs transcode progress.

```tsx
// Modified: app/src/components/VideoControls.tsx

interface VideoControlsProps {
  // ... existing props ...
  availableFraction: number;  // 0-1, how much is available to play
  // REMOVED: downloadedRanges - no longer shown separately
}

export function VideoControls({
  // ... existing props ...
  availableFraction,
}: VideoControlsProps) {
  return (
    <div className="absolute bottom-0 left-0 right-0 p-4 ...">
      {/* Seek bar */}
      <div className="h-2 bg-muted/50 rounded-full cursor-pointer relative group" onClick={onSeekBarClick}>

        {/* Single "available to play" indicator */}
        <div
          className="absolute h-full bg-muted-foreground/40 rounded-full"
          style={{ width: `${availableFraction * 100}%` }}
        />

        {/* Current playback position */}
        <div
          className="absolute h-full bg-primary rounded-full transition-all z-10"
          style={{ width: `${progress}%` }}
        />

        {/* Hover effect */}
        <div className="absolute inset-0 bg-primary/20 rounded-full opacity-0 group-hover:opacity-100 transition-opacity" />
      </div>

      {/* Controls row */}
      ...
    </div>
  );
}
```

**What "available" means depends on streaming mode:**

| Streaming Mode | "Available" = |
|----------------|---------------|
| HLS (transcoding) | Transcoded duration (rate-limiting factor) |
| HLS (waiting for download) | 0% until download completes, then transcoded duration |
| Native streaming | Downloaded bytes (can seek anywhere downloaded) |

```typescript
// Helper to compute available fraction
function getAvailableFraction(stats: TorrentStats): number {
  if (stats.streamingMode === 'hls') {
    // For HLS, transcode progress is the limiting factor
    return stats.transcodedDuration / stats.totalDuration;
  } else {
    // For native streaming, download progress determines availability
    return stats.progress;
  }
}
```

This ensures users see **one progress indicator** that directly answers: "How much can I watch right now?"

---

### 5. Session State Enhancements

```typescript
// Modified: backend/src/hls/types.ts

export interface HlsSession {
  // Existing fields
  sessionKey: SessionKey;
  infoHash: string;
  filePath: string;
  codecInfo: CodecInfo;
  transcodeDecision: TranscodeDecision;
  totalSegments: number;
  totalDuration: number;

  // FFmpeg state
  ffmpegProcess: ChildProcess | null;
  ffmpegStartSegment: number;
  highestGeneratedSegment: number;
  isGenerating: boolean;
  generatedSegments: Set<number>;

  // NEW: Progressive transcode state
  streamingMode: 'hls' | 'native';
  transcodedDuration: number;           // Seconds of video transcoded
  lastDownloadedBytes: number;          // Track download progress
  safeTranscodePosition: number;        // Max position FFmpeg should transcode to

  // Timestamps
  createdAt: Date;
  lastAccessedAt: Date;
}
```

---

## Implementation Phases

### Phase 1: Foundation (SSE + Progress Tracking)
1. Implement SSE endpoint for progress updates
2. Add `useProgressSSE` hook on frontend
3. Modify `useTorrentStats` to use hybrid fetch/SSE approach
4. Add transcode progress tracking to session state

### Phase 2: Safety Margin Transcoding
1. Implement download position monitoring
2. Add safety margin calculation
3. Modify FFmpeg process to respect duration limits
4. Add EOF recovery logic

### Phase 3: Moov Atom Handling
1. Add `streamingMode` determination logic
2. Implement `waitingForDownload` state for HLS mode
3. Add frontend disclaimer component
4. Handle mode transition when download completes

### Phase 4: Transcode-Aware Seeking
1. Implement `useTranscodeAwareSeek` hook
2. Add `TranscodeWaitOverlay` component
3. Modify progress bar to show transcoded range
4. Integration testing for seek scenarios

### Phase 5: Polish & Edge Cases
1. Handle network interruptions gracefully
2. Test with various container formats (MKV, MP4, AVI)
3. Performance optimization
4. Error state UI refinement

---

## File Changes Summary

### New Files
| File | Purpose |
|------|---------|
| `backend/src/hls/streamingStrategy.ts` | Three-tier streaming strategy based on container format |
| `backend/src/hls/progressiveTranscoder.ts` | State machine for progressive transcoding with download monitoring |
| `backend/src/hls/downloadTracker.ts` | Download position monitoring with contiguous byte tracking |
| `backend/src/routes/stream/progressSSE.ts` | SSE endpoint for real-time progress |
| `app/src/hooks/useProgressSSE.ts` | Frontend SSE consumer hook |
| `app/src/hooks/useTranscodeAwareSeek.ts` | Seek logic with transcode awareness |
| `app/src/components/TranscodeWaitOverlay.tsx` | "Waiting for transcode" UI |
| `app/src/components/MoovAtomWarning.tsx` | Moov position disclaimer |

### Modified Files
| File | Changes |
|------|---------|
| `backend/src/hls/ffmpegProcess.ts` | Incomplete file flags (`+genpts`, `probesize`), safety margin, EOF recovery |
| `backend/src/hls/sessionRegistry.ts` | Streaming tier logic, new session fields |
| `backend/src/hls/codecProbe.ts` | Container format detection |
| `backend/src/hls/types.ts` | Extended session interface with FFmpeg state machine |
| `backend/src/services/torrentManager.ts` | Contiguous byte tracking for accurate progress |
| `backend/src/routes/stream/statsHandler.ts` | Enhanced stats response with streaming tier |
| `app/src/hooks/useTorrentStats.ts` | Hybrid fetch/SSE approach |
| `app/src/components/VideoPlayer.tsx` | Transcode overlay, seek handling |
| `app/src/components/VideoControls.tsx` | Unified "available to play" progress bar |

---

## Risk Mitigation Summary

| Risk | Mitigation |
|------|------------|
| FFmpeg EOF errors | `-fflags +genpts`, conservative `probesize`, 2-segment safety margin, graceful recovery |
| Container format limitations | Three-tier strategy: MKV (progressive), MP4-moov-start (cautious), MP4-moov-end (wait) |
| Variable bitrate inaccuracy | Use contiguous bytes from Transmission piece data, not estimated duration |
| Transcode catches up to download | FFmpeg state machine: TRANSCODING → WAITING → RESUMING cycle |
| SSE connection drops | Auto-reconnect with 3s delay, EventSource built-in retry |
| Seeking past transcoded | Overlay with options: wait (auto-proceed when ready), seek back, or cancel |
| User confusion | Single "available to play" progress bar - one indicator for everything |

---

## Success Metrics

1. **Time to first playback**:
   - MKV files: <10s after 2% downloaded
   - MP4 moov-at-start: <15s after 5% downloaded
   - MP4 moov-at-end (H.264): Immediate via native streaming fallback
   - MP4 moov-at-end (HEVC): Transcoding begins after download completes (clear messaging to user)

2. **Seek responsiveness**: Within-available seeks should be instant (<100ms)

3. **Server load**: SSE should reduce API calls by ~90% vs polling

4. **Error rate**:
   - EOF-related failures: <1% with safety margin
   - FFmpeg crashes: <0.1% with `+genpts` flag

5. **Container support**:
   - MKV: 100% progressive streaming support
   - MP4 moov-at-start: 100% progressive streaming support
   - MP4 moov-at-end (H.264): 100% via native streaming fallback
   - MP4 moov-at-end (HEVC): Wait for download, then HLS transcoding (clear messaging)

---

## Strengths and Weakpoints Analysis

This section provides a consolidated assessment of the proposed architecture's strengths and weakpoints after incorporating all mitigations and design decisions.

### Architectural Strengths

#### 1. Clear Binary Decision Model
The simplified `'native' | 'hls'` streaming mode eliminates complexity:

| Strength | Impact |
|----------|--------|
| No runtime mode switching | Predictable user experience, simpler state management |
| Single decision point | Reduces race conditions and edge cases |
| Deterministic behavior | Easier to test and debug |

**Why this matters:** The original three-mode approach (`native | hls | native_until_complete`) created transition scenarios that were hard to handle gracefully. The simplified binary model means the streaming strategy is locked in at session creation.

#### 2. Permanent Transcoded File Storage
Storing transcoded segments permanently (not cached) provides significant benefits:

```
First watch:  Download → Transcode → Store permanently → Stream
Repeat watch: Stream directly from stored segments (instant)
```

| Strength | Impact |
|----------|--------|
| Zero duplicate transcoding | CPU savings on repeat views |
| Instant repeat playback | No waiting on subsequent watches |
| Simpler code | No cache eviction, LRU, or regeneration logic |
| Consistent quality | Always serve the same transcoded output |

#### 3. Robust FFmpeg Handling
The incomplete file flags and state machine provide resilience:

| Component | Strength |
|-----------|----------|
| `+genpts` flag | Handles missing timestamps in partial files |
| Safety margin (2 segments) | Prevents EOF errors before they occur |
| State machine (IDLE→TRANSCODING→WAITING→RESUMING) | Clean recovery from download stalls |
| Exponential backoff for probing | Efficient retry without hammering failing files |

#### 4. Efficient Real-time Updates (SSE)
The hybrid SSE + initial fetch approach optimizes for both efficiency and simplicity:

| Data Type | Delivery Method | Rationale |
|-----------|-----------------|-----------|
| Progress, speeds, peers | SSE (real-time) | Changes every second |
| Codec info, file name | Initial fetch | Never changes |

**Estimated improvement:** 90% reduction in API calls vs. polling.

#### 5. User-Centric Progress Indicator
The single "available to play" progress bar is a UX strength:

- Users don't need to understand download vs. transcode vs. buffer
- One clear answer to "how much can I watch?"
- Consistent across all streaming modes

---

### Architectural Weakpoints

#### 1. Moov-at-End MP4s with Incompatible Codecs: No Progressive Streaming
**Severity: Medium (but reduced scope)**

For MP4 files with moov atom at end AND incompatible codecs (HEVC, etc.), users must wait for full download before playback.

| Scenario | Behavior |
|----------|----------|
| H.264 moov-at-end MP4 | **Native streaming works immediately** (browser handles moov-at-end) |
| HEVC moov-at-end MP4 | Wait for download, then HLS transcode |

**Why this weakness is reduced:**
- H.264 + AAC files (most common codec combo) work fine with native streaming even with moov at end
- Only HEVC/VP9/other incompatible codecs in moov-at-end containers are affected
- This is a smaller subset of files than originally stated

**Remaining weakpoint for HEVC moov-at-end:**
- Large files (10-50GB) may take 30+ minutes to download
- User cannot preview content while waiting
- This is a fundamental FFmpeg limitation (cannot read incomplete MP4 without moov)

**Mitigation already in place:**
- **H.264 moov-at-end**: Falls back to native streaming with clear messaging
- **HEVC moov-at-end**: Clear UI messaging: "This video requires transcoding and will be available after download completes"
- Download progress is visible in both cases

**Possible future improvement:**
- Investigate `mp4box` or similar tools to extract partial data for HEVC files
- Consider downloading moov atom first (requires torrent piece prioritization)

#### 2. Disk Space Overhead from Permanent Storage
**Severity: Low-Medium**

Storing transcoded files permanently doubles disk usage per video:

```
Original file:    10 GB
Transcoded HLS:   ~10-12 GB (similar or slightly larger)
Total:            ~20-22 GB per video
```

| Concern | Impact |
|---------|--------|
| Storage cost | 2x disk usage while torrent is active |
| SSD wear | More writes for transcoded segments |
| Cleanup complexity | Must delete transcoded files when torrent is removed |

**Mitigation already in place:**
- Transcoded files are tied to torrent lifecycle (deleted together)
- Storage is predictable (not unbounded cache growth)

**Possible future improvement:**
- Add configurable storage limit with LRU eviction of old sessions
- Option to delete original after seeding ratio is met

#### 3. No Seeking Beyond Transcoded Point
**Severity: Medium**

Users cannot skip ahead to unwatched content if it hasn't been transcoded yet.

| User Action | Experience |
|-------------|------------|
| Seek within transcoded | Instant |
| Seek beyond transcoded | "Waiting for transcode" overlay appears |
| Skip to end of movie | May wait several minutes |

**Why this is a weakpoint:**
- Users accustomed to Netflix-style instant seeking everywhere
- "Waiting for transcode" overlay interrupts flow
- Unpredictable wait times (depends on download + transcode speed)

**Mitigation already in place:**
- Overlay shows ETA based on transcode rate
- "Watch from available position" button for quick escape
- Auto-proceeds when transcode catches up

**Possible future improvement:**
- "Priority transcode" mode that jumps FFmpeg to requested position
- Accept some segment loss to reduce wait time

#### 4. Complexity of FFmpeg State Machine
**Severity: Low**

The IDLE→TRANSCODING→WAITING→RESUMING state machine adds implementation complexity:

| State Transition | Trigger | Complexity |
|------------------|---------|------------|
| IDLE → TRANSCODING | First segment request | Low |
| TRANSCODING → WAITING | Safety margin reached | Medium (timing) |
| WAITING → RESUMING | Download progress | Medium (coordination) |
| RESUMING → TRANSCODING | FFmpeg restarted | Medium (seek accuracy) |

**Why this is a weakpoint:**
- Each transition is a potential bug source
- Timing issues between download progress and FFmpeg
- Hard to test all state combinations

**Mitigation already in place:**
- Lock-based concurrency control (`acquireLock()`)
- Typed error classes with recovery strategies
- Wave 2 debugging features planned

#### 5. SSE Connection Management
**Severity: Low**

SSE connections require careful lifecycle management:

| Concern | Impact |
|---------|--------|
| Connection limits | Browsers limit concurrent SSE (typically 6 per domain) |
| Memory per connection | Server holds response object per client |
| Stale connections | Clients that close without disconnect event |
| Reconnection storms | Many clients reconnecting simultaneously after server restart |

**Mitigation already in place:**
- Single SSE connection per client (multiplexed)
- Heartbeat timeout to clean stale connections
- Auto-reconnect with 3s delay

#### 6. Limited Debugging in Wave 1
**Severity: Low**

Initial release uses simple console logging, deferring advanced debugging to Wave 2:

| Wave 1 (Initial) | Wave 2 (Future) |
|------------------|-----------------|
| Console logs with session prefix | Structured JSON logging |
| Manual log review | Debug endpoints |
| No replay capability | Event recording/replay |

**Why this is a weakpoint:**
- Harder to debug production issues initially
- Must wait for Wave 2 for advanced tooling

**Mitigation:**
- Contextual logging with session IDs is sufficient for most debugging
- Wave 2 planned before production scale

---

### Risk Assessment Matrix

| Risk | Likelihood | Impact | Mitigation Effectiveness |
|------|------------|--------|-------------------------|
| FFmpeg EOF errors | Medium | High | **Strong** - Safety margin + `+genpts` |
| Moov-at-end user frustration | Low | Medium | **Strong** - H.264 uses native fallback; only HEVC must wait |
| Disk space exhaustion | Low | Medium | **Strong** - Tied to torrent lifecycle |
| SSE connection issues | Low | Low | **Strong** - Auto-reconnect + heartbeat |
| State machine bugs | Medium | Medium | **Moderate** - Locks help, testing needed |
| Seeking frustration | Medium | Medium | **Moderate** - Overlay helps, not ideal |

---

### Overall Assessment

**Recommendation: Proceed with implementation**

| Category | Assessment |
|----------|------------|
| **Architecture** | Sound - binary mode model is clean and predictable |
| **User Experience** | Good - single progress bar, clear messaging |
| **Technical Robustness** | Good - FFmpeg mitigations are thorough |
| **Scalability** | Good - SSE reduces server load |
| **Maintainability** | Moderate - state machine adds complexity |

**Key strengths:**
1. Dramatically faster time-to-playback for MKV and moov-at-start MP4s
2. Permanent transcoded storage eliminates repeat transcoding
3. Simple binary streaming mode (no mode switching confusion)
4. Unified "available to play" progress bar

**Key weakpoints to monitor:**
1. HEVC moov-at-end MP4s still require full download (H.264 works via native fallback)
2. Seeking beyond transcoded content creates friction
3. 2x disk usage while torrents are active

**Success criteria for Phase 1:**
- MKV files stream within 10s of 2% download
- No FFmpeg EOF crashes in normal operation
- SSE connections remain stable for 30+ minute sessions
- Users understand "available to play" progress bar intuitively
