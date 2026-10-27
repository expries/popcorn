import { eq } from 'drizzle-orm';

import { db, transcodeJobs, type NewTranscodeJob, type TranscodeJob } from '../db';
import type { HlsSession, TranscodeMode } from '../hls/types';
import { createLogger } from '../utils/logger';

const log = createLogger('TranscodeJob');

export type TranscodeStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface TranscodeJobInfo {
  infoHash: string;
  sessionKey: string;
  transcodeMode: TranscodeMode;
  highestGeneratedSegment: number;
  totalSegments: number;
  totalDuration: number;
  status: TranscodeStatus;
  streamingMode: 'hls' | 'native';
}

function toTranscodeJobInfo(row: TranscodeJob): TranscodeJobInfo {
  return {
    infoHash: row.infoHash,
    sessionKey: row.sessionKey,
    transcodeMode: row.transcodeMode as TranscodeMode,
    highestGeneratedSegment: row.highestGeneratedSegment,
    totalSegments: row.totalSegments,
    totalDuration: Number(row.totalDuration),
    status: row.status as TranscodeStatus,
    streamingMode: row.streamingMode as 'hls' | 'native',
  };
}

class TranscodeJobManager {
  async createOrUpdateJob(session: HlsSession): Promise<TranscodeJobInfo> {
    const existing = await db
      .select()
      .from(transcodeJobs)
      .where(eq(transcodeJobs.infoHash, session.infoHash))
      .limit(1);

    const jobData: NewTranscodeJob = {
      infoHash: session.infoHash,
      filePath: session.filePath,
      sessionKey: session.sessionKey,
      transcodeMode: session.decision.mode,
      videoAction: session.decision.videoAction,
      audioAction: session.decision.audioAction,
      segmentDuration: session.segmentDuration,
      totalSegments: session.totalSegments,
      highestGeneratedSegment: session.highestGeneratedSegment,
      totalDuration: String(session.totalDuration),
      streamingMode: session.streamingMode,
      containerFormat: session.containerFormat,
      useIncompleteFileFlags: session.useIncompleteFileFlags,
      status: session.isGenerating ? 'in_progress' : 'pending',
    };

    if (existing.length > 0) {
      const [updated] = await db
        .update(transcodeJobs)
        .set({
          ...jobData,
          updatedAt: new Date(),
        })
        .where(eq(transcodeJobs.infoHash, session.infoHash))
        .returning();

      return toTranscodeJobInfo(updated);
    }

    const [inserted] = await db.insert(transcodeJobs).values(jobData).returning();
    log.info(`Created job for ${session.infoHash}`);
    return toTranscodeJobInfo(inserted);
  }

  async updateSegmentProgress(infoHash: string, highestSegment: number): Promise<void> {
    await db
      .update(transcodeJobs)
      .set({
        highestGeneratedSegment: highestSegment,
        updatedAt: new Date(),
      })
      .where(eq(transcodeJobs.infoHash, infoHash));
  }

  async updateStatus(infoHash: string, status: TranscodeStatus): Promise<void> {
    await db
      .update(transcodeJobs)
      .set({
        status,
        updatedAt: new Date(),
      })
      .where(eq(transcodeJobs.infoHash, infoHash));
  }

  async markInProgress(infoHash: string): Promise<void> {
    await this.updateStatus(infoHash, 'in_progress');
  }

  async markCompleted(infoHash: string): Promise<void> {
    await this.updateStatus(infoHash, 'completed');
  }

  async markFailed(infoHash: string): Promise<void> {
    await this.updateStatus(infoHash, 'failed');
  }

  async getJob(infoHash: string): Promise<TranscodeJobInfo | null> {
    const result = await db
      .select()
      .from(transcodeJobs)
      .where(eq(transcodeJobs.infoHash, infoHash))
      .limit(1);

    return result.length > 0 ? toTranscodeJobInfo(result[0]) : null;
  }

  async getIncompleteJobs(): Promise<TranscodeJob[]> {
    return db
      .select()
      .from(transcodeJobs)
      .where(eq(transcodeJobs.status, 'in_progress'));
  }

  async getAllJobs(): Promise<TranscodeJobInfo[]> {
    const rows = await db.select().from(transcodeJobs);
    return rows.map(toTranscodeJobInfo);
  }

  async getJobsByInfoHashes(infoHashes: string[]): Promise<Map<string, TranscodeJobInfo>> {
    if (infoHashes.length === 0) {
      return new Map();
    }

    const rows = await db.select().from(transcodeJobs);
    const map = new Map<string, TranscodeJobInfo>();

    for (const row of rows) {
      if (infoHashes.includes(row.infoHash)) {
        map.set(row.infoHash, toTranscodeJobInfo(row));
      }
    }

    return map;
  }

  async deleteJob(infoHash: string): Promise<boolean> {
    const result = await db
      .delete(transcodeJobs)
      .where(eq(transcodeJobs.infoHash, infoHash))
      .returning();

    return result.length > 0;
  }
}

export const transcodeJobManager = new TranscodeJobManager();
