import { spawn } from 'child_process';

import type { CodecInfo, FFprobeResult, SessionKey, TranscodeDecision, TranscodeMode } from './types';

// Only H.264 is universally supported in browsers
// HEVC/H.265 only works in Safari, so we transcode it for compatibility
const HLS_COMPATIBLE_VIDEO = new Set(['h264']);
const HLS_COMPATIBLE_AUDIO = new Set(['aac', 'mp3']);

/**
 * Parse frame rate string like "24000/1001" or "24" to number
 * Validates result is within reasonable bounds (1-120 fps)
 */
export function parseFrameRate(rate?: string): number {
  const DEFAULT_FPS = 24;
  if (!rate) return DEFAULT_FPS;

  let fps: number;
  const parts = rate.split('/');
  if (parts.length === 2) {
    const num = parseInt(parts[0], 10);
    const den = parseInt(parts[1], 10);
    fps = den ? num / den : num;
  } else {
    fps = parseFloat(rate);
  }

  // Validate frame rate is reasonable (1-120 fps)
  // Invalid or extreme values fall back to default
  if (!isFinite(fps) || fps < 1 || fps > 120) {
    return DEFAULT_FPS;
  }

  return fps;
}

/**
 * Check if moov atom comes before mdat (required for streaming)
 * Format: type:'moov' parent:'root' sz: SIZE POSITION TOTAL
 */
async function checkMoovPosition(filePath: string): Promise<boolean | null> {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', ['-v', 'trace', '-i', filePath]);
    let stderr = '';
    const timeout = setTimeout(() => {
      proc.kill();
      resolve(null);
    }, 10000);

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', () => {
      clearTimeout(timeout);
      // Match format: type:'moov' parent:'root' sz: SIZE POSITION TOTAL
      const moovMatch = stderr.match(/type:'moov' parent:'root' sz: \d+ (\d+)/);
      const mdatMatch = stderr.match(/type:'mdat' parent:'root' sz: \d+ (\d+)/);
      if (moovMatch && mdatMatch) {
        const moovPos = parseInt(moovMatch[1], 10);
        const mdatPos = parseInt(mdatMatch[1], 10);
        resolve(moovPos < mdatPos);
      } else {
        resolve(null);
      }
    });

    proc.on('error', () => {
      clearTimeout(timeout);
      resolve(null);
    });
  });
}

/**
 * Probe a video file using ffprobe to extract codec information
 */
export async function probeFile(filePath: string): Promise<CodecInfo> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath,
    ]);

    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error('FFprobe timed out after 30 seconds'));
    }, 30000);

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`FFprobe failed to start: ${err.message}`));
    });

    proc.on('close', async (code) => {
      clearTimeout(timeout);

      if (code !== 0) {
        reject(new Error(`FFprobe exited with code ${code}: ${stderr}`));
        return;
      }

      let data: FFprobeResult;
      try {
        data = JSON.parse(stdout);
      } catch {
        reject(new Error(`FFprobe returned invalid JSON: ${stdout.slice(0, 200)}`));
        return;
      }

      const videoStream = data.streams.find((s) => s.codec_type === 'video');
      const audioStream = data.streams.find((s) => s.codec_type === 'audio');

      // Check moov atom position for MP4 files
      const moovAtStart = await checkMoovPosition(filePath);

      // Duration extraction: prefer format duration, but fall back to stream duration
      // Some MKV files have unreliable format.duration
      let duration = parseFloat(data.format.duration) || 0;
      if (duration <= 0 && videoStream?.duration) {
        duration = parseFloat(videoStream.duration) || 0;
      }
      // Final fallback: calculate from nb_frames and frame rate if available
      if (duration <= 0 && videoStream?.nb_frames && videoStream?.r_frame_rate) {
        const frames = parseInt(videoStream.nb_frames, 10);
        const fps = parseFrameRate(videoStream.r_frame_rate);
        if (frames > 0 && fps > 0) {
          duration = frames / fps;
        }
      }

      resolve({
        videoCodec: videoStream?.codec_name ?? null,
        audioCodec: audioStream?.codec_name ?? null,
        videoBitrate: videoStream?.bit_rate ? parseInt(videoStream.bit_rate, 10) : null,
        audioBitrate: audioStream?.bit_rate ? parseInt(audioStream.bit_rate, 10) : null,
        duration,
        width: videoStream?.width ?? 0,
        height: videoStream?.height ?? 0,
        frameRate: parseFrameRate(videoStream?.r_frame_rate),
        videoProfile: videoStream?.profile ?? null,
        videoLevel: videoStream?.level ?? null,
        pixelFormat: videoStream?.pix_fmt ?? null,
        moovAtStart,
      });
    });
  });
}

/**
 * Determine the transcoding strategy based on codec information
 */
export function makeTranscodeDecision(codecInfo: CodecInfo): TranscodeDecision {
  const videoOk = codecInfo.videoCodec !== null && HLS_COMPATIBLE_VIDEO.has(codecInfo.videoCodec);
  // Audio is OK if it's compatible OR if there's no audio track at all
  const audioOk = codecInfo.audioCodec === null || HLS_COMPATIBLE_AUDIO.has(codecInfo.audioCodec);
  const hasAudio = codecInfo.audioCodec !== null;

  if (videoOk && audioOk) {
    return {
      mode: 'copy',
      videoAction: 'copy',
      audioAction: 'copy',
      reason: hasAudio
        ? `Video (${codecInfo.videoCodec}) and audio (${codecInfo.audioCodec}) are HLS compatible`
        : `Video (${codecInfo.videoCodec}) is HLS compatible (no audio track)`,
    };
  }

  if (videoOk && !audioOk) {
    return {
      mode: 'audio_only',
      videoAction: 'copy',
      audioAction: 'transcode',
      reason: `Video (${codecInfo.videoCodec}) compatible, audio (${codecInfo.audioCodec}) needs transcoding to AAC`,
    };
  }

  return {
    mode: 'full',
    videoAction: 'transcode',
    audioAction: 'transcode',
    reason: `Video (${codecInfo.videoCodec ?? 'none'}) needs transcoding to H.264`,
  };
}

/**
 * Build a session key from infoHash and transcode mode
 */
export function buildSessionKey(infoHash: string, mode: TranscodeMode): SessionKey {
  return `${infoHash}_${mode}`;
}

/**
 * Parse a session key to extract infoHash and mode
 * Session key format: {infoHash}_{mode} where mode is 'copy', 'audio_only', or 'full'
 */
export function parseSessionKey(sessionKey: SessionKey): { infoHash: string; mode: TranscodeMode } {
  // Check for known suffixes in order of specificity (audio_only contains underscore)
  const modes: TranscodeMode[] = ['audio_only', 'copy', 'full'];
  for (const mode of modes) {
    const suffix = `_${mode}`;
    if (sessionKey.endsWith(suffix)) {
      return {
        infoHash: sessionKey.slice(0, -suffix.length),
        mode,
      };
    }
  }
  throw new Error(`Invalid session key: ${sessionKey}`);
}
