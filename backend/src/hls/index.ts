// Re-export all HLS modules

export { cacheEvictor } from './cacheEvictor';
export { buildSessionKey, makeTranscodeDecision, parseSessionKey, probeFile } from './codecProbe';
export { ffmpegProcess } from './ffmpegProcess';
export { generateMasterPlaylist, generateVariantPlaylist } from './playlistGenerator';
export { segmentCache } from './segmentCache';
export { sessionRegistry } from './sessionRegistry';
export type {
  CacheStats,
  CodecInfo,
  FFprobeResult,
  HlsConfig,
  HlsSession,
  SessionKey,
  TranscodeDecision,
  TranscodeMode,
} from './types';
export { DEFAULT_HLS_CONFIG } from './types';

// Re-export route handlers from routes/stream
export {
  handleMasterPlaylist,
  handleSegmentRequest,
  handleVariantPlaylist,
} from '../routes/stream/hlsHandlers';
