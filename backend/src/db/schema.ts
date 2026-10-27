import { boolean, integer, numeric, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';

export const favourites = pgTable('favourites', {
  id: serial('id').primaryKey(),
  movieId: integer('movie_id').notNull().unique(),
  title: text('title').notNull(),
  posterUrl: text('poster_url'),
  releaseYear: integer('release_year'),
  rating: numeric('rating', { precision: 3, scale: 1 }).notNull(),
  overview: text('overview').notNull(),
  addedAt: timestamp('added_at').notNull().defaultNow(),
});

export const transcodeJobs = pgTable('transcode_jobs', {
  id: serial('id').primaryKey(),
  infoHash: text('info_hash').notNull().unique(),
  filePath: text('file_path').notNull(),
  sessionKey: text('session_key').notNull(),
  transcodeMode: text('transcode_mode').notNull(), // 'copy' | 'audio_only' | 'full'
  videoAction: text('video_action').notNull(), // 'copy' | 'transcode'
  audioAction: text('audio_action').notNull(), // 'copy' | 'transcode'
  segmentDuration: integer('segment_duration').notNull(),
  totalSegments: integer('total_segments').notNull(),
  highestGeneratedSegment: integer('highest_generated_segment').notNull().default(-1),
  totalDuration: numeric('total_duration', { precision: 10, scale: 2 }).notNull(),
  streamingMode: text('streaming_mode').notNull(), // 'hls' | 'native'
  containerFormat: text('container_format').notNull(),
  useIncompleteFileFlags: boolean('use_incomplete_file_flags').notNull().default(false),
  status: text('status').notNull().default('pending'), // 'pending' | 'in_progress' | 'completed' | 'failed'
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export type Favourite = typeof favourites.$inferSelect;
export type NewFavourite = typeof favourites.$inferInsert;

export type TranscodeJob = typeof transcodeJobs.$inferSelect;
export type NewTranscodeJob = typeof transcodeJobs.$inferInsert;
