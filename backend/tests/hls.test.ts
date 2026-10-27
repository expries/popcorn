import { describe, expect, it } from 'bun:test';

import { makeTranscodeDecision, parseFrameRate, parseSessionKey, buildSessionKey } from '../src/hls/codecProbe';
import { generateVariantPlaylist } from '../src/hls/playlistGenerator';
import { getHighestContiguousSegment } from '../src/hls/sessionRegistry';
import type { CodecInfo, HlsSession } from '../src/hls/types';

// ============================================================================
// getHighestContiguousSegment tests
// ============================================================================
describe('getHighestContiguousSegment', () => {
  it('returns -1 for empty set', () => {
    expect(getHighestContiguousSegment(new Set())).toBe(-1);
  });

  it('returns 0 for single segment at 0', () => {
    expect(getHighestContiguousSegment(new Set([0]))).toBe(0);
  });

  it('returns -1 if segment 0 is missing', () => {
    // Gap at the beginning - even though we have segments, none are contiguous from 0
    expect(getHighestContiguousSegment(new Set([1, 2, 3]))).toBe(-1);
  });

  it('returns highest contiguous segment', () => {
    expect(getHighestContiguousSegment(new Set([0, 1, 2, 3, 4]))).toBe(4);
  });

  it('stops at first gap', () => {
    // Segments 0, 1, 2 exist, then gap at 3, then 50, 51, 52
    expect(getHighestContiguousSegment(new Set([0, 1, 2, 50, 51, 52]))).toBe(2);
  });

  it('handles single gap correctly', () => {
    // 0, 1, gap at 2, then 3
    expect(getHighestContiguousSegment(new Set([0, 1, 3]))).toBe(1);
  });

  it('handles large contiguous range', () => {
    const segments = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      segments.add(i);
    }
    expect(getHighestContiguousSegment(segments)).toBe(999);
  });

  it('handles large range with gap in middle', () => {
    const segments = new Set<number>();
    for (let i = 0; i < 500; i++) {
      segments.add(i);
    }
    // Skip 500
    for (let i = 501; i < 1000; i++) {
      segments.add(i);
    }
    expect(getHighestContiguousSegment(segments)).toBe(499);
  });
});

// ============================================================================
// parseFrameRate tests
// ============================================================================
describe('parseFrameRate', () => {
  it('returns default 24 for undefined', () => {
    expect(parseFrameRate(undefined)).toBe(24);
  });

  it('returns default 24 for empty string', () => {
    expect(parseFrameRate('')).toBe(24);
  });

  it('parses simple integer', () => {
    expect(parseFrameRate('30')).toBe(30);
  });

  it('parses decimal', () => {
    expect(parseFrameRate('29.97')).toBeCloseTo(29.97);
  });

  it('parses fractional 24000/1001 (23.976 fps)', () => {
    const fps = parseFrameRate('24000/1001');
    expect(fps).toBeCloseTo(23.976, 2);
  });

  it('parses fractional 30000/1001 (29.97 fps)', () => {
    const fps = parseFrameRate('30000/1001');
    expect(fps).toBeCloseTo(29.97, 2);
  });

  it('parses fractional 25/1 (25 fps)', () => {
    expect(parseFrameRate('25/1')).toBe(25);
  });

  it('parses fractional 60/1 (60 fps)', () => {
    expect(parseFrameRate('60/1')).toBe(60);
  });

  it('handles 0/0 gracefully', () => {
    // Division by zero case - should return default
    expect(parseFrameRate('0/0')).toBe(24);
  });

  it('handles 24/0 gracefully (division by zero)', () => {
    // When denominator is 0, den ? num/den : num evaluates to num
    // But 24 > 120 is false and 24 < 1 is false, so 24 is valid
    expect(parseFrameRate('24/0')).toBe(24);
  });

  it('returns default for invalid string', () => {
    expect(parseFrameRate('invalid')).toBe(24);
  });

  it('returns default for fps < 1', () => {
    expect(parseFrameRate('0.5')).toBe(24);
  });

  it('returns default for fps > 120', () => {
    expect(parseFrameRate('240')).toBe(24);
  });

  it('accepts fps at boundary (1 fps)', () => {
    expect(parseFrameRate('1')).toBe(1);
  });

  it('accepts fps at boundary (120 fps)', () => {
    expect(parseFrameRate('120')).toBe(120);
  });

  it('returns default for negative fps', () => {
    expect(parseFrameRate('-30')).toBe(24);
  });

  it('returns default for NaN', () => {
    expect(parseFrameRate('NaN')).toBe(24);
  });

  it('returns default for Infinity', () => {
    expect(parseFrameRate('Infinity')).toBe(24);
  });
});

// ============================================================================
// makeTranscodeDecision tests
// ============================================================================
describe('makeTranscodeDecision', () => {
  const baseCodecInfo: CodecInfo = {
    videoCodec: 'h264',
    audioCodec: 'aac',
    videoBitrate: 5000000,
    audioBitrate: 192000,
    duration: 7200,
    width: 1920,
    height: 1080,
    frameRate: 24,
    videoProfile: 'High',
    videoLevel: 41,
    pixelFormat: 'yuv420p',
    moovAtStart: true,
  };

  it('returns copy mode for H.264 + AAC', () => {
    const decision = makeTranscodeDecision(baseCodecInfo);
    expect(decision.mode).toBe('copy');
    expect(decision.videoAction).toBe('copy');
    expect(decision.audioAction).toBe('copy');
  });

  it('returns copy mode for H.264 + MP3', () => {
    const codecInfo: CodecInfo = { ...baseCodecInfo, audioCodec: 'mp3' };
    const decision = makeTranscodeDecision(codecInfo);
    expect(decision.mode).toBe('copy');
    expect(decision.videoAction).toBe('copy');
    expect(decision.audioAction).toBe('copy');
  });

  it('returns copy mode for H.264 with no audio', () => {
    const codecInfo: CodecInfo = { ...baseCodecInfo, audioCodec: null };
    const decision = makeTranscodeDecision(codecInfo);
    expect(decision.mode).toBe('copy');
    expect(decision.videoAction).toBe('copy');
    expect(decision.audioAction).toBe('copy');
  });

  it('returns audio_only mode for H.264 + incompatible audio (AC3)', () => {
    const codecInfo: CodecInfo = { ...baseCodecInfo, audioCodec: 'ac3' };
    const decision = makeTranscodeDecision(codecInfo);
    expect(decision.mode).toBe('audio_only');
    expect(decision.videoAction).toBe('copy');
    expect(decision.audioAction).toBe('transcode');
  });

  it('returns audio_only mode for H.264 + EAC3', () => {
    const codecInfo: CodecInfo = { ...baseCodecInfo, audioCodec: 'eac3' };
    const decision = makeTranscodeDecision(codecInfo);
    expect(decision.mode).toBe('audio_only');
    expect(decision.videoAction).toBe('copy');
    expect(decision.audioAction).toBe('transcode');
  });

  it('returns audio_only mode for H.264 + DTS', () => {
    const codecInfo: CodecInfo = { ...baseCodecInfo, audioCodec: 'dts' };
    const decision = makeTranscodeDecision(codecInfo);
    expect(decision.mode).toBe('audio_only');
    expect(decision.videoAction).toBe('copy');
    expect(decision.audioAction).toBe('transcode');
  });

  it('returns full mode for HEVC video', () => {
    const codecInfo: CodecInfo = { ...baseCodecInfo, videoCodec: 'hevc' };
    const decision = makeTranscodeDecision(codecInfo);
    expect(decision.mode).toBe('full');
    expect(decision.videoAction).toBe('transcode');
    expect(decision.audioAction).toBe('transcode');
  });

  it('returns full mode for VP9 video', () => {
    const codecInfo: CodecInfo = { ...baseCodecInfo, videoCodec: 'vp9' };
    const decision = makeTranscodeDecision(codecInfo);
    expect(decision.mode).toBe('full');
    expect(decision.videoAction).toBe('transcode');
    expect(decision.audioAction).toBe('transcode');
  });

  it('returns full mode for AV1 video', () => {
    const codecInfo: CodecInfo = { ...baseCodecInfo, videoCodec: 'av1' };
    const decision = makeTranscodeDecision(codecInfo);
    expect(decision.mode).toBe('full');
    expect(decision.videoAction).toBe('transcode');
    expect(decision.audioAction).toBe('transcode');
  });

  it('returns full mode for null video codec', () => {
    const codecInfo: CodecInfo = { ...baseCodecInfo, videoCodec: null };
    const decision = makeTranscodeDecision(codecInfo);
    expect(decision.mode).toBe('full');
    expect(decision.videoAction).toBe('transcode');
    expect(decision.audioAction).toBe('transcode');
  });
});

// ============================================================================
// buildSessionKey and parseSessionKey tests
// ============================================================================
describe('buildSessionKey', () => {
  it('builds session key with copy mode', () => {
    expect(buildSessionKey('abc123', 'copy')).toBe('abc123_copy');
  });

  it('builds session key with full mode', () => {
    expect(buildSessionKey('abc123', 'full')).toBe('abc123_full');
  });

  it('builds session key with audio_only mode', () => {
    expect(buildSessionKey('abc123', 'audio_only')).toBe('abc123_audio_only');
  });

  it('handles infoHash with underscores', () => {
    expect(buildSessionKey('abc_123_def', 'copy')).toBe('abc_123_def_copy');
  });
});

describe('parseSessionKey', () => {
  it('parses session key with copy mode', () => {
    const result = parseSessionKey('abc123_copy');
    expect(result.infoHash).toBe('abc123');
    expect(result.mode).toBe('copy');
  });

  it('parses session key with full mode', () => {
    const result = parseSessionKey('abc123_full');
    expect(result.infoHash).toBe('abc123');
    expect(result.mode).toBe('full');
  });

  it('parses session key with audio_only mode', () => {
    const result = parseSessionKey('abc123_audio_only');
    expect(result.infoHash).toBe('abc123');
    expect(result.mode).toBe('audio_only');
  });

  it('handles infoHash with underscores', () => {
    const result = parseSessionKey('abc_123_def_copy');
    expect(result.infoHash).toBe('abc_123_def');
    expect(result.mode).toBe('copy');
  });

  it('throws for invalid session key (no underscore)', () => {
    expect(() => parseSessionKey('abc123copy')).toThrow('Invalid session key');
  });
});

// ============================================================================
// generateVariantPlaylist tests
// ============================================================================
describe('generateVariantPlaylist', () => {
  const createMockSession = (
    generatedSegments: Set<number>,
    totalSegments: number,
    duration: number = 600,
  ): HlsSession => ({
    sessionKey: 'testhash_full',
    infoHash: 'testhash',
    filePath: '/path/to/video.mkv',
    codecInfo: {
      videoCodec: 'hevc',
      audioCodec: 'aac',
      videoBitrate: 5000000,
      audioBitrate: 192000,
      duration,
      width: 1920,
      height: 1080,
      frameRate: 24,
      videoProfile: 'Main',
      videoLevel: 41,
      pixelFormat: 'yuv420p',
      moovAtStart: null,
    },
    decision: {
      mode: 'full',
      videoAction: 'transcode',
      audioAction: 'transcode',
      reason: 'HEVC needs transcoding',
    },
    createdAt: new Date(),
    lastAccessedAt: new Date(),
    segmentDuration: 6,
    totalSegments,
    generatedSegments,
    segmentDurations: new Map(),
    ffmpegStartSegment: 0,
    highestGeneratedSegment: Math.max(...generatedSegments, -1),
    isGenerating: totalSegments > generatedSegments.size,
    streamingMode: 'hls',
    waitingForDownload: false,
    transcodedDuration: generatedSegments.size * 6,
    totalDuration: duration,
    containerFormat: 'matroska',
    useIncompleteFileFlags: false,
  });

  it('generates empty playlist for no segments', () => {
    const session = createMockSession(new Set(), 100);
    const playlist = generateVariantPlaylist(session, 'http://localhost:3001');

    expect(playlist).toContain('#EXTM3U');
    expect(playlist).toContain('#EXT-X-PLAYLIST-TYPE:EVENT');
    expect(playlist).not.toContain('#EXT-X-ENDLIST');
    expect(playlist).not.toContain('segment_0.ts');
  });

  it('generates playlist with contiguous segments only', () => {
    // Segments 0, 1, 2 exist, but not 3
    const session = createMockSession(new Set([0, 1, 2]), 100);
    const playlist = generateVariantPlaylist(session, 'http://localhost:3001');

    expect(playlist).toContain('segment_0.ts');
    expect(playlist).toContain('segment_1.ts');
    expect(playlist).toContain('segment_2.ts');
    expect(playlist).not.toContain('segment_3.ts');
    expect(playlist).toContain('#EXT-X-PLAYLIST-TYPE:EVENT');
    expect(playlist).not.toContain('#EXT-X-ENDLIST');
  });

  it('ignores non-contiguous segments', () => {
    // Segments 0, 1, 2 contiguous, then gap, then 50, 51, 52
    const session = createMockSession(new Set([0, 1, 2, 50, 51, 52]), 100);
    const playlist = generateVariantPlaylist(session, 'http://localhost:3001');

    expect(playlist).toContain('segment_0.ts');
    expect(playlist).toContain('segment_1.ts');
    expect(playlist).toContain('segment_2.ts');
    expect(playlist).not.toContain('segment_50.ts');
    expect(playlist).not.toContain('segment_51.ts');
    expect(playlist).not.toContain('segment_52.ts');
  });

  it('adds ENDLIST when all segments are generated', () => {
    // All 10 segments generated
    const session = createMockSession(new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), 10, 60);
    const playlist = generateVariantPlaylist(session, 'http://localhost:3001');

    expect(playlist).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
    expect(playlist).toContain('#EXT-X-ENDLIST');
    expect(playlist).toContain('segment_9.ts');
  });

  it('calculates correct last segment duration', () => {
    // 65 second video with 6s segments = 11 segments
    // Last segment should be 5 seconds (65 % 6 = 5)
    const session = createMockSession(
      new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
      11,
      65,
    );
    const playlist = generateVariantPlaylist(session, 'http://localhost:3001');

    // Check that the last segment has duration 5.000
    const lines = playlist.split('\n');
    const lastExtinf = lines.filter((l) => l.startsWith('#EXTINF:')).pop();
    expect(lastExtinf).toBe('#EXTINF:5.000,');
  });

  it('uses correct baseUrl for segment paths', () => {
    const session = createMockSession(new Set([0, 1]), 100);
    const playlist = generateVariantPlaylist(session, 'https://example.com:8080');

    expect(playlist).toContain('https://example.com:8080/hls/testhash/segment_0.ts');
    expect(playlist).toContain('https://example.com:8080/hls/testhash/segment_1.ts');
  });

  it('handles gap at segment 0', () => {
    // Missing segment 0, have 1, 2, 3
    const session = createMockSession(new Set([1, 2, 3]), 100);
    const playlist = generateVariantPlaylist(session, 'http://localhost:3001');

    // Should not include any segments because 0 is missing
    expect(playlist).not.toContain('segment_0.ts');
    expect(playlist).not.toContain('segment_1.ts');
    expect(playlist).not.toContain('segment_2.ts');
  });
});
