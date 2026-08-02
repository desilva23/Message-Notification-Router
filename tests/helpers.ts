/**
 * Shared test fixtures.
 *
 * Provides both a hand-built minimal context — for unit tests that need to
 * isolate one variable — and the real dataset, loaded once and cached, for
 * tests that assert on end-to-end behaviour.
 */

import { buildContext } from '../src/lib/router/context';
import { loadContext, loadMessages, loadSampleMessages } from '../src/lib/data/load';
import type {
  BusinessAccount,
  Group,
  GroupMember,
  MediaAnalysis,
  Message,
  MessageEvent,
  RouterContext,
  User,
  UserBusinessHistory,
} from '../src/lib/router/types';

export function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    message_id: 'msg_test',
    user_id: 'u_001',
    conversation_type: 'personal',
    group_id: '',
    business_id: '',
    sender_user_id: 'u_100',
    created_at: '2026-07-30 14:00',
    message_text: '',
    media_type: '',
    media_id: '',
    forwarded_count: 0,
    ...overrides,
  };
}

export function makeUser(overrides: Partial<User> = {}): User {
  return {
    user_id: 'u_001',
    do_not_disturb_window: '22:00-07:00',
    messages_opened_30d: 40,
    messages_replied_30d: 10,
    notifications_dismissed_30d: 10,
    messages_reported_30d: 1,
    ...overrides,
  };
}

export function makeGroup(overrides: Partial<Group> = {}): Group {
  return {
    group_id: 'group_001',
    group_name: 'Test Group',
    group_type: 'society',
    member_count: 50,
    admin_count: 2,
    created_at: '2024-01-01',
    messages_30d: 200,
    ...overrides,
  };
}

export function makeMember(overrides: Partial<GroupMember> = {}): GroupMember {
  return {
    group_id: 'group_001',
    user_id: 'u_001',
    role: 'member',
    joined_at: '2024-01-01',
    messages_sent_30d: 2,
    messages_read_30d: 30,
    replies_sent_30d: 1,
    notifications_dismissed_30d: 1,
    group_muted_by_user: 0,
    ...overrides,
  };
}

export function makeBusiness(overrides: Partial<BusinessAccount> = {}): BusinessAccount {
  return {
    business_id: 'business_001',
    display_name: 'Test Brand',
    brand_name: 'Test Brand',
    category: 'ecommerce_delivery',
    verified: 1,
    official_domain: 'test.com',
    domain_used_by_sender: 'test.com',
    account_age_days: 900,
    messages_sent_30d: 500,
    user_reports_30d: 2,
    domain_used_by_sender_age_days: 800,
    ...overrides,
  };
}

export function makeRelationship(
  overrides: Partial<UserBusinessHistory> = {},
): UserBusinessHistory {
  return {
    user_id: 'u_001',
    business_id: 'business_001',
    why_user_knows_account: 'recent_order',
    last_activity_at: '2026-07-20 10:00',
    allows_promotions: 0,
    promotions_opted_out_at: '',
    activity_count_180d: 3,
    messages_opened_30d: 4,
    messages_dismissed_30d: 1,
    messages_replied_30d: 0,
    last_reply_at: '',
    ...overrides,
  };
}

export function makeEvent(overrides: Partial<MessageEvent> = {}): MessageEvent {
  return {
    user_id: 'u_001',
    message_id: 'message_0001',
    message_opened: 1,
    message_replied: 0,
    reaction_time_minutes: 5,
    notification_dismissed: 0,
    muted_after_message: 0,
    message_reported: 0,
    ...overrides,
  };
}

export const EMPTY_MEDIA: MediaAnalysis = { images: {}, voice_notes: {} };

/** Builds a context from only the pieces a given test cares about. */
export function makeContext(parts: {
  users?: User[];
  groups?: Group[];
  groupMembers?: GroupMember[];
  businesses?: BusinessAccount[];
  userBusiness?: UserBusinessHistory[];
  history?: Message[];
  events?: MessageEvent[];
  media?: MediaAnalysis;
} = {}): RouterContext {
  return buildContext({
    users: parts.users ?? [makeUser()],
    groups: parts.groups ?? [],
    groupMembers: parts.groupMembers ?? [],
    businesses: parts.businesses ?? [],
    userBusiness: parts.userBusiness ?? [],
    history: parts.history ?? [],
    events: parts.events ?? [],
    dailyNotifications: [],
    media: parts.media ?? EMPTY_MEDIA,
  });
}

// The real dataset is read from disk once and shared; loading it per test file
// would dominate the suite's runtime for no benefit.
let cachedContext: RouterContext | null = null;

export function realContext(): RouterContext {
  cachedContext ??= loadContext();
  return cachedContext;
}

export const realMessages = (): Message[] => loadMessages();
export const realSamples = () => loadSampleMessages();
