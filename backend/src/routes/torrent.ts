import { z } from 'zod';

import { ffmpegProcess } from '../hls/ffmpegProcess';
import { segmentCache } from '../hls/segmentCache';
import { sessionRegistry } from '../hls/sessionRegistry';
import { transcodeJobManager } from '../services/transcodeJobManager';
import { torrentManager, type TorrentStats } from '../services/torrentManager';
import { t } from '../trpc';

// Add a torrent via magnet URI
export const addTorrent = t.procedure
  .input(
    z.object({
      magnetUri: z.string(),
    }),
  )
  .mutation(async (req) => {
    const { magnetUri } = req.input;

    console.log('[Torrent] Adding torrent:', magnetUri.slice(0, 60) + '...');

    try {
      const stats = await torrentManager.addTorrent(magnetUri);
      return {
        success: true,
        data: stats,
      };
    } catch (error) {
      console.error('[Torrent] Failed to add torrent:', error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        error: message,
      };
    }
  });

// Get stats for a specific torrent
export const getTorrentStats = t.procedure
  .input(
    z.object({
      infoHash: z.string(),
    }),
  )
  .query(async (req) => {
    const { infoHash } = req.input;
    const stats = await torrentManager.getTorrentStats(infoHash);

    if (!stats) {
      return {
        success: false,
        error: 'Torrent not found',
      };
    }

    return {
      success: true,
      data: stats,
    };
  });

// Get stats for all torrents
export const getAllTorrents = t.procedure.query(async () => {
  const stats = await torrentManager.getAllStats();
  return {
    success: true,
    data: stats,
  };
});

export interface DownloadWithProgress extends TorrentStats {
  transcodeProgress: number | null;
  transcodeStatus: 'none' | 'pending' | 'in_progress' | 'completed' | 'failed';
  needsTranscoding: boolean;
  transcodedSegments: number | null;
  totalSegments: number | null;
}

// Get all downloads (including completed) with transcode progress
export const getAllDownloads = t.procedure.query(async () => {
  const allStats = await torrentManager.getAllStats();

  // Get transcode jobs for all torrents
  const infoHashes = allStats.map((s) => s.infoHash);
  const transcodeJobs = await transcodeJobManager.getJobsByInfoHashes(infoHashes);

  // Enrich torrent stats with transcode progress
  const enrichedStats: DownloadWithProgress[] = allStats.map((stats) => {
    const job = transcodeJobs.get(stats.infoHash);
    const session = sessionRegistry.getSessionByInfoHash(stats.infoHash);

    // Determine if transcoding is needed
    // A torrent needs transcoding if it has a job with non-copy mode OR has an HLS session
    const needsTranscoding = job
      ? job.transcodeMode !== 'copy'
      : session?.decision.mode !== 'copy' && session?.streamingMode === 'hls';

    // Calculate transcode progress
    let transcodeProgress: number | null = null;
    let transcodedSegments: number | null = null;
    let totalSegments: number | null = null;

    if (job && needsTranscoding) {
      // Use session if available (more up-to-date), otherwise use DB
      const highestSegment = session?.highestGeneratedSegment ?? job.highestGeneratedSegment;
      totalSegments = job.totalSegments;
      transcodedSegments = highestSegment + 1;
      transcodeProgress = totalSegments > 0 ? transcodedSegments / totalSegments : 0;
    } else if (session && needsTranscoding) {
      totalSegments = session.totalSegments;
      transcodedSegments = session.highestGeneratedSegment + 1;
      transcodeProgress = totalSegments > 0 ? transcodedSegments / totalSegments : 0;
    }

    // Determine transcode status
    let transcodeStatus: DownloadWithProgress['transcodeStatus'] = 'none';
    if (needsTranscoding) {
      if (job) {
        transcodeStatus = job.status as DownloadWithProgress['transcodeStatus'];
      } else if (session) {
        transcodeStatus = session.isGenerating ? 'in_progress' : 'pending';
      }
    }

    return {
      ...stats,
      transcodeProgress,
      transcodeStatus,
      needsTranscoding: needsTranscoding ?? false,
      transcodedSegments,
      totalSegments,
    };
  });

  const active = enrichedStats.filter((s) => !s.isFinished);
  const completed = enrichedStats.filter((s) => s.isFinished);

  return {
    success: true,
    data: {
      active,
      completed,
    },
  };
});

// Stop a torrent
export const stopTorrent = t.procedure
  .input(
    z.object({
      infoHash: z.string(),
    }),
  )
  .mutation(async (req) => {
    const { infoHash } = req.input;
    const stopped = await torrentManager.pauseTorrent(infoHash);

    return {
      success: stopped,
    };
  });

// Start a torrent
export const startTorrent = t.procedure
  .input(
    z.object({
      infoHash: z.string(),
    }),
  )
  .mutation(async (req) => {
    const { infoHash } = req.input;
    const started = await torrentManager.resumeTorrent(infoHash);

    return {
      success: started,
    };
  });

// Remove a torrent
export const removeTorrent = t.procedure
  .input(
    z.object({
      infoHash: z.string(),
      deleteData: z.boolean().optional().default(false),
    }),
  )
  .mutation(async (req) => {
    const { infoHash, deleteData } = req.input;

    // Clean up HLS session and cache
    const session = sessionRegistry.getSessionByInfoHash(infoHash);
    if (session) {
      console.log(`[Torrent] Cleaning up HLS session for ${infoHash}`);

      // Stop any running FFmpeg process
      ffmpegProcess.stopGeneration(session.sessionKey);

      // Delete cached segments
      await segmentCache.deleteSession(session.sessionKey);

      // Remove session from registry
      sessionRegistry.removeSession(session.sessionKey);
    }

    // Delete transcode job from database
    await transcodeJobManager.deleteJob(infoHash);

    // Remove torrent from client
    const removed = await torrentManager.removeTorrent(infoHash, deleteData);

    return {
      success: removed,
    };
  });

// Restart transcoding for a torrent (clears cache and re-transcodes)
export const restartTranscoding = t.procedure
  .input(
    z.object({
      infoHash: z.string(),
    }),
  )
  .mutation(async (req) => {
    const { infoHash } = req.input;

    console.log(`[Torrent] Restarting transcoding for ${infoHash}`);

    // Clean up existing HLS session and cache
    const session = sessionRegistry.getSessionByInfoHash(infoHash);
    if (session) {
      // Stop any running FFmpeg process
      ffmpegProcess.stopGeneration(session.sessionKey);

      // Delete cached segments
      await segmentCache.deleteSession(session.sessionKey);

      // Remove session from registry (will be recreated on next request)
      sessionRegistry.removeSession(session.sessionKey);
    }

    // Delete transcode job from database (will be recreated)
    await transcodeJobManager.deleteJob(infoHash);

    return {
      success: true,
      message: 'Transcoding cache cleared. Will restart on next playback.',
    };
  });

// Get video file info for a torrent
export const getVideoInfo = t.procedure
  .input(
    z.object({
      infoHash: z.string(),
    }),
  )
  .query(async (req) => {
    const { infoHash } = req.input;
    const fileInfo = await torrentManager.getVideoFileInfo(infoHash);

    if (!fileInfo) {
      return {
        success: false,
        error: 'No video file found',
      };
    }

    return {
      success: true,
      data: fileInfo,
    };
  });

// Check if video file is available for streaming
export const isVideoAvailable = t.procedure
  .input(
    z.object({
      infoHash: z.string(),
    }),
  )
  .query(async (req) => {
    const { infoHash } = req.input;
    const available = await torrentManager.isFileAvailable(infoHash);

    return {
      success: true,
      available,
    };
  });

// Scan downloads directory for all video files
export const scanVideos = t.procedure.query(async () => {
  const videos = await torrentManager.scanDownloadsDirectory();

  return {
    success: true,
    data: videos,
  };
});
