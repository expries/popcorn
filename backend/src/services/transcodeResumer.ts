import { existsSync } from 'fs';

import { probeFile, makeTranscodeDecision } from '../hls/codecProbe';
import { ffmpegProcess } from '../hls/ffmpegProcess';
import { segmentCache } from '../hls/segmentCache';
import { sessionRegistry } from '../hls/sessionRegistry';
import { determineStreamingStrategy } from '../hls/streamingStrategy';
import type { HlsSession } from '../hls/types';
import { DEFAULT_HLS_CONFIG, getCumulativeDuration } from '../hls/types';
import { createLogger } from '../utils/logger';

import { transcodeJobManager } from './transcodeJobManager';
import { torrentManager } from './torrentManager';

const log = createLogger('Resume');

/**
 * Resume incomplete transcode jobs from the database on server restart.
 */
export async function resumeIncompleteTranscodes(): Promise<void> {
  log.info('Checking for incomplete transcode jobs...');

  const incompleteJobs = await transcodeJobManager.getIncompleteJobs();

  if (incompleteJobs.length === 0) {
    log.info('No incomplete transcode jobs found');
    return;
  }

  log.info(`Found ${incompleteJobs.length} incomplete transcode jobs`);

  for (const job of incompleteJobs) {
    try {
      // Check if the file still exists
      if (!existsSync(job.filePath)) {
        log.info(`File no longer exists for ${job.infoHash}, marking as failed`);
        await transcodeJobManager.markFailed(job.infoHash);
        continue;
      }

      // Check if torrent is still in Transmission
      const torrentStats = await torrentManager.getTorrentStats(job.infoHash);
      if (!torrentStats) {
        log.info(`Torrent no longer exists for ${job.infoHash}, marking as failed`);
        await transcodeJobManager.markFailed(job.infoHash);
        continue;
      }

      // Re-probe the file to get codec info
      const codecInfo = await probeFile(job.filePath);
      const decision = makeTranscodeDecision(codecInfo);

      // Re-evaluate streaming strategy with current download progress
      // This handles cases where download completed during server downtime
      const strategy = determineStreamingStrategy(codecInfo, job.containerFormat, torrentStats.progress);
      log.debug(`Re-evaluated strategy for ${job.infoHash}: canTranscode=${strategy.canTranscodeNow}, waiting=${strategy.waitingForDownload}, useIncompleteFlags=${strategy.useIncompleteFileFlags}`);

      // Check for existing segments in cache
      const existingSegments = await segmentCache.getExistingSegments(job.sessionKey);
      const highestExistingSegment = existingSegments.length > 0 ? Math.max(...existingSegments) : -1;

      // Use the higher of DB or cache for progress
      const highestSegment = Math.max(job.highestGeneratedSegment, highestExistingSegment);

      // Segment durations are not persisted, so use empty map for resumed sessions
      // Existing segments will use default duration; new segments will have actual durations
      const segmentDurations = new Map<number, number>();

      // Reconstruct the session with fresh streaming strategy
      const session: HlsSession = {
        sessionKey: job.sessionKey,
        infoHash: job.infoHash,
        filePath: job.filePath,
        codecInfo,
        decision,
        createdAt: new Date(job.createdAt),
        lastAccessedAt: new Date(),
        segmentDuration: job.segmentDuration,
        totalSegments: job.totalSegments,
        generatedSegments: new Set(existingSegments),
        segmentDurations,
        ffmpegStartSegment: highestSegment + 1,
        highestGeneratedSegment: highestSegment,
        isGenerating: false,
        streamingMode: strategy.mode,
        waitingForDownload: strategy.waitingForDownload,
        transcodedDuration: highestSegment >= 0
          ? getCumulativeDuration(segmentDurations, highestSegment, job.segmentDuration)
          : 0,
        totalDuration: Number(job.totalDuration),
        containerFormat: job.containerFormat,
        useIncompleteFileFlags: strategy.useIncompleteFileFlags,
      };

      // Register the session
      sessionRegistry.registerSession(session);

      // Check if transcoding is complete
      if (highestSegment >= job.totalSegments - 1) {
        log.info(`Transcode for ${job.infoHash} is already complete`);
        await transcodeJobManager.markCompleted(job.infoHash);
        continue;
      }

      // Only resume if strategy says we can transcode now
      if (!strategy.canTranscodeNow) {
        log.debug(`Waiting for download to complete for ${job.infoHash} (progress: ${(torrentStats.progress * 100).toFixed(1)}%)`);
        session.waitingForDownload = true;
        continue;
      }

      // Resume transcoding from the next segment
      const nextSegment = highestSegment + 1;
      log.info(`Resuming transcode for ${job.infoHash} from segment ${nextSegment}`);

      await ffmpegProcess.startGeneration(session, nextSegment, torrentStats.progress);
      await transcodeJobManager.markInProgress(job.infoHash);

    } catch (error) {
      log.error(`Failed to resume transcode for ${job.infoHash}:`, error);
      await transcodeJobManager.markFailed(job.infoHash);
    }
  }
}
