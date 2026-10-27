import { describe, expect, it, mock, beforeEach } from 'bun:test';

import type { HlsSession } from '../src/hls/types';

// Mock the segmentCache module before importing ffmpegProcess
const mockSegmentExists = mock(() => Promise.resolve(false));

mock.module('../src/hls/segmentCache', () => ({
  segmentCache: {
    segmentExists: mockSegmentExists,
    ensureSessionDir: mock(() => Promise.resolve('/cache/test')),
    ensureDir: mock(() => Promise.resolve()),
    deleteSegmentsFrom: mock(() => Promise.resolve(0)),
    getSessionDir: mock(() => '/cache/test'),
    readSegment: mock(() => Promise.resolve(null)),
  },
}));

// Mock sessionRegistry
mock.module('../src/hls/sessionRegistry', () => ({
  sessionRegistry: {
    markSegmentReady: mock(() => {}),
    getSession: mock(() => null),
  },
}));

// Mock transcodeJobManager
mock.module('../src/services/transcodeJobManager', () => ({
  transcodeJobManager: {
    updateSegmentProgress: mock(() => Promise.resolve()),
  },
}));

// Import after mocking
const { ffmpegProcess } = await import('../src/hls/ffmpegProcess');

// ============================================================================
// getSegmentStatus tests
// ============================================================================
describe('getSegmentStatus', () => {
  const createMockSession = (overrides: Partial<HlsSession> = {}): HlsSession => ({
    sessionKey: 'testhash_full',
    infoHash: 'testhash',
    filePath: '/path/to/video.mkv',
    codecInfo: {
      videoCodec: 'hevc',
      audioCodec: 'aac',
      videoBitrate: 5000000,
      audioBitrate: 192000,
      duration: 600,
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
    totalSegments: 100,
    generatedSegments: new Set(),
    segmentDurations: new Map(),
    ffmpegStartSegment: 0,
    highestGeneratedSegment: -1,
    isGenerating: false,
    streamingMode: 'hls',
    waitingForDownload: false,
    transcodedDuration: 0,
    totalDuration: 600,
    containerFormat: 'matroska',
    useIncompleteFileFlags: false,
    ...overrides,
  });

  beforeEach(() => {
    mockSegmentExists.mockReset();
  });

  it('returns ready when segment file exists', async () => {
    mockSegmentExists.mockResolvedValue(true);
    const session = createMockSession();

    const status = await ffmpegProcess.getSegmentStatus(session, 5);

    expect(status).toBe('ready');
  });

  it('returns missing when segment is in generatedSegments but file is gone', async () => {
    mockSegmentExists.mockResolvedValue(false);
    const session = createMockSession({
      generatedSegments: new Set([0, 1, 2, 3, 4, 5]),
      highestGeneratedSegment: 5,
    });

    const status = await ffmpegProcess.getSegmentStatus(session, 3);

    expect(status).toBe('missing');
  });

  it('returns unavailable when FFmpeg is not running', async () => {
    mockSegmentExists.mockResolvedValue(false);
    const session = createMockSession({
      isGenerating: false,
    });

    const status = await ffmpegProcess.getSegmentStatus(session, 10);

    expect(status).toBe('unavailable');
  });

  it('returns pending when FFmpeg is generating and segment is within range', async () => {
    mockSegmentExists.mockResolvedValue(false);
    const session = createMockSession({
      isGenerating: true,
      ffmpegStartSegment: 0,
      highestGeneratedSegment: 10,
      totalSegments: 100,
    });

    // Segment 15 is within the pending threshold (10 + 120 = 130)
    const status = await ffmpegProcess.getSegmentStatus(session, 15);

    expect(status).toBe('pending');
  });

  it('returns unavailable when segment is before FFmpeg start position', async () => {
    mockSegmentExists.mockResolvedValue(false);
    const session = createMockSession({
      isGenerating: true,
      ffmpegStartSegment: 50, // FFmpeg started at segment 50
      highestGeneratedSegment: 55,
      totalSegments: 100,
    });

    // Segment 40 is before FFmpeg started, so it won't be generated
    const status = await ffmpegProcess.getSegmentStatus(session, 40);

    expect(status).toBe('unavailable');
  });

  it('returns unavailable when segment is too far ahead', async () => {
    mockSegmentExists.mockResolvedValue(false);
    const session = createMockSession({
      isGenerating: true,
      ffmpegStartSegment: 0,
      highestGeneratedSegment: 10,
      totalSegments: 500,
    });

    // Segment 200 is beyond the pending threshold (10 + 120 = 130)
    const status = await ffmpegProcess.getSegmentStatus(session, 200);

    expect(status).toBe('unavailable');
  });

  it('calculates pending threshold based on remaining segments', async () => {
    mockSegmentExists.mockResolvedValue(false);
    const session = createMockSession({
      isGenerating: true,
      ffmpegStartSegment: 0,
      highestGeneratedSegment: 90,
      totalSegments: 100, // Only 10 segments remaining
    });

    // Pending threshold = min(120, 100 - 90) = min(120, 10) = 10
    // So segments 90 to 100 should be pending

    const status99 = await ffmpegProcess.getSegmentStatus(session, 99);
    expect(status99).toBe('pending');

    const status100 = await ffmpegProcess.getSegmentStatus(session, 100);
    // Segment 100 is >= totalSegments (100), so it's beyond the limit
    // currentPosition + pendingThreshold = 90 + 10 = 100
    // segmentIndex <= currentPosition + pendingThreshold: 100 <= 100 is true
    expect(status100).toBe('pending');
  });

  it('returns pending for segment at exact boundary', async () => {
    mockSegmentExists.mockResolvedValue(false);
    const session = createMockSession({
      isGenerating: true,
      ffmpegStartSegment: 0,
      highestGeneratedSegment: 10,
      totalSegments: 200,
    });

    // currentPosition = max(0, 10) = 10
    // pendingThreshold = min(120, 200 - 10) = min(120, 190) = 120
    // Segment 130 is at currentPosition + pendingThreshold = 10 + 120 = 130
    const status = await ffmpegProcess.getSegmentStatus(session, 130);
    expect(status).toBe('pending');

    // Segment 131 is beyond the threshold
    const status131 = await ffmpegProcess.getSegmentStatus(session, 131);
    expect(status131).toBe('unavailable');
  });

  it('uses ffmpegStartSegment as current position when no segments generated yet', async () => {
    mockSegmentExists.mockResolvedValue(false);
    const session = createMockSession({
      isGenerating: true,
      ffmpegStartSegment: 50, // FFmpeg just started at segment 50
      highestGeneratedSegment: -1, // No segments generated yet
      totalSegments: 200,
    });

    // currentPosition = max(50, -1) = 50
    // Segment 50 should be pending (at ffmpegStartSegment)
    const status50 = await ffmpegProcess.getSegmentStatus(session, 50);
    expect(status50).toBe('pending');

    // Segment 49 should be unavailable (before start)
    const status49 = await ffmpegProcess.getSegmentStatus(session, 49);
    expect(status49).toBe('unavailable');
  });
});

// ============================================================================
// calculateSafeSegmentLimit tests
// ============================================================================
describe('calculateSafeSegmentLimit', () => {
  it('returns 0 when totalBytes is 0', () => {
    const result = ffmpegProcess.calculateSafeSegmentLimit(1000, 0, 100);
    expect(result).toBe(0);
  });

  it('calculates correct limit based on download progress', () => {
    // 50% downloaded, 100 total segments
    // downloadedSegments = floor(0.5 * 100) = 50
    // safeLimit = max(0, 50 - 2) = 48
    const result = ffmpegProcess.calculateSafeSegmentLimit(500, 1000, 100);
    expect(result).toBe(48);
  });

  it('returns 0 when safety margin exceeds downloaded segments', () => {
    // 1% downloaded, 100 total segments
    // downloadedSegments = floor(0.01 * 100) = 1
    // safeLimit = max(0, 1 - 2) = max(0, -1) = 0
    const result = ffmpegProcess.calculateSafeSegmentLimit(10, 1000, 100);
    expect(result).toBe(0);
  });

  it('handles full download correctly', () => {
    // 100% downloaded, 100 total segments
    // downloadedSegments = floor(1.0 * 100) = 100
    // safeLimit = max(0, 100 - 2) = 98
    const result = ffmpegProcess.calculateSafeSegmentLimit(1000, 1000, 100);
    expect(result).toBe(98);
  });
});

// ============================================================================
// calculateSafeDurationLimit tests
// ============================================================================
describe('calculateSafeDurationLimit', () => {
  // Assuming default segment duration is 6 seconds
  // SAFETY_MARGIN_SEGMENTS = 2
  // safetyMarginSeconds = 2 * 6 = 12

  it('calculates correct duration limit', () => {
    // 50% downloaded of 600 second video
    // downloadedDuration = 0.5 * 600 = 300
    // safeDuration = max(0, 300 - 12) = 288
    const result = ffmpegProcess.calculateSafeDurationLimit(0.5, 600);
    expect(result).toBe(288);
  });

  it('returns 0 when safety margin exceeds downloaded duration', () => {
    // 1% downloaded of 600 second video
    // downloadedDuration = 0.01 * 600 = 6
    // safeDuration = max(0, 6 - 12) = max(0, -6) = 0
    const result = ffmpegProcess.calculateSafeDurationLimit(0.01, 600);
    expect(result).toBe(0);
  });

  it('handles full download correctly', () => {
    // 100% downloaded of 600 second video
    // downloadedDuration = 1.0 * 600 = 600
    // safeDuration = max(0, 600 - 12) = 588
    const result = ffmpegProcess.calculateSafeDurationLimit(1.0, 600);
    expect(result).toBe(588);
  });

  it('handles zero progress', () => {
    const result = ffmpegProcess.calculateSafeDurationLimit(0, 600);
    expect(result).toBe(0);
  });
});
