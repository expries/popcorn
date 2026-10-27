import { probeFile } from '../../hls/codecProbe';
import { ffmpegProcess } from '../../hls/ffmpegProcess';
import { calculateCanSeekTo, getHighestContiguousSegment, sessionRegistry } from '../../hls/sessionRegistry';
import { torrentManager } from '../../services/torrentManager';
import { createLogger } from '../../utils/logger';

const log = createLogger('SSE');

// Cache probed durations to avoid re-probing on every SSE connection
const durationCache = new Map<string, number>();

export interface ProgressUpdate {
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

/**
 * Get video duration, using cache or probing if needed.
 */
async function getVideoDuration(infoHash: string): Promise<number | undefined> {
  // Check cache first
  const cached = durationCache.get(infoHash);
  if (cached !== undefined) {
    return cached;
  }

  // Try to probe the video file
  try {
    const videoInfo = await torrentManager.getVideoFileInfo(infoHash);
    if (videoInfo) {
      const codecInfo = await probeFile(videoInfo.path);
      if (codecInfo.duration > 0) {
        durationCache.set(infoHash, codecInfo.duration);
        return codecInfo.duration;
      }
    }
  } catch (err) {
    log.debug(`Failed to probe duration for ${infoHash}:`, err);
  }

  return undefined;
}

/**
 * Handle SSE progress endpoint for real-time streaming updates.
 * Returns a streaming response that sends progress updates every second.
 */
export async function handleProgressSSE(infoHash: string): Promise<Response> {
  let intervalId: ReturnType<typeof setInterval> | null = null;

  // Track duration - may be fetched lazily if not available at start
  let videoDuration: number | undefined = durationCache.get(infoHash);

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      const sendEvent = (event: string, data: unknown) => {
        const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(message));
      };

      // Send connected event
      sendEvent('connected', { infoHash });

      const sendUpdate = async () => {
        try {
          const torrentStats = await torrentManager.getTorrentStats(infoHash);
          // Use getOrCreateSession to update waiting state based on download progress
          let session = sessionRegistry.getSessionByInfoHash(infoHash);

          if (!torrentStats) {
            sendEvent('error', { error: 'Torrent not found' });
            return;
          }

          // Lazily fetch duration for native streaming if not yet cached
          if (videoDuration === undefined) {
            videoDuration = await getVideoDuration(infoHash);
          }

          // If session exists and was waiting, re-evaluate with current download progress
          // This will update waitingForDownload when download threshold is reached
          if (session?.waitingForDownload) {
            try {
              session = await sessionRegistry.getOrCreateSession(infoHash, torrentStats.progress);

              // If we're no longer waiting, start transcoding
              if (!session.waitingForDownload && !session.isGenerating) {
                log.info(`Download threshold reached, starting transcoding for ${infoHash}`);
                ffmpegProcess.ensureTranscodingStarted(session, torrentStats.progress).catch((err) => {
                  log.error(`Failed to start transcoding:`, err);
                });
              }
            } catch {
              // Ignore errors, continue with existing session state
            }
          }

          // Calculate transcoded duration from highest CONTIGUOUS segment from 0
          // This ensures we report actually playable content, not just max segment index
          const highestContiguous = session ? getHighestContiguousSegment(session.generatedSegments) : -1;
          const transcodedSegmentCount = highestContiguous + 1;
          const transcodedDuration = session
            ? transcodedSegmentCount * session.segmentDuration
            : 0;

          // Debug: log segment tracking state
          if (session && session.isGenerating) {
            log.info(`[${infoHash}] SSE: contiguous=${highestContiguous}, setSize=${session.generatedSegments.size}, canSeekTo=${transcodedDuration}s`);
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
            canSeekTo: calculateCanSeekTo(session, torrentStats.progress, videoDuration),
            isDownloading: torrentStats.progress < 1.0,
            isTranscoding: session?.isGenerating ?? false,
          };

          // Add transcode-specific info if in HLS mode and not waiting
          if (session?.streamingMode === 'hls' && !session.waitingForDownload) {
            update.transcodeProgress = session.totalDuration > 0
              ? transcodedDuration / session.totalDuration
              : 0;
            update.transcodedDuration = transcodedDuration;
            update.transcodedSegments = transcodedSegmentCount;
            update.totalSegments = session.totalSegments;
          }

          sendEvent('progress', update);
        } catch (error) {
          sendEvent('error', { error: String(error) });
        }
      };

      // Send initial update immediately
      sendUpdate();

      // Send updates every second
      intervalId = setInterval(sendUpdate, 1000);
    },

    cancel() {
      // Clean up interval when client disconnects
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
      log.debug(`Client disconnected from progress stream for ${infoHash}`);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
