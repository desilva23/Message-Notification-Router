/**
 * Builds the pre-indexed {@link RouterContext} the engine reads from.
 *
 * The engine looks up a user's history, a group membership or a business
 * relationship once per message per scorer. Against flat arrays that is a
 * linear scan each time and the whole run becomes quadratic; against these maps
 * it is constant. Paying for the indexing once, up front, is the difference
 * between routing the batch in milliseconds and in seconds.
 */

import type {
  BusinessAccount,
  DailyNotificationSummary,
  Group,
  GroupMember,
  HistoricalMessage,
  MediaAnalysis,
  MessageEvent,
  NotificationLoad,
  RouterContext,
  User,
  UserBusinessHistory,
} from './types';

export interface RawDataset {
  users: readonly User[];
  groups: readonly Group[];
  groupMembers: readonly GroupMember[];
  businesses: readonly BusinessAccount[];
  userBusiness: readonly UserBusinessHistory[];
  history: readonly HistoricalMessage[];
  events: readonly MessageEvent[];
  dailyNotifications: readonly DailyNotificationSummary[];
  media: MediaAnalysis;
}

/** Sorts newest-first by the `YYYY-MM-DD HH:mm` timestamps used throughout. */
function byNewest(a: HistoricalMessage, b: HistoricalMessage): number {
  return b.created_at.localeCompare(a.created_at);
}

function summariseLoad(rows: readonly DailyNotificationSummary[]): Map<string, NotificationLoad> {
  const byUser = new Map<string, DailyNotificationSummary[]>();
  for (const row of rows) {
    const bucket = byUser.get(row.user_id);
    if (bucket) bucket.push(row);
    else byUser.set(row.user_id, [row]);
  }

  const loads = new Map<string, NotificationLoad>();
  for (const [userId, days] of byUser) {
    const totalSent = days.reduce((sum, day) => sum + day.notifications_sent, 0);
    const totalDismissed = days.reduce((sum, day) => sum + day.notifications_dismissed, 0);
    loads.set(userId, {
      user_id: userId,
      days: days.length,
      totalSent,
      totalDismissed,
      avgPerDay: days.length > 0 ? totalSent / days.length : 0,
      dismissRate: totalSent > 0 ? totalDismissed / totalSent : 0,
    });
  }
  return loads;
}

export function buildContext(dataset: RawDataset): RouterContext {
  const historyByUser = new Map<string, HistoricalMessage[]>();
  for (const message of dataset.history) {
    const bucket = historyByUser.get(message.user_id);
    if (bucket) bucket.push(message);
    else historyByUser.set(message.user_id, [message]);
  }
  for (const bucket of historyByUser.values()) bucket.sort(byNewest);

  return {
    users: new Map(dataset.users.map((row) => [row.user_id, row])),
    groups: new Map(dataset.groups.map((row) => [row.group_id, row])),
    groupMembers: new Map(
      dataset.groupMembers.map((row) => [`${row.group_id}::${row.user_id}`, row]),
    ),
    businesses: new Map(dataset.businesses.map((row) => [row.business_id, row])),
    userBusiness: new Map(
      dataset.userBusiness.map((row) => [`${row.user_id}::${row.business_id}`, row]),
    ),
    history: new Map(dataset.history.map((row) => [row.message_id, row])),
    historyByUser,
    events: new Map(dataset.events.map((row) => [`${row.user_id}::${row.message_id}`, row])),
    loadByUser: summariseLoad(dataset.dailyNotifications),
    media: dataset.media,
  };
}
