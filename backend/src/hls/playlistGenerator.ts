import { getHighestContiguousSegment } from './sessionRegistry';
import type { HlsSession } from './types';
import { createLogger } from '../utils/logger';

const log = createLogger('Playlist');

interface PlaylistState {
  availableSegments: number;
  isComplete: boolean;
  defaultSegmentDuration: number; // Fallback duration for segments without recorded duration
}

/**
 * Estimate bandwidth based on video properties and transcode decision
 */
function estimateBandwidth(session: HlsSession): number {
  const { width, height, videoBitrate, audioBitrate } = session.codecInfo;

  // If copying, use actual bitrates if available
  if (session.decision.mode === 'copy') {
    const video = videoBitrate ?? 5_000_000;
    const audio = audioBitrate ?? 192_000;
    return video + audio;
  }

  // For transcode, estimate based on resolution (CRF 23 typical output)
  const pixels = width * height;
  if (pixels >= 1920 * 1080) return 5_000_000; // 1080p
  if (pixels >= 1280 * 720) return 3_000_000;  // 720p
  if (pixels >= 854 * 480) return 1_500_000;   // 480p
  return 800_000; // Lower resolutions
}

/**
 * Calculate playlist state from session data
 */
function calculatePlaylistState(session: HlsSession): PlaylistState {
  const highestContiguous = getHighestContiguousSegment(session.generatedSegments);
  const availableSegments = highestContiguous + 1;

  // Complete if FFmpeg stopped and we have all expected segments
  const isComplete = !session.isGenerating
    && availableSegments > 0
    && availableSegments >= session.totalSegments;

  // Use configured segment duration as default fallback
  // Actual durations are stored in session.segmentDurations and used when available
  return { availableSegments, isComplete, defaultSegmentDuration: session.segmentDuration };
}

/**
 * Calculate duration for a specific segment.
 * Uses actual recorded duration if available, falls back to configured default.
 */
function getSegmentDuration(
  index: number,
  state: PlaylistState,
  session: HlsSession,
): number {
  // First, check if we have the actual duration for this segment
  const actualDuration = session.segmentDurations.get(index);
  if (actualDuration !== undefined) {
    return actualDuration;
  }

  // Fall back to default segment duration for segments without recorded duration
  // This happens for segments cached before server restart
  return state.defaultSegmentDuration;
}

/**
 * Calculate the maximum segment duration (for TARGETDURATION in playlist).
 */
function getMaxSegmentDuration(session: HlsSession, availableSegments: number): number {
  let maxDuration = session.segmentDuration;

  for (let i = 0; i < availableSegments; i++) {
    const duration = session.segmentDurations.get(i);
    if (duration !== undefined && duration > maxDuration) {
      maxDuration = duration;
    }
  }

  return maxDuration;
}

/**
 * Generate master playlist with single variant
 */
export function generateMasterPlaylist(session: HlsSession, baseUrl: string): string {
  const bandwidth = estimateBandwidth(session);
  const { width, height } = session.codecInfo;

  return [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${width}x${height}`,
    `${baseUrl}/hls/${session.infoHash}/stream.m3u8`,
    '',
  ].join('\n');
}

/**
 * Generate variant playlist with available segments
 *
 * - Only includes contiguous segments from 0 to prevent gaps
 * - Uses EVENT type during transcoding for periodic refresh
 * - Uses VOD type when complete
 */
export function generateVariantPlaylist(session: HlsSession, baseUrl: string): string {
  const state = calculatePlaylistState(session);
  const { availableSegments, isComplete, defaultSegmentDuration } = state;

  // TARGETDURATION must be >= the longest segment duration
  const maxSegmentDuration = getMaxSegmentDuration(session, availableSegments);

  // Count how many segments have recorded durations vs fallback
  const recordedCount = session.segmentDurations.size;

  // Debug: show first few recorded durations
  const sampleDurations: string[] = [];
  for (let i = 0; i < Math.min(5, availableSegments); i++) {
    const dur = session.segmentDurations.get(i);
    sampleDurations.push(`${i}:${dur?.toFixed(2) ?? 'none'}`);
  }

  log.info(
    `[${session.sessionKey}] Playlist: ${availableSegments}/${session.totalSegments} segs, ` +
    `recorded=${recordedCount}, maxDur=${maxSegmentDuration.toFixed(2)}s, ` +
    `total=${session.transcodedDuration.toFixed(1)}s, complete=${isComplete}, ` +
    `samples=[${sampleDurations.join(', ')}]`,
  );

  // Build header
  const lines: string[] = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${Math.ceil(maxSegmentDuration)}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    isComplete ? '#EXT-X-PLAYLIST-TYPE:VOD' : '#EXT-X-PLAYLIST-TYPE:EVENT',
  ];

  // Add segment entries with actual durations
  // Debug: log first few and any anomalies
  const anomalies: string[] = [];
  for (let i = 0; i < availableSegments; i++) {
    const duration = getSegmentDuration(i, state, session);
    if (duration < 1 || duration > 15) {
      anomalies.push(`seg${i}=${duration.toFixed(2)}s`);
    }
    lines.push(`#EXTINF:${duration.toFixed(3)},`);
    lines.push(`${baseUrl}/hls/${session.infoHash}/segment_${i}.ts`);
  }
  if (anomalies.length > 0) {
    log.warn(`[${session.sessionKey}] Anomalous segment durations: ${anomalies.slice(0, 10).join(', ')}${anomalies.length > 10 ? ` (and ${anomalies.length - 10} more)` : ''}`);
  }

  // End marker for VOD
  if (isComplete) {
    lines.push('#EXT-X-ENDLIST');
  }

  lines.push('');
  return lines.join('\n');
}
