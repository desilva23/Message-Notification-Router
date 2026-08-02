/**
 * Personalisation scoring.
 *
 * This is what makes two identical messages route differently for two different
 * users. The same resale poster is a `digest` for someone who reads and replies
 * in that marketplace group and a `mute` for someone who has dismissed the last
 * six things from it — the text is identical, only the relationship differs.
 *
 * Everything here returns weighted signals rather than a single number so the
 * UI can show *why* a given user got a given decision.
 */

import { DIRECT_ADDRESS } from './lexicons';
import type {
  Group,
  GroupMember,
  Message,
  ResolvedContent,
  RouterContext,
  Signal,
  User,
} from './types';

export interface TrustAssessment {
  /** Positive pushes towards `notify`, negative towards `mute`. */
  score: number;
  signals: Signal[];
  /** True when the sender holds an admin role in the originating group. */
  senderIsAdmin: boolean;
  /** True when the user has muted the originating group. */
  groupMuted: boolean;
  /** True when the message names this user explicitly. */
  directlyAddressed: boolean;
  /** True when the message arrived inside the user's do-not-disturb window. */
  inQuietHours: boolean;
}

/** Group types whose admin traffic is operational and time-sensitive. */
const OPERATIONAL_GROUPS = new Set([
  'society',
  'school_group',
  'coworker',
  'caregiving',
  'safety',
]);

/** Group types that exist for browsing, where nothing is urgent by default. */
const BROWSING_GROUPS = new Set([
  'marketplace',
  'local_food',
  'investment_tips',
  'real_estate',
  'tech_community',
  'alumni',
]);

/**
 * Parses `HH:mm-HH:mm`, which may wrap past midnight, and tests a timestamp
 * against it.
 */
export function isWithinQuietHours(window: string, timestamp: string): boolean {
  const bounds = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(window.trim());
  const clock = /\b(\d{1,2}):(\d{2})\b/.exec(timestamp);
  if (!bounds || !clock) return false;

  const toMinutes = (h: string | undefined, m: string | undefined): number =>
    Number(h ?? 0) * 60 + Number(m ?? 0);

  const start = toMinutes(bounds[1], bounds[2]);
  const end = toMinutes(bounds[3], bounds[4]);
  const at = toMinutes(clock[1], clock[2]);

  // A window like 22:00-07:00 wraps midnight, so the test inverts.
  return start <= end ? at >= start && at < end : at >= start || at < end;
}

function engagementRatio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return numerator / denominator;
}

/** Scores the user's standing with a group and the sender inside it. */
function assessGroup(
  message: Message,
  group: Group,
  membership: GroupMember | undefined,
  senderMembership: GroupMember | undefined,
): { score: number; signals: Signal[]; senderIsAdmin: boolean; groupMuted: boolean } {
  const signals: Signal[] = [];
  let score = 0;

  const senderIsAdmin = senderMembership?.role === 'admin';
  const groupMuted = membership?.group_muted_by_user === 1;

  if (senderIsAdmin) {
    const operational = OPERATIONAL_GROUPS.has(group.group_type);
    const weight = operational ? 0.34 : 0.16;
    score += weight;
    signals.push({
      code: 'trust.sender_is_admin',
      label: operational
        ? 'Sender is an admin of an operational group'
        : 'Sender is a group admin',
      weight,
      detail: `${group.group_name} (${group.group_type})`,
    });
  }

  if (OPERATIONAL_GROUPS.has(group.group_type)) {
    score += 0.1;
    signals.push({
      code: 'trust.operational_group',
      label: 'Group carries logistics the user usually needs to act on',
      weight: 0.1,
      detail: group.group_type,
    });
  }

  if (BROWSING_GROUPS.has(group.group_type)) {
    score -= 0.18;
    signals.push({
      code: 'trust.browsing_group',
      label: 'Group is for browsing, where nothing is urgent by default',
      weight: -0.18,
      detail: group.group_type,
    });
  }

  if (groupMuted) {
    // Muting is a strong statement, but the spec is explicit that a muted group
    // can still contain an urgent direct mention — so this is a heavy nudge,
    // never a veto. The direct-address bonus can still outrun it.
    score -= 0.3;
    signals.push({
      code: 'trust.group_muted',
      label: 'User has muted this group',
      weight: -0.3,
      detail: group.group_name,
    });
  }

  if (membership) {
    const readRate = engagementRatio(membership.messages_read_30d, group.messages_30d);
    const dismissals = membership.notifications_dismissed_30d;

    if (membership.replies_sent_30d >= 3) {
      score += 0.14;
      signals.push({
        code: 'trust.active_participant',
        label: 'User actively replies in this group',
        weight: 0.14,
        detail: `${membership.replies_sent_30d} replies in 30d`,
      });
    }

    if (dismissals >= 8) {
      score -= 0.24;
      signals.push({
        code: 'fatigue.group_dismissals',
        label: 'User dismisses most notifications from this group',
        weight: -0.24,
        detail: `${dismissals} dismissed in 30d`,
      });
    } else if (dismissals >= 4) {
      score -= 0.12;
      signals.push({
        code: 'fatigue.group_dismissals',
        label: 'User often dismisses notifications from this group',
        weight: -0.12,
        detail: `${dismissals} dismissed in 30d`,
      });
    }

    if (readRate < 0.02 && group.messages_30d > 100) {
      score -= 0.12;
      signals.push({
        code: 'fatigue.low_read_rate',
        label: 'User reads very little of this high-volume group',
        weight: -0.12,
        detail: `${membership.messages_read_30d} of ${group.messages_30d} messages`,
      });
    }
  }

  if (group.member_count > 150) {
    score -= 0.08;
    signals.push({
      code: 'trust.broadcast_group',
      label: 'Very large group, so messages are rarely aimed at one member',
      weight: -0.08,
      detail: `${group.member_count} members`,
    });
  }

  return { score, signals, senderIsAdmin, groupMuted };
}

/** Scores a direct one-to-one conversation. */
function assessPersonal(
  message: Message,
  context: RouterContext,
): { score: number; signals: Signal[] } {
  const signals: Signal[] = [];
  let score = 0;

  const history = context.historyByUser.get(message.user_id) ?? [];
  const fromSender = history.filter((past) => past.sender_user_id === message.sender_user_id);

  if (fromSender.length === 0) {
    score -= 0.1;
    signals.push({
      code: 'trust.unknown_sender',
      label: 'No prior history with this sender',
      weight: -0.1,
    });
    return { score, signals };
  }

  const replied = fromSender.filter(
    (past) => context.events.get(`${message.user_id}::${past.message_id}`)?.message_replied === 1,
  ).length;
  const opened = fromSender.filter(
    (past) => context.events.get(`${message.user_id}::${past.message_id}`)?.message_opened === 1,
  ).length;

  const replyRate = engagementRatio(replied, fromSender.length);
  const openRate = engagementRatio(opened, fromSender.length);

  if (replyRate >= 0.4) {
    score += 0.26;
    signals.push({
      code: 'trust.close_contact',
      label: 'User replies to most messages from this sender',
      weight: 0.26,
      detail: `${replied} of ${fromSender.length} replied`,
    });
  } else if (openRate >= 0.6) {
    score += 0.12;
    signals.push({
      code: 'trust.opened_contact',
      label: 'User reliably opens messages from this sender',
      weight: 0.12,
      detail: `${opened} of ${fromSender.length} opened`,
    });
  } else if (openRate <= 0.2) {
    score -= 0.16;
    signals.push({
      code: 'fatigue.ignored_sender',
      label: 'User usually ignores this sender',
      weight: -0.16,
      detail: `${opened} of ${fromSender.length} opened`,
    });
  }

  return { score, signals };
}

/** Scores a business sender against the user's commercial relationship. */
function assessBusiness(
  message: Message,
  context: RouterContext,
): { score: number; signals: Signal[] } {
  const signals: Signal[] = [];
  let score = 0;

  const relationship = context.userBusiness.get(`${message.user_id}::${message.business_id}`);
  const business = context.businesses.get(message.business_id);

  if (business?.verified) {
    score += 0.14;
    signals.push({
      code: 'trust.verified_business',
      label: 'Business account is verified',
      weight: 0.14,
      detail: business.display_name,
    });
  }

  if (!relationship) {
    score -= 0.16;
    signals.push({
      code: 'trust.no_business_relationship',
      label: 'User has no recorded relationship with this business',
      weight: -0.16,
    });
    return { score, signals };
  }

  if (relationship.promotions_opted_out_at) {
    score -= 0.34;
    signals.push({
      code: 'fatigue.opted_out',
      label: 'User opted out of promotions from this business',
      weight: -0.34,
      detail: `opted out ${relationship.promotions_opted_out_at}`,
    });
  } else if (relationship.allows_promotions === 1) {
    score += 0.12;
    signals.push({
      code: 'trust.opted_in',
      label: 'User opted in to messages from this business',
      weight: 0.12,
    });
  }

  if (relationship.activity_count_180d >= 2) {
    score += 0.2;
    signals.push({
      code: 'trust.recent_transaction',
      label: 'User has recent activity with this business',
      weight: 0.2,
      detail: `${relationship.why_user_knows_account} (${relationship.activity_count_180d} in 180d)`,
    });
  }

  const dismissed = relationship.messages_dismissed_30d;
  const opened = relationship.messages_opened_30d;
  if (dismissed >= 5 && dismissed > opened) {
    score -= 0.28;
    signals.push({
      code: 'fatigue.business_dismissals',
      label: 'User repeatedly dismisses messages from this business',
      weight: -0.28,
      detail: `${dismissed} dismissed vs ${opened} opened in 30d`,
    });
  } else if (opened >= 4 && opened > dismissed) {
    score += 0.12;
    signals.push({
      code: 'trust.business_engagement',
      label: 'User usually opens messages from this business',
      weight: 0.12,
      detail: `${opened} opened vs ${dismissed} dismissed in 30d`,
    });
  }

  return { score, signals };
}

/** Global notification-load pressure, independent of this conversation. */
function assessLoad(user: User | undefined, context: RouterContext, userId: string): Signal[] {
  const signals: Signal[] = [];
  const load = context.loadByUser.get(userId);

  if (load && load.dismissRate >= 0.5 && load.avgPerDay >= 3) {
    signals.push({
      code: 'fatigue.notification_overload',
      label: 'User is already dismissing most of a heavy notification load',
      weight: -0.12,
      detail: `${load.avgPerDay.toFixed(1)}/day, ${Math.round(load.dismissRate * 100)}% dismissed`,
    });
  }

  if (user && user.messages_reported_30d >= 4) {
    signals.push({
      code: 'trust.cautious_user',
      label: 'User reports unwanted messages frequently',
      weight: -0.06,
      detail: `${user.messages_reported_30d} reports in 30d`,
    });
  }

  return signals;
}

/** Full personalisation assessment for one message. */
export function assessTrust(
  message: Message,
  content: ResolvedContent,
  context: RouterContext,
): TrustAssessment {
  const signals: Signal[] = [];
  let score = 0;
  let senderIsAdmin = false;
  let groupMuted = false;

  const user = context.users.get(message.user_id);

  if (message.conversation_type === 'group' && message.group_id) {
    const group = context.groups.get(message.group_id);
    if (group) {
      const membership = context.groupMembers.get(`${message.group_id}::${message.user_id}`);
      const senderMembership = message.sender_user_id
        ? context.groupMembers.get(`${message.group_id}::${message.sender_user_id}`)
        : undefined;
      const result = assessGroup(message, group, membership, senderMembership);
      score += result.score;
      signals.push(...result.signals);
      senderIsAdmin = result.senderIsAdmin;
      groupMuted = result.groupMuted;
    }
  } else if (message.conversation_type === 'personal') {
    const result = assessPersonal(message, context);
    score += result.score;
    signals.push(...result.signals);
  } else if (message.conversation_type === 'business' && message.business_id) {
    const result = assessBusiness(message, context);
    score += result.score;
    signals.push(...result.signals);
  }

  // A direct @mention is the single strongest personalisation signal there is:
  // it is the case the specification calls out as able to survive a muted group.
  const directlyAddressed =
    DIRECT_ADDRESS.patterns.some((pattern) => pattern.test(content.text)) &&
    new RegExp(`@${message.user_id}\\b`, 'i').test(content.text);

  if (directlyAddressed) {
    score += 0.42;
    signals.push({
      code: 'trust.direct_mention',
      label: 'Message mentions this user by name',
      weight: 0.42,
    });
  }

  const loadSignals = assessLoad(user, context, message.user_id);
  for (const signal of loadSignals) score += signal.weight;
  signals.push(...loadSignals);

  const inQuietHours = user
    ? isWithinQuietHours(user.do_not_disturb_window, message.created_at)
    : false;

  if (inQuietHours) {
    // Quiet hours defer the merely useful; they never suppress a genuine
    // emergency, so this is a modest nudge applied before the urgency bonus.
    score -= 0.14;
    signals.push({
      code: 'fatigue.quiet_hours',
      label: 'Message arrived during the user’s do-not-disturb window',
      weight: -0.14,
      detail: user?.do_not_disturb_window,
    });
  }

  return { score, signals, senderIsAdmin, groupMuted, directlyAddressed, inQuietHours };
}
