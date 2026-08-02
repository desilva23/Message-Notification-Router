/**
 * Row coercion from raw CSV cells (or Supabase rows) into domain types.
 *
 * Every field is coerced explicitly rather than cast. CSV has no types, so an
 * unchecked cast would let `"abc"` flow into a numeric field and surface much
 * later as a `NaN` in a score. Coercing at the boundary keeps the engine's type
 * signatures honest.
 */

import { toFloat, toInt, toNullableInt } from './csv';
import type {
  BusinessAccount,
  ConversationType,
  DailyNotificationSummary,
  Group,
  GroupMember,
  LabelledMessage,
  MediaType,
  Message,
  MessageEvent,
  User,
  UserBusinessHistory,
} from '../router/types';
import { ACTIONS, MESSAGE_TYPES } from '../router/types';

type Row = Record<string, string | number | null | undefined>;

const str = (row: Row, key: string): string => {
  const value = row[key];
  return value === null || value === undefined ? '' : String(value);
};

const int = (row: Row, key: string): number => toInt(str(row, key));
const float = (row: Row, key: string): number => toFloat(str(row, key));

/** Narrows a free-form cell to a known conversation type. */
function toConversationType(value: string): ConversationType {
  return value === 'group' || value === 'business' ? value : 'personal';
}

/** Narrows a free-form cell to a known media type. */
function toMediaType(value: string): MediaType {
  return value === 'image' || value === 'voice' ? value : '';
}

export function toMessage(row: Row): Message {
  return {
    message_id: str(row, 'message_id'),
    user_id: str(row, 'user_id'),
    conversation_type: toConversationType(str(row, 'conversation_type')),
    group_id: str(row, 'group_id'),
    business_id: str(row, 'business_id'),
    sender_user_id: str(row, 'sender_user_id'),
    created_at: str(row, 'created_at'),
    message_text: str(row, 'message_text'),
    media_type: toMediaType(str(row, 'media_type')),
    media_id: str(row, 'media_id'),
    forwarded_count: int(row, 'forwarded_count'),
  };
}

export function toLabelledMessage(row: Row): LabelledMessage {
  const action = str(row, 'action');
  const messageType = str(row, 'message_type');
  return {
    ...toMessage(row),
    action: (ACTIONS as readonly string[]).includes(action)
      ? (action as LabelledMessage['action'])
      : 'digest',
    message_type: (MESSAGE_TYPES as readonly string[]).includes(messageType)
      ? (messageType as LabelledMessage['message_type'])
      : 'unknown',
    reason: str(row, 'reason'),
    confidence: float(row, 'confidence'),
    evidence_message_ids: str(row, 'evidence_message_ids'),
  };
}

export function toUser(row: Row): User {
  return {
    user_id: str(row, 'user_id'),
    do_not_disturb_window: str(row, 'do_not_disturb_window'),
    messages_opened_30d: int(row, 'messages_opened_30d'),
    messages_replied_30d: int(row, 'messages_replied_30d'),
    notifications_dismissed_30d: int(row, 'notifications_dismissed_30d'),
    messages_reported_30d: int(row, 'messages_reported_30d'),
  };
}

export function toGroup(row: Row): Group {
  return {
    group_id: str(row, 'group_id'),
    group_name: str(row, 'group_name'),
    group_type: str(row, 'group_type'),
    member_count: int(row, 'member_count'),
    admin_count: int(row, 'admin_count'),
    created_at: str(row, 'created_at'),
    messages_30d: int(row, 'messages_30d'),
  };
}

export function toGroupMember(row: Row): GroupMember {
  return {
    group_id: str(row, 'group_id'),
    user_id: str(row, 'user_id'),
    role: str(row, 'role'),
    joined_at: str(row, 'joined_at'),
    messages_sent_30d: int(row, 'messages_sent_30d'),
    messages_read_30d: int(row, 'messages_read_30d'),
    replies_sent_30d: int(row, 'replies_sent_30d'),
    notifications_dismissed_30d: int(row, 'notifications_dismissed_30d'),
    group_muted_by_user: int(row, 'group_muted_by_user'),
  };
}

export function toBusinessAccount(row: Row): BusinessAccount {
  return {
    business_id: str(row, 'business_id'),
    display_name: str(row, 'display_name'),
    brand_name: str(row, 'brand_name'),
    category: str(row, 'category'),
    verified: int(row, 'verified'),
    official_domain: str(row, 'official_domain'),
    domain_used_by_sender: str(row, 'domain_used_by_sender'),
    account_age_days: int(row, 'account_age_days'),
    messages_sent_30d: int(row, 'messages_sent_30d'),
    user_reports_30d: int(row, 'user_reports_30d'),
    domain_used_by_sender_age_days: int(row, 'domain_used_by_sender_age_days'),
  };
}

export function toUserBusinessHistory(row: Row): UserBusinessHistory {
  return {
    user_id: str(row, 'user_id'),
    business_id: str(row, 'business_id'),
    why_user_knows_account: str(row, 'why_user_knows_account'),
    last_activity_at: str(row, 'last_activity_at'),
    allows_promotions: int(row, 'allows_promotions'),
    promotions_opted_out_at: str(row, 'promotions_opted_out_at'),
    activity_count_180d: int(row, 'activity_count_180d'),
    messages_opened_30d: int(row, 'messages_opened_30d'),
    messages_dismissed_30d: int(row, 'messages_dismissed_30d'),
    messages_replied_30d: int(row, 'messages_replied_30d'),
    last_reply_at: str(row, 'last_reply_at'),
  };
}

export function toMessageEvent(row: Row): MessageEvent {
  return {
    user_id: str(row, 'user_id'),
    message_id: str(row, 'message_id'),
    message_opened: int(row, 'message_opened'),
    message_replied: int(row, 'message_replied'),
    reaction_time_minutes: toNullableInt(str(row, 'reaction_time_minutes')),
    notification_dismissed: int(row, 'notification_dismissed'),
    muted_after_message: int(row, 'muted_after_message'),
    message_reported: int(row, 'message_reported'),
  };
}

export function toDailyNotificationSummary(row: Row): DailyNotificationSummary {
  return {
    user_id: str(row, 'user_id'),
    date: str(row, 'date'),
    notifications_sent: int(row, 'notifications_sent'),
    notifications_dismissed: int(row, 'notifications_dismissed'),
  };
}
