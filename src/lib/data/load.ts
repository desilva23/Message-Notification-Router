/**
 * Dataset loading from the bundled CSV snapshot.
 *
 * This is the source of truth for the CLI and the fallback for the web app when
 * Supabase is not configured. Keeping a working offline path is deliberate: the
 * submission contract requires the solution to be runnable from a terminal
 * against `dataset/`, and a reviewer cloning the repo has no credentials.
 *
 * Node-only — imports `node:fs`. Never pull this into a client component.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCsv } from './csv';
import {
  toBusinessAccount,
  toDailyNotificationSummary,
  toGroup,
  toGroupMember,
  toLabelledMessage,
  toMessage,
  toMessageEvent,
  toUser,
  toUserBusinessHistory,
} from './schema';
import { buildContext, type RawDataset } from '../router/context';
import type {
  LabelledMessage,
  MediaAnalysis,
  Message,
  RouterContext,
} from '../router/types';

/** Absolute path to the dataset directory. */
export function datasetDir(root: string = process.cwd()): string {
  return join(root, 'dataset');
}

function readCsv(dir: string, file: string): Record<string, string>[] {
  return parseCsv(readFileSync(join(dir, file), 'utf8'));
}

function readMediaAnalysis(dir: string): MediaAnalysis {
  const parsed = JSON.parse(readFileSync(join(dir, 'media_analysis.json'), 'utf8')) as Partial<MediaAnalysis>;
  return {
    images: parsed.images ?? {},
    voice_notes: parsed.voice_notes ?? {},
  };
}

/** Loads every reference table and returns the un-indexed rows. */
export function loadRawDataset(dir: string = datasetDir()): RawDataset {
  return {
    users: readCsv(dir, 'users.csv').map(toUser),
    groups: readCsv(dir, 'groups.csv').map(toGroup),
    groupMembers: readCsv(dir, 'group_members.csv').map(toGroupMember),
    businesses: readCsv(dir, 'business_accounts.csv').map(toBusinessAccount),
    userBusiness: readCsv(dir, 'user_business_history.csv').map(toUserBusinessHistory),
    history: readCsv(dir, 'message_history.csv').map(toMessage),
    events: readCsv(dir, 'message_events.csv').map(toMessageEvent),
    dailyNotifications: readCsv(dir, 'daily_notification_summary.csv').map(toDailyNotificationSummary),
    media: readMediaAnalysis(dir),
  };
}

/** Loads and indexes the dataset, ready for the engine. */
export function loadContext(dir: string = datasetDir()): RouterContext {
  return buildContext(loadRawDataset(dir));
}

/** The messages that require predictions. */
export function loadMessages(dir: string = datasetDir()): Message[] {
  return readCsv(dir, 'messages.csv').map(toMessage);
}

/** The solved examples, used by the evaluation harness and the golden tests. */
export function loadSampleMessages(dir: string = datasetDir()): LabelledMessage[] {
  return readCsv(dir, 'sample_messages.csv').map(toLabelledMessage);
}

/** Image and voice-note file paths, for the media viewer. */
export function loadMediaPaths(dir: string = datasetDir()): {
  images: Record<string, string>;
  voiceNotes: Record<string, string>;
} {
  const images: Record<string, string> = {};
  for (const row of readCsv(dir, 'images.csv')) {
    const id = row.image_id;
    if (id) images[id] = row.file_path ?? '';
  }

  const voiceNotes: Record<string, string> = {};
  for (const row of readCsv(dir, 'voice_notes.csv')) {
    const id = row.voice_note_id;
    if (id) voiceNotes[id] = row.file_path ?? '';
  }

  return { images, voiceNotes };
}
