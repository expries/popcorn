import type { CodecInfo } from './types';

export type StreamingMode = 'native' | 'hls';

export interface StreamingDecision {
  mode: StreamingMode;
  reason: string;
  canTranscodeNow: boolean;
  waitingForDownload: boolean;
  useIncompleteFileFlags: boolean;
  minimumDownloadPercent: number;
}

// Only H.264 and AAC are universally browser-compatible
const HLS_COMPATIBLE_VIDEO = new Set(['h264']);
const HLS_COMPATIBLE_AUDIO = new Set(['aac', 'mp3']);

/**
 * Check if the codec combination is browser-compatible (no transcoding needed)
 */
export function isCodecCompatible(codecInfo: CodecInfo): boolean {
  const videoOk = codecInfo.videoCodec !== null && HLS_COMPATIBLE_VIDEO.has(codecInfo.videoCodec);
  // Audio is OK if it's compatible OR if there's no audio track at all
  const audioOk = codecInfo.audioCodec === null || HLS_COMPATIBLE_AUDIO.has(codecInfo.audioCodec);
  return videoOk && audioOk;
}

/**
 * Determine the optimal streaming strategy based on codec info, container format,
 * and current download progress.
 *
 * Decision flow:
 * 1. If codec is browser-compatible (H.264 + AAC) -> Native streaming
 * 2. If container supports progressive reading (MKV, MP4 moov-at-start) -> HLS transcoding while downloading
 * 3. If container requires full file (MP4 moov-at-end, AVI) -> Wait for download, then HLS
 */
export function determineStreamingStrategy(
  codecInfo: CodecInfo,
  containerFormat: string,
  downloadProgress: number,
): StreamingDecision {
  // If codec is browser-compatible, use native streaming
  // This works even for moov-at-end MP4s - browsers handle this
  if (isCodecCompatible(codecInfo)) {
    return {
      mode: 'native',
      reason: 'Codec is browser-compatible (H.264 + AAC)',
      canTranscodeNow: false, // No transcoding needed
      waitingForDownload: false,
      useIncompleteFileFlags: false,
      minimumDownloadPercent: 0,
    };
  }

  // Needs HLS transcoding - check container format for progressive reading capability

  // Tier 1: MKV/WebM - best for progressive transcoding
  // Matroska containers store metadata throughout the file, enabling progressive reading
  const formatLower = containerFormat.toLowerCase();
  if (formatLower === 'matroska' || formatLower === 'webm' || formatLower === 'mkv') {
    const canStart = downloadProgress >= 0.02;
    return {
      mode: 'hls',
      reason: 'MKV/WebM supports progressive reading',
      canTranscodeNow: canStart,
      waitingForDownload: !canStart,
      useIncompleteFileFlags: true,
      minimumDownloadPercent: 2,
    };
  }

  // Tier 2: MP4/MOV - check moov position
  // moovAtStart === true: moov is at start, can read progressively
  // moovAtStart === null: unknown (e.g. incomplete download), try progressive anyway
  // moovAtStart === false: moov confirmed at end, need full download
  if (formatLower === 'mov' || formatLower === 'mp4') {
    if (codecInfo.moovAtStart === false) {
      // Moov confirmed at end - requires full download
      const isComplete = downloadProgress >= 1.0;
      return {
        mode: 'hls',
        reason: 'MP4 with moov at end - requires full download',
        canTranscodeNow: isComplete,
        waitingForDownload: !isComplete,
        useIncompleteFileFlags: false,
        minimumDownloadPercent: 100,
      };
    }
    // moovAtStart is true or null - try progressive reading
    const canStart = downloadProgress >= 0.05;
    return {
      mode: 'hls',
      reason: 'MP4 - attempting progressive reading',
      canTranscodeNow: canStart,
      waitingForDownload: !canStart,
      useIncompleteFileFlags: true,
      minimumDownloadPercent: 5,
    };
  }

  // Tier 3: AVI or unknown container
  // These require the full file to be downloaded before we can read metadata
  const isComplete = downloadProgress >= 1.0;
  return {
    mode: 'hls',
    reason: 'Container requires full download for metadata access',
    canTranscodeNow: isComplete,
    waitingForDownload: !isComplete,
    useIncompleteFileFlags: false,
    minimumDownloadPercent: 100,
  };
}

/**
 * Get human-readable streaming status message
 */
export function getStreamingStatusMessage(decision: StreamingDecision, downloadProgress: number): string {
  if (decision.mode === 'native') {
    return 'Native streaming (no transcoding needed)';
  }

  if (decision.waitingForDownload) {
    const progressPercent = (downloadProgress * 100).toFixed(1);
    const neededPercent = decision.minimumDownloadPercent;
    return `Waiting for download (${progressPercent}% / ${neededPercent}% needed)`;
  }

  return 'HLS transcoding active';
}
