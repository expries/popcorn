# HLS Streaming While Downloading - Implementation Specification

## Overview

Implement concurrent download and transcoding for the Popcorn streaming application. Users should be able to watch video content while it's still being downloaded via BitTorrent.

**Core Principle:** Binary streaming mode (`'native' | 'hls'`) determined once at session start. No mode switching during playback.

---

## Decision Flow

```
Is the video codec browser-compatible (H.264 + AAC)?
├── YES → Native streaming (no transcoding needed)
│         Works immediately, even for moov-at-end MP4s
└── NO  → HLS transcoding required
         ├── Container allows progressive reading (MKV, MP4-moov-start)?
         │   └── YES → Progressive HLS transcoding while downloading
         └── Container requires full file (MP4-moov-end, AVI)?
             └── YES → Wait for download, then HLS transcode
```

| Scenario                         | Streaming Mode                     | Behavior                                      |
| -------------------------------- | ---------------------------------- | --------------------------------------------- |
| H.264 + AAC (any container)      | `native`                           | Direct playback, no transcoding               |
| H.264 + AAC in MP4 (moov at end) | `native`                           | Direct playback (browser handles moov-at-end) |
| Non-H.264 in MKV                 | `hls`                              | Progressive transcoding while downloading     |
| Non-H.264 in MP4 (moov at start) | `hls`                              | Progressive transcoding while downloading     |
| Non-H.264 in MP4 (moov at end)   | `hls` + `waitingForDownload: true` | Must wait for download, then transcode        |
| Non-H.264 in AVI                 | `hls` + `waitingForDownload: true` | Must wait for download, then transcode        |

---

## Phase 1: SSE Progress Endpoint

### Backend: New SSE Endpoint

**File:** `backend/src/routes/stream/progressSSE.ts`

```typescript
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
  waitingForDownload?: boolean;
  canSeekTo: number; // Max seekable position in seconds

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
  res.setHeader('X-Accel-Buffering', 'no');

  res.write(`event: connected\ndata: ${JSON.stringify({ infoHash })}\n\n`);

  const sendUpdate = async () => {
    try {
      const torrentStats = await torrentManager.getTorrentStats(infoHash);
      const session = sessionRegistry.getSessionByInfoHash(infoHash);

      if (!torrentStats) {
        res.write(`event: error\ndata: ${JSON.stringify({ error: 'Torrent not found' })}\n\n`);
        return;
      }

      const update: ProgressUpdate = {
        downloadProgress: torrentStats.progress,
        downloadedBytes: torrentStats.downloaded,
        totalBytes: torrentStats.totalSize,
        downloadSpeed: torrentStats.downloadSpeed,
        uploadSpeed: torrentStats.uploadSpeed,
        numPeers: torrentStats.numPeers,
        streamingMode: session?.streamingMode ?? 'native',
        waitingForDownload: session?.waitingForDownload,
        canSeekTo: session?.transcodedDuration ?? torrentStats.duration ?? 0,
        isDownloading: torrentStats.progress < 1.0,
        isTranscoding: session?.isGenerating ?? false,
      };

      if (session?.streamingMode === 'hls' && !session.waitingForDownload) {
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

  const interval = setInterval(sendUpdate, 1000);
  sendUpdate();

  req.on('close', () => {
    clearInterval(interval);
  });
});

export default router;
```

### Frontend: SSE Hook

**File:** `app/src/hooks/useProgressSSE.ts`

```typescript
import { useState, useEffect, useCallback, useRef } from 'react';

const STREAM_SERVER_URL = 'http://localhost:3002';

export interface ProgressData {
  downloadProgress: number;
  downloadedBytes: number;
  totalBytes: number;
  downloadSpeed: number;
  uploadSpeed: number;
  numPeers: number;
  transcodeProgress?: number;
  transcodedDuration?: number;
  transcodedSegments?: number;
  totalSegments?: number;
  streamingMode: 'hls' | 'native';
  waitingForDownload?: boolean;
  canSeekTo: number;
  isTranscoding: boolean;
  isDownloading: boolean;
}

export function useProgressSSE(infoHash: string | null, enabled = true) {
  const [progress, setProgress] = useState<ProgressData | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const connect = useCallback(() => {
    if (!infoHash || !enabled) return;

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
        setProgress(JSON.parse(event.data));
      } catch (e) {
        console.error('Failed to parse progress data:', e);
      }
    });

    eventSource.addEventListener('error', () => {
      setIsConnected(false);
      setConnectionError('Connection lost');
      reconnectTimeoutRef.current = setTimeout(connect, 3000);
    });
  }, [infoHash, enabled]);

  useEffect(() => {
    connect();
    return () => {
      eventSourceRef.current?.close();
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
    };
  }, [connect]);

  return { progress, isConnected, connectionError, reconnect: connect };
}
```

### Frontend: Modify useTorrentStats

**File:** `app/src/hooks/useTorrentStats.ts` (modify existing)

Replace polling with hybrid SSE + initial fetch:

```typescript
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useProgressSSE } from './useProgressSSE';

export function useTorrentStats(infoHash: string | null) {
  // One-time fetch for static data (codec info, file name, etc.)
  const staticQuery = useQuery({
    queryKey: ['torrentStatsStatic', infoHash],
    queryFn: () => fetchTorrentStats(infoHash!),
    enabled: !!infoHash,
    staleTime: Infinity,
    refetchInterval: false,
  });

  // Real-time updates via SSE
  const { progress: realtimeProgress, isConnected } = useProgressSSE(infoHash);

  const mergedStats = useMemo(() => {
    if (!staticQuery.data) return null;
    if (!realtimeProgress) return staticQuery.data;

    return {
      ...staticQuery.data,
      progress: realtimeProgress.downloadProgress,
      downloadSpeed: realtimeProgress.downloadSpeed,
      uploadSpeed: realtimeProgress.uploadSpeed,
      numPeers: realtimeProgress.numPeers,
      transcodeProgress: realtimeProgress.transcodeProgress,
      transcodedDuration: realtimeProgress.transcodedDuration,
      canSeekTo: realtimeProgress.canSeekTo,
      streamingMode: realtimeProgress.streamingMode,
      waitingForDownload: realtimeProgress.waitingForDownload,
      isTranscoding: realtimeProgress.isTranscoding,
    };
  }, [staticQuery.data, realtimeProgress]);

  return { data: mergedStats, isLoading: staticQuery.isLoading, isConnected };
}
```

---

## Phase 2: Streaming Mode Determination

### Backend: Streaming Strategy

**File:** `backend/src/hls/streamingStrategy.ts` (new file)

```typescript
import type { CodecInfo } from './types';

export type StreamingMode = 'native' | 'hls';

export interface StreamingDecision {
  mode: StreamingMode;
  reason: string;
  canTranscodeNow: boolean;
  waitingForDownload?: boolean;
  useIncompleteFileFlags: boolean;
  minimumDownloadPercent: number;
}

const HLS_COMPATIBLE_VIDEO = new Set(['h264']);
const HLS_COMPATIBLE_AUDIO = new Set(['aac', 'mp3']);

export function isCodecCompatible(codecInfo: CodecInfo): boolean {
  const videoOk = codecInfo.videoCodec !== null && HLS_COMPATIBLE_VIDEO.has(codecInfo.videoCodec);
  const audioOk = codecInfo.audioCodec !== null && HLS_COMPATIBLE_AUDIO.has(codecInfo.audioCodec);
  return videoOk && audioOk;
}

export function determineStreamingStrategy(
  codecInfo: CodecInfo,
  containerFormat: string,
  downloadProgress: number,
): StreamingDecision {
  // If codec is browser-compatible, use native streaming
  if (isCodecCompatible(codecInfo)) {
    return {
      mode: 'native',
      reason: 'Codec is browser-compatible (H.264 + AAC)',
      canTranscodeNow: false, // No transcoding needed
      useIncompleteFileFlags: false,
      minimumDownloadPercent: 0,
    };
  }

  // Needs HLS transcoding - check container format

  // Tier 1: MKV - best for progressive transcoding
  if (containerFormat === 'matroska' || containerFormat === 'webm') {
    return {
      mode: 'hls',
      reason: 'MKV supports progressive reading',
      canTranscodeNow: downloadProgress >= 0.02,
      useIncompleteFileFlags: true,
      minimumDownloadPercent: 2,
    };
  }

  // Tier 2: MP4 with moov at start
  if ((containerFormat === 'mov' || containerFormat === 'mp4') && codecInfo.moovAtStart === true) {
    return {
      mode: 'hls',
      reason: 'MP4 with moov at start - can read progressively',
      canTranscodeNow: downloadProgress >= 0.05,
      useIncompleteFileFlags: true,
      minimumDownloadPercent: 5,
    };
  }

  // Tier 3: MP4 with moov at end, AVI, or unknown - must wait
  return {
    mode: 'hls',
    reason: 'Container requires full download for metadata access',
    canTranscodeNow: downloadProgress >= 1.0,
    waitingForDownload: downloadProgress < 1.0,
    useIncompleteFileFlags: false,
    minimumDownloadPercent: 100,
  };
}
```

### Backend: Modify Session Registry

**File:** `backend/src/hls/sessionRegistry.ts` (modify existing)

Add streaming mode and waiting state to session:

```typescript
import { determineStreamingStrategy, StreamingDecision } from './streamingStrategy';

export interface HlsSession {
  // Existing fields...
  sessionKey: SessionKey;
  infoHash: string;
  filePath: string;
  codecInfo: CodecInfo;
  decision: TranscodeDecision;
  totalSegments: number;
  segmentDuration: number;
  generatedSegments: Set<number>;
  ffmpegStartSegment: number;
  highestGeneratedSegment: number;
  isGenerating: boolean;
  createdAt: Date;
  lastAccessedAt: Date;

  // NEW fields for progressive transcoding
  streamingMode: 'hls' | 'native';
  waitingForDownload: boolean;
  transcodedDuration: number;
  totalDuration: number;
  containerFormat: string;
}

// In getOrCreateSession, add:
async getOrCreateSession(infoHash: string, downloadProgress: number): Promise<HlsSession> {
  const fileInfo = await torrentManager.getVideoFileInfo(infoHash);
  if (!fileInfo) throw new Error('Video file not found');

  const codecInfo = probeFile(fileInfo.path);
  const strategy = determineStreamingStrategy(codecInfo, fileInfo.format, downloadProgress);

  // If native mode, don't create HLS session
  if (strategy.mode === 'native') {
    return null;  // Or handle differently based on your architecture
  }

  const decision = makeTranscodeDecision(codecInfo);
  const sessionKey = buildSessionKey(infoHash, decision.mode);

  const existing = this.sessions.get(sessionKey);
  if (existing) {
    // Update waiting state if download completed
    if (existing.waitingForDownload && downloadProgress >= 1.0) {
      existing.waitingForDownload = false;
    }
    return existing;
  }

  const totalSegments = Math.ceil(codecInfo.duration / this.segmentDuration);

  const session: HlsSession = {
    sessionKey,
    infoHash,
    filePath: fileInfo.path,
    codecInfo,
    decision,
    createdAt: new Date(),
    lastAccessedAt: new Date(),
    segmentDuration: this.segmentDuration,
    totalSegments,
    generatedSegments: new Set(),
    ffmpegStartSegment: 0,
    highestGeneratedSegment: -1,
    isGenerating: false,
    // NEW
    streamingMode: strategy.mode,
    waitingForDownload: strategy.waitingForDownload ?? false,
    transcodedDuration: 0,
    totalDuration: codecInfo.duration,
    containerFormat: fileInfo.format,
  };

  this.sessions.set(sessionKey, session);
  return session;
}
```

---

## Phase 3: Safety Margin Transcoding

### Backend: FFmpeg Process Modifications

**File:** `backend/src/hls/ffmpegProcess.ts` (modify existing)

Add incomplete file flags and safety margin:

```typescript
// Add these constants at top
const INCOMPLETE_FILE_FLAGS = [
  '-fflags', '+genpts',
  '-analyzeduration', '5000000',
  '-probesize', '32768',
  '-thread_queue_size', '512',
];

const SAFETY_MARGIN_SEGMENTS = 2;

// Modify buildArgs to accept isIncompleteFile flag
private buildArgs(
  session: HlsSession,
  startTime: number,
  outputDir: string,
  options: { isIncompleteFile: boolean; maxDuration?: number }
): string[] {
  const hasAudio = !!session.codecInfo.audioCodec;
  const isTranscoding = session.decision.videoAction === 'transcode';

  const args: string[] = [];

  // NEW: Add incomplete file flags before input
  if (options.isIncompleteFile) {
    args.push(...INCOMPLETE_FILE_FLAGS);
  }

  if (startTime > 0) {
    args.push('-ss', String(startTime));
  }

  args.push('-i', session.filePath);

  // NEW: Limit duration if transcoding incomplete file
  if (options.maxDuration !== undefined && options.maxDuration > startTime) {
    args.push('-t', String(options.maxDuration - startTime));
  }

  // ... rest of existing encoding args
  args.push('-map', '0:v:0');
  if (hasAudio) args.push('-map', '0:a:0');
  args.push('-sn', '-dn');

  if (session.decision.videoAction === 'copy') {
    args.push('-c:v', 'copy');
  } else {
    args.push(
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '23',
      '-profile:v', 'main',
      '-level:v', '4.0',
      '-pix_fmt', 'yuv420p',
    );
  }

  if (session.decision.audioAction === 'copy') {
    args.push('-c:a', 'copy');
  } else {
    args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2');
  }

  if (isTranscoding) {
    args.push('-force_key_frames', `expr:gte(t,n_forced*${this.segmentDuration})`);
  }

  args.push(
    '-f', 'hls',
    '-hls_time', String(this.segmentDuration),
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', join(outputDir, 'segment_%d.ts'),
    '-hls_list_size', '0',
    '-hls_flags', 'temp_file',
    join(outputDir, 'ffmpeg_playlist.m3u8'),
  );

  return args;
}

// NEW: Calculate safe segment limit based on download progress
calculateSafeSegmentLimit(
  downloadedBytes: number,
  totalBytes: number,
  totalSegments: number
): number {
  const downloadFraction = downloadedBytes / totalBytes;
  const downloadedSegments = Math.floor(downloadFraction * totalSegments);
  return Math.max(0, downloadedSegments - SAFETY_MARGIN_SEGMENTS);
}
```

### Backend: Download Tracker

**File:** `backend/src/hls/downloadTracker.ts` (new file)

```typescript
import { torrentManager } from '../services/torrentManager';

export interface DownloadProgress {
  downloadedBytes: number;
  contiguousBytes: number;
  totalBytes: number;
  progress: number;
}

export async function getDownloadProgress(infoHash: string): Promise<DownloadProgress | null> {
  const stats = await torrentManager.getTorrentStats(infoHash);
  if (!stats) return null;

  // For sequential downloads, downloaded bytes are contiguous
  // If you implement piece-level tracking, use that instead
  return {
    downloadedBytes: stats.downloaded,
    contiguousBytes: stats.downloaded, // Assumes sequential download
    totalBytes: stats.totalSize,
    progress: stats.progress,
  };
}
```

---

## Phase 4: Permanent Segment Storage

### Backend: Segment Store

**File:** `backend/src/hls/segmentStore.ts` (new file or modify segmentCache.ts)

```typescript
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';

export class PermanentSegmentStore {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  getSessionDir(sessionKey: string): string {
    return join(this.baseDir, 'transcoded', sessionKey);
  }

  getSegmentPath(sessionKey: string, segmentIndex: number): string {
    return join(this.getSessionDir(sessionKey), `segment_${segmentIndex}.ts`);
  }

  segmentExists(sessionKey: string, segmentIndex: number): boolean {
    return existsSync(this.getSegmentPath(sessionKey, segmentIndex));
  }

  getSegment(sessionKey: string, segmentIndex: number): Buffer | null {
    const path = this.getSegmentPath(sessionKey, segmentIndex);
    if (existsSync(path)) {
      return readFileSync(path);
    }
    return null;
  }

  storeSegment(sessionKey: string, segmentIndex: number, data: Buffer): void {
    const path = this.getSegmentPath(sessionKey, segmentIndex);
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(path, data);
  }

  isTranscodeComplete(sessionKey: string, totalSegments: number): boolean {
    for (let i = 0; i < totalSegments; i++) {
      if (!this.segmentExists(sessionKey, i)) {
        return false;
      }
    }
    return true;
  }

  deleteSession(sessionKey: string): void {
    const dir = this.getSessionDir(sessionKey);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

export const segmentStore = new PermanentSegmentStore('/path/to/storage');
```

---

## Phase 5: Frontend - Transcode-Aware Seeking

### Frontend: Seek Hook

**File:** `app/src/hooks/useTranscodeAwareSeek.ts` (new file)

```typescript
import { useState, useCallback, useEffect } from 'react';

interface UseTranscodeAwareSeekOptions {
  canSeekTo: number;
  totalDuration: number;
  onSeekBlocked: (targetTime: number) => void;
  onSeekAllowed: (targetTime: number) => void;
}

export function useTranscodeAwareSeek({
  canSeekTo,
  totalDuration,
  onSeekBlocked,
  onSeekAllowed,
}: UseTranscodeAwareSeekOptions) {
  const [pendingSeek, setPendingSeek] = useState<number | null>(null);
  const [isWaitingForTranscode, setIsWaitingForTranscode] = useState(false);

  const requestSeek = useCallback(
    (targetTime: number) => {
      if (targetTime <= canSeekTo) {
        setPendingSeek(null);
        setIsWaitingForTranscode(false);
        onSeekAllowed(targetTime);
      } else {
        setPendingSeek(targetTime);
        setIsWaitingForTranscode(true);
        onSeekBlocked(targetTime);
      }
    },
    [canSeekTo, onSeekAllowed, onSeekBlocked],
  );

  // Auto-proceed when transcode catches up
  useEffect(() => {
    if (pendingSeek !== null && canSeekTo >= pendingSeek) {
      setIsWaitingForTranscode(false);
      onSeekAllowed(pendingSeek);
      setPendingSeek(null);
    }
  }, [canSeekTo, pendingSeek, onSeekAllowed]);

  const cancelPendingSeek = useCallback(() => {
    setPendingSeek(null);
    setIsWaitingForTranscode(false);
  }, []);

  const seekToAvailable = useCallback(() => {
    cancelPendingSeek();
    onSeekAllowed(Math.max(0, canSeekTo - 2));
  }, [canSeekTo, cancelPendingSeek, onSeekAllowed]);

  return {
    requestSeek,
    cancelPendingSeek,
    seekToAvailable,
    isWaitingForTranscode,
    pendingSeekTarget: pendingSeek,
    transcodeProgress: totalDuration > 0 ? canSeekTo / totalDuration : 0,
  };
}
```

### Frontend: Wait Overlay Component

**File:** `app/src/components/TranscodeWaitOverlay.tsx` (new file)

```tsx
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
    <div className="absolute inset-0 flex items-center justify-center bg-black/50 z-20" onClick={onCancel}>
      <div
        className="flex flex-col items-center gap-4 text-white p-6 rounded-xl bg-black/70"
        onClick={(e) => e.stopPropagation()}
      >
        <svg className="w-12 h-12 animate-spin" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
          />
        </svg>

        <div className="text-center">
          <p className="text-sm font-medium">Waiting for transcode...</p>
          <p className="text-xs text-gray-400 mt-1">Seeking to {formatTime(pendingSeekTarget ?? 0)}</p>
          <p className="text-xs text-gray-400">
            Available up to {formatTime(canSeekTo)} ({(transcodeProgress * 100).toFixed(0)}%)
          </p>
        </div>

        <div className="w-48 h-2 bg-gray-700 rounded-full overflow-hidden">
          <div
            className="h-full bg-primary transition-all duration-300"
            style={{ width: `${transcodeProgress * 100}%` }}
          />
        </div>

        <div className="flex gap-3 mt-2">
          <button
            onClick={onSeekBack}
            className="px-4 py-2 bg-primary hover:bg-primary/80 rounded-lg text-sm transition-colors cursor-pointer"
          >
            Watch from {formatTime(canSeekTo)}
          </button>
          <button
            onClick={onCancel}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm transition-colors cursor-pointer"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
```

### Frontend: Progress Bar Modification

**File:** `app/src/components/VideoControls.tsx` (modify existing)

Replace multiple progress indicators with single "available to play":

```tsx
interface VideoControlsProps {
  // ... existing props
  availableFraction: number; // 0-1, replaces downloadedRanges
}

// In the seek bar section:
<div className="h-2 bg-muted/50 rounded-full cursor-pointer relative group" onClick={onSeekBarClick}>
  {/* Single "available to play" indicator */}
  <div
    className="absolute h-full bg-muted-foreground/40 rounded-full"
    style={{ width: `${availableFraction * 100}%` }}
  />

  {/* Current playback position */}
  <div className="absolute h-full bg-primary rounded-full transition-all z-10" style={{ width: `${progress}%` }} />
</div>;
```

Compute `availableFraction` in VideoPlayer:

```typescript
function getAvailableFraction(stats: TorrentStats): number {
  if (stats.streamingMode === 'hls') {
    if (stats.waitingForDownload) return 0;
    return (stats.transcodedDuration ?? 0) / (stats.duration ?? 1);
  }
  return stats.progress;
}
```

---

## Phase 6: VideoPlayer Integration

### Frontend: VideoPlayer Modifications

**File:** `app/src/components/VideoPlayer.tsx` (modify existing)

Add transcode-aware seeking and overlay:

```tsx
import { useTranscodeAwareSeek } from '../hooks/useTranscodeAwareSeek';
import { TranscodeWaitOverlay } from './TranscodeWaitOverlay';

export function VideoPlayer({ stats, status }: VideoPlayerProps) {
  // ... existing state and refs

  const requiresHls = stats.streamingMode === 'hls';
  const isWaitingForDownload = stats.waitingForDownload ?? false;

  const {
    requestSeek,
    cancelPendingSeek,
    seekToAvailable,
    isWaitingForTranscode,
    pendingSeekTarget,
    transcodeProgress,
  } = useTranscodeAwareSeek({
    canSeekTo: stats.canSeekTo ?? stats.duration ?? 0,
    totalDuration: stats.duration ?? 0,
    onSeekBlocked: () => videoElement?.pause(),
    onSeekAllowed: (target) => {
      if (videoElement) {
        videoElement.currentTime = target;
        videoElement.play().catch(console.error);
      }
    },
  });

  const handleSeekBarClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const fraction = (e.clientX - rect.left) / rect.width;
    const targetTime = fraction * (stats.duration ?? 0);

    if (requiresHls && !isWaitingForDownload) {
      requestSeek(targetTime);
    } else {
      // Native mode - seek directly
      if (videoElement) videoElement.currentTime = targetTime;
    }
  };

  const availableFraction = getAvailableFraction(stats);

  return (
    <div className="flex flex-col gap-4">
      {/* Show waiting message if HLS mode but waiting for download */}
      {requiresHls && isWaitingForDownload ? (
        <div className="aspect-video bg-muted flex items-center justify-center rounded-xl">
          <div className="text-center">
            <p className="text-lg font-medium">Waiting for download to complete</p>
            <p className="text-sm text-muted-foreground mt-2">
              This video requires transcoding and will be available after download completes.
            </p>
            <p className="text-sm text-muted-foreground mt-1">
              Download progress: {(stats.progress * 100).toFixed(1)}%
            </p>
          </div>
        </div>
      ) : canStream ? (
        <div ref={containerRef} className="relative aspect-video bg-black rounded-xl overflow-hidden">
          <video ref={videoRef} ... />

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
            onSeekBack={seekToAvailable}
            onCancel={cancelPendingSeek}
          />

          {/* Video controls */}
          {requiresHls && hasStarted && (
            <VideoControls
              ...
              availableFraction={availableFraction}
              onSeekBarClick={handleSeekBarClick}
            />
          )}
        </div>
      ) : (
        <WaitingOverlay ... />
      )}

      {/* Stream Info Panel - add streaming mode display */}
      {stats.codecInfo && (
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
      )}
    </div>
  );
}
```

---

## Key Files Summary

### New Files to Create

| File                                          | Purpose                             |
| --------------------------------------------- | ----------------------------------- |
| `backend/src/routes/stream/progressSSE.ts`    | SSE endpoint for real-time progress |
| `backend/src/hls/streamingStrategy.ts`        | Streaming mode determination logic  |
| `backend/src/hls/downloadTracker.ts`          | Download progress monitoring        |
| `backend/src/hls/segmentStore.ts`             | Permanent segment storage           |
| `app/src/hooks/useProgressSSE.ts`             | Frontend SSE hook                   |
| `app/src/hooks/useTranscodeAwareSeek.ts`      | Transcode-aware seeking             |
| `app/src/components/TranscodeWaitOverlay.tsx` | Wait overlay UI                     |

### Files to Modify

| File                                   | Changes                                  |
| -------------------------------------- | ---------------------------------------- |
| `backend/src/hls/ffmpegProcess.ts`     | Add incomplete file flags, safety margin |
| `backend/src/hls/sessionRegistry.ts`   | Add streaming mode, waiting state        |
| `backend/src/hls/types.ts`             | Add new session fields                   |
| `app/src/hooks/useTorrentStats.ts`     | Replace polling with SSE                 |
| `app/src/components/VideoPlayer.tsx`   | Add transcode overlay, seek handling     |
| `app/src/components/VideoControls.tsx` | Single "available" progress bar          |

---

## Testing Checklist

- [ ] MKV file streams within 10s of 2% download
- [ ] MP4 moov-at-start streams within 15s of 5% download
- [ ] MP4 moov-at-end with H.264 uses native streaming immediately
- [ ] MP4 moov-at-end with HEVC shows "waiting for download" message
- [ ] Seeking within transcoded range is instant
- [ ] Seeking beyond transcoded shows overlay with ETA
- [ ] "Watch from available" button works
- [ ] SSE connection auto-reconnects after disconnect
- [ ] Progress bar shows single "available to play" indicator
- [ ] Transcoded segments persist after FFmpeg restart
- [ ] Repeat playback uses stored segments (no re-transcoding)
