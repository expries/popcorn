import { spawn } from 'child_process';

import { ffmpegProcess } from '../../hls/ffmpegProcess';
import { probeFile } from '../../hls';
import { getHighestContiguousSegment, sessionRegistry } from '../../hls/sessionRegistry';
import { determineStreamingStrategy } from '../../hls/streamingStrategy';
import { torrentManager, type DownloadedRange } from '../../services/torrentManager';
import { jsonErrorResponse, jsonSuccessResponse } from './responses';
import { needsHls, getContainerFormat } from './utils';

async function getVideoDuration(filePath: string): Promise<number | null> {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);

    let stdout = '';
    const timeout = setTimeout(() => {
      proc.kill();
      resolve(null);
    }, 10000);

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.on('close', () => {
      clearTimeout(timeout);
      const duration = parseFloat(stdout.trim());
      resolve(isNaN(duration) ? null : duration);
    });

    proc.on('error', () => {
      clearTimeout(timeout);
      resolve(null);
    });
  });
}

export async function handleStatsRequest(infoHash: string, baseUrl: string): Promise<Response> {
  const stats = await torrentManager.getTorrentStats(infoHash);

  if (!stats) {
    return jsonErrorResponse('Torrent not found', 404);
  }

  const videoInfo = await torrentManager.getVideoFileInfo(infoHash);
  const duration = videoInfo ? await getVideoDuration(videoInfo.path) : null;

  // Probe codec info to determine if transcoding is needed
  let codecInfo = null;
  if (videoInfo) {
    try {
      codecInfo = await probeFile(videoInfo.path);
    } catch {
      // Ignore probe errors for stats
    }
  }

  // Use codec-aware HLS detection (handles H.265 in MP4 containers)
  const requiresHls = videoInfo ? needsHls(videoInfo.name, codecInfo) : false;

  // Determine streaming strategy and create/update session
  let waitingForDownload = false;
  let canSeekTo: number | undefined;
  let transcodeProgress: number | undefined;
  let isTranscoding = false;

  // If HLS is required but we couldn't probe codec info, we're waiting for more data
  if (requiresHls && !codecInfo) {
    waitingForDownload = true;
    canSeekTo = 0;
    console.log(`[Stats] HLS required but codec probe failed - waiting for more download data`);
  } else if (requiresHls && codecInfo && videoInfo) {
    try {
      // Always create/get session - this ensures consistent state
      // The session tracks the authoritative waitingForDownload state
      const session = await sessionRegistry.getOrCreateSession(infoHash, stats.progress);
      waitingForDownload = session.waitingForDownload;
      isTranscoding = session.isGenerating;

      // Calculate canSeekTo from contiguous segments (not max segment index)
      const contiguousSegments = getHighestContiguousSegment(session.generatedSegments);
      canSeekTo = (contiguousSegments + 1) * session.segmentDuration;
      transcodeProgress = session.totalDuration > 0
        ? canSeekTo / session.totalDuration
        : 0;

      // Start transcoding if ready and not already running
      if (!waitingForDownload && !session.isGenerating && contiguousSegments < session.totalSegments - 1) {
        console.log(`[Stats] Proactively starting transcoding for ${infoHash}`);
        ffmpegProcess.ensureTranscodingStarted(session, stats.progress).catch((err) => {
          console.error(`[Stats] Failed to start proactive transcoding:`, err);
        });
      }
    } catch (err) {
      // If session creation fails (e.g., FFprobe failed), wait for more data
      console.error(`[Stats] Failed to create session:`, err);
      waitingForDownload = true;
      canSeekTo = 0;
    }
  } else {
    // Native streaming - canSeekTo is based on download progress
    canSeekTo = duration ? duration * stats.progress : undefined;
  }

  // Get piece-level download progress for video file
  let downloadedRanges: DownloadedRange[] | null = null;
  if (!stats.isFinished) {
    const pieceProgress = await torrentManager.getVideoPieceProgress(infoHash);
    downloadedRanges = pieceProgress?.downloadedRanges ?? null;
  }

  return jsonSuccessResponse({
    ...stats,
    fileName: videoInfo?.name,
    fileSize: videoInfo?.size,
    duration,
    requiresHls,
    waitingForDownload,
    hlsUrl: requiresHls ? `${baseUrl}/hls/${infoHash}/master.m3u8` : null,
    codecInfo,
    downloadedRanges,
    // Include canSeekTo in stats response so frontend has a fallback when SSE disconnects
    canSeekTo,
    transcodeProgress,
    isTranscoding,
  });
}
