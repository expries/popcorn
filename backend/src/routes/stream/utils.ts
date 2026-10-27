import type { CodecInfo } from '../../hls/types';
import { createLogger } from '../../utils/logger';

const log = createLogger('Utils');

const BROWSER_COMPATIBLE_EXTENSIONS = new Set(['mp4', 'm4v', 'webm', 'ogv']);

// Codecs that are universally supported by browsers and TV devices
// H.265/HEVC is NOT included - only Safari and some devices support it
const BROWSER_COMPATIBLE_VIDEO_CODECS = new Set(['h264', 'vp8', 'vp9', 'av1']);
const BROWSER_COMPATIBLE_AUDIO_CODECS = new Set(['aac', 'mp3', 'opus', 'vorbis']);

// Pixel formats compatible with browsers (8-bit 4:2:0 only)
// 10-bit, 4:2:2, 4:4:4 are NOT supported by most browsers
const BROWSER_COMPATIBLE_PIXEL_FORMATS = new Set(['yuv420p', 'yuvj420p']);

// H.264 profiles that are safe for TV/browser playback
// High 10, High 4:2:2, High 4:4:4 are problematic on many devices
const COMPATIBLE_H264_PROFILES = new Set([
  'Baseline',
  'Constrained Baseline',
  'Main',
  'High',
]);

// Maximum H.264 level for broad compatibility (4.1 = 1080p@30fps or 720p@60fps)
// Level 5.0+ is often problematic on TVs
const MAX_COMPATIBLE_H264_LEVEL = 42; // 4.2

/**
 * Check if a file needs HLS transcoding based on extension only.
 * This is a quick check - use needsTranscoding() for codec-aware decisions.
 */
export function needsHlsByExtension(fileName: string): boolean {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  return !BROWSER_COMPATIBLE_EXTENSIONS.has(ext);
}

/**
 * Check if H.264 profile/level is compatible with TV browsers
 */
function isH264ProfileCompatible(codecInfo: CodecInfo, verbose = false): boolean {
  // Check profile
  if (codecInfo.videoProfile) {
    const profileOk = COMPATIBLE_H264_PROFILES.has(codecInfo.videoProfile);
    if (!profileOk) {
      if (verbose) log.debug(`Incompatible H.264 profile: ${codecInfo.videoProfile}`);
      return false;
    }
  }

  // Check level (ffprobe returns level * 10, e.g., 41 for 4.1)
  if (codecInfo.videoLevel !== null) {
    const levelOk = codecInfo.videoLevel <= MAX_COMPATIBLE_H264_LEVEL;
    if (!levelOk) {
      if (verbose) log.debug(`H.264 level too high: ${codecInfo.videoLevel / 10}`);
      return false;
    }
  }

  return true;
}

/**
 * Check if a file needs transcoding based on actual codec info.
 * Returns true if the video or audio codec is not browser-compatible.
 */
export function needsTranscoding(codecInfo: CodecInfo | null, verbose = false): boolean {
  if (!codecInfo) {
    return false;
  }

  const videoCodecOk =
    codecInfo.videoCodec !== null && BROWSER_COMPATIBLE_VIDEO_CODECS.has(codecInfo.videoCodec);
  const audioOk =
    codecInfo.audioCodec !== null && BROWSER_COMPATIBLE_AUDIO_CODECS.has(codecInfo.audioCodec);

  // Check pixel format compatibility
  const pixelFormatOk =
    codecInfo.pixelFormat === null || BROWSER_COMPATIBLE_PIXEL_FORMATS.has(codecInfo.pixelFormat);
  if (!pixelFormatOk && verbose) {
    log.debug(`Incompatible pixel format: ${codecInfo.pixelFormat}`);
  }

  // Check moov atom position (must be at start for streaming)
  const moovOk = codecInfo.moovAtStart !== false; // null or true is ok
  if (!moovOk && verbose) {
    log.debug(`moov atom at end of file - not streamable`);
  }

  // For H.264, also check profile and level
  let videoOk = videoCodecOk && pixelFormatOk;
  if (videoCodecOk && codecInfo.videoCodec === 'h264') {
    videoOk = videoOk && isH264ProfileCompatible(codecInfo, verbose);
  }

  // Need transcoding if codec, pixel format, moov position, or audio is incompatible
  const needsTranscode = !videoOk || !audioOk || !moovOk;

  if (verbose) {
    log.debug(`Codec check: video=${codecInfo.videoCodec} (ok=${videoOk}), audio=${codecInfo.audioCodec} (ok=${audioOk}), pixFmt=${codecInfo.pixelFormat} (ok=${pixelFormatOk}), moovAtStart=${codecInfo.moovAtStart} (ok=${moovOk}), needsTranscode=${needsTranscode}`);
  }

  return needsTranscode;
}

/**
 * Determine if HLS is needed based on both extension and codec.
 * This is the main function to use for streaming decisions.
 */
export function needsHls(fileName: string, codecInfo?: CodecInfo | null, verbose = false): boolean {
  // First check extension - MKV, AVI always need HLS due to container
  if (needsHlsByExtension(fileName)) {
    return true;
  }

  // For MP4/WebM containers, check actual codecs
  if (codecInfo) {
    return needsTranscoding(codecInfo, verbose);
  }

  // No codec info available, assume native playback will work
  return false;
}

export function getBaseUrl(req: Request, port: number): string {
  return `http://${req.headers.get('host') ?? `localhost:${port}`}`;
}

/**
 * Get container format from file extension
 */
export function getContainerFormat(filePath: string): string {
  const ext = filePath.toLowerCase().split('.').pop();
  const formatMap: Record<string, string> = {
    mkv: 'matroska',
    webm: 'webm',
    mp4: 'mp4',
    m4v: 'mp4',
    mov: 'mov',
    avi: 'avi',
    ogv: 'ogg',
  };
  return formatMap[ext ?? ''] ?? 'unknown';
}
