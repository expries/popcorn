import { getDownloadProgress } from '../../hls/downloadTracker';
import { ffmpegProcess } from '../../hls/ffmpegProcess';
import { generateMasterPlaylist, generateVariantPlaylist } from '../../hls/playlistGenerator';
import { segmentCache } from '../../hls/segmentCache';
import { calculateCanSeekTo, getHighestContiguousSegment, sessionRegistry } from '../../hls/sessionRegistry';
import { DEFAULT_HLS_CONFIG } from '../../hls/types';
import { createLogger } from '../../utils/logger';
import {
  hlsPlaylistResponse,
  hlsSegmentResponse,
  jsonErrorResponse,
} from './responses';

const log = createLogger('HLS');

const SEGMENT_WAIT_TIMEOUT = DEFAULT_HLS_CONFIG.segmentWaitTimeoutMs;

export async function handleMasterPlaylist(infoHash: string, baseUrl: string): Promise<Response> {
  try {
    // Get download progress for streaming strategy determination
    const downloadProgress = await getDownloadProgress(infoHash);
    const session = await sessionRegistry.getOrCreateSession(infoHash, downloadProgress?.progress);
    sessionRegistry.touch(session.sessionKey);

    // Check if we're waiting for download
    if (session.waitingForDownload) {
      return jsonErrorResponse('Download not yet complete for this file type', 503, {
        waitingForDownload: true,
        downloadProgress: downloadProgress?.progress ?? 0,
        reason: 'Container requires full download for metadata access',
      });
    }

    const playlist = generateMasterPlaylist(session, baseUrl);
    return hlsPlaylistResponse(playlist);
  } catch (err) {
    log.error('Master playlist error:', err);
    const message = err instanceof Error ? err.message : 'Unknown error';
    // If session creation failed (e.g., FFprobe error), return 503 to indicate file isn't ready
    if (message.includes('FFprobe')) {
      return jsonErrorResponse('File not ready for streaming yet', 503, {
        waitingForDownload: true,
        reason: 'Waiting for more download data',
      });
    }
    return jsonErrorResponse(message, 500);
  }
}

export async function handleVariantPlaylist(infoHash: string, baseUrl: string): Promise<Response> {
  try {
    const downloadProgress = await getDownloadProgress(infoHash);
    const session = await sessionRegistry.getOrCreateSession(infoHash, downloadProgress?.progress);
    sessionRegistry.touch(session.sessionKey);

    // Check if we're waiting for download
    if (session.waitingForDownload) {
      return jsonErrorResponse('Download not yet complete for this file type', 503, {
        waitingForDownload: true,
        downloadProgress: downloadProgress?.progress ?? 0,
      });
    }

    // Start transcoding if not already running - this ensures segments start generating
    // before the playlist is returned. The playlist will only include transcoded segments,
    // so we need to ensure transcoding has begun.
    await ffmpegProcess.ensureTranscodingStarted(session, downloadProgress?.progress);

    // Wait for at least segment 0 to be ready before returning the playlist
    // This ensures HLS.js has something to play. Timeout after 10s.
    if (!session.generatedSegments.has(0)) {
      log.debug(`[${session.sessionKey}] Waiting for first segment before returning playlist`);
      const firstSegmentReady = await ffmpegProcess.waitForSegment(session, 0, 10000);
      if (!firstSegmentReady) {
        log.warn(`[${session.sessionKey}] First segment not ready after 10s`);
        // Return 503 to let HLS.js retry
        return new Response(null, {
          status: 503,
          headers: {
            'Retry-After': '2',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }
    }

    const playlist = generateVariantPlaylist(session, baseUrl);
    return hlsPlaylistResponse(playlist);
  } catch (err) {
    log.error('Variant playlist error:', err);
    const message = err instanceof Error ? err.message : 'Unknown error';
    if (message.includes('FFprobe')) {
      return jsonErrorResponse('File not ready for streaming yet', 503, {
        waitingForDownload: true,
        reason: 'Waiting for more download data',
      });
    }
    return jsonErrorResponse(message, 500);
  }
}

export async function handleSegmentRequest(
  infoHash: string,
  segmentIndex: number,
): Promise<Response> {
  try {
    // Get download progress for safety margin calculation
    const downloadProgress = await getDownloadProgress(infoHash);
    const session = await sessionRegistry.getOrCreateSession(infoHash, downloadProgress?.progress);
    sessionRegistry.touch(session.sessionKey);

    // Validate segment index
    if (segmentIndex < 0 || segmentIndex >= session.totalSegments) {
      return jsonErrorResponse('Invalid segment index', 400, {
        requested: segmentIndex,
        total: session.totalSegments,
      });
    }

    // Check if we're waiting for download
    if (session.waitingForDownload) {
      return jsonErrorResponse('Download not yet complete', 503, {
        waitingForDownload: true,
        downloadProgress: downloadProgress?.progress ?? 0,
      });
    }

    // Ensure transcoding is started (from beginning or resume point)
    // This also invalidates any stale cached segments, so we call it BEFORE checking cache
    await ffmpegProcess.ensureTranscodingStarted(session, downloadProgress?.progress);

    // Check cache - only trust segments that are in generatedSegments (validated by FFmpeg)
    if (session.generatedSegments.has(segmentIndex)) {
      const cachedSegment = await segmentCache.readSegment(session.sessionKey, segmentIndex);
      if (cachedSegment) {
        log.debug(`[${session.sessionKey}] Cache hit: segment_${segmentIndex}`);
        return hlsSegmentResponse(cachedSegment);
      }
    }

    // Check segment status
    const status = await ffmpegProcess.getSegmentStatus(session, segmentIndex);

    if (status === 'ready') {
      // Segment should be in cache now
      const segment = await segmentCache.readSegment(session.sessionKey, segmentIndex);
      if (segment) {
        log.debug(`[${session.sessionKey}] Serving segment_${segmentIndex}`);
        return hlsSegmentResponse(segment);
      }
      // File read failed unexpectedly - treat as missing
      log.error(`[${session.sessionKey}] Segment ${segmentIndex} status was 'ready' but file read failed`);
    }

    if (status === 'missing') {
      // Segment was generated but file is gone - this is an error condition
      // Remove from generatedSegments to allow regeneration on next request
      session.generatedSegments.delete(segmentIndex);
      log.error(`[${session.sessionKey}] Segment ${segmentIndex} file missing - removed from tracking`);
      return jsonErrorResponse('Segment file missing - please retry', 500, {
        segmentIndex,
        error: 'FILE_MISSING',
      });
    }

    if (status === 'pending') {
      // Segment will be generated - wait for it
      log.debug(`[${session.sessionKey}] Waiting for segment_${segmentIndex} (transcoding in progress)`);
      const ready = await ffmpegProcess.waitForSegment(session, segmentIndex, SEGMENT_WAIT_TIMEOUT);

      if (ready) {
        const segment = await segmentCache.readSegment(session.sessionKey, segmentIndex);
        if (segment) {
          log.debug(`[${session.sessionKey}] Serving segment_${segmentIndex}`);
          return hlsSegmentResponse(segment);
        }
      }

      // Still not ready after timeout - return 503 to let HLS.js retry
      log.debug(`[${session.sessionKey}] Segment ${segmentIndex} not ready after timeout`);
      return new Response(null, {
        status: 503,
        headers: {
          'Retry-After': '2',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    // status === 'unavailable' - segment is ahead of transcoding progress
    // Return 416 Range Not Satisfiable with info about current progress
    // The frontend will show the "only transcoded until XX:XX" dialog
    const currentSegment = getHighestContiguousSegment(session.generatedSegments);
    const canSeekTo = calculateCanSeekTo(session, downloadProgress?.progress ?? 0);
    const requestedTime = segmentIndex * DEFAULT_HLS_CONFIG.segmentDuration;

    log.info(`[${session.sessionKey}] Segment ${segmentIndex} unavailable - transcoded up to ${currentSegment} (${Math.floor(canSeekTo / 60)}:${String(Math.floor(canSeekTo % 60)).padStart(2, '0')})`);

    return new Response(
      JSON.stringify({
        error: 'Segment not yet transcoded',
        segmentNotReady: true,
        requestedSegment: segmentIndex,
        requestedTime,
        currentSegment,
        canSeekTo,
        transcodeProgress: session.totalSegments > 0 ? (currentSegment + 1) / session.totalSegments : 0,
      }),
      {
        status: 416,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      },
    );
  } catch (err) {
    log.error('Segment error:', err);
    const message = err instanceof Error ? err.message : 'Unknown error';
    return jsonErrorResponse(message, 500);
  }
}
