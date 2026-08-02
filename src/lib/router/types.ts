/**
 * Domain types for the notification router.
 *
 * Everything the engine consumes is described here. The engine itself is a pure
 * function of these types — it performs no I/O — which is what makes it cheap to
 * unit test and safe to run inside a request handler.
 */

// ---------------------------------------------------------------------------
// Output contract (fixed by the challenge specification)
// ---------------------------------------------------------------------------

/** The three routing decisions the router may emit. */
export const ACTIONS = ['notify', 'digest', 'mute'] as const;
export type Action = (typeof ACTIONS)[number];

/** The eleven permitted message categories. */
export const MESSAGE_TYPES = [
  'personal',
  'urgent',
  'event',
  'payment',
  'business_update',
  'promotion',
  'greeting',
  'forward',
  'spam',
  'scam',
  'unknown',
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

/** One row of `output.csv`. */
export interface Prediction {
  message_id: string;
  action: Action;
  message_type: MessageType;
  reason: string;
  confidence: number;
  /** Semicolon-joined historical message ids, or the literal string `none`. */
  evidence_message_ids: string;
}

// ---------------------------------------------------------------------------
// Dataset row types
// ---------------------------------------------------------------------------

export type ConversationType = 'personal' | 'group' | 'business';
export type MediaType = '' | 'image' | 'voice';

export interface Message {
  message_id: string;
  user_id: string;
  conversation_type: ConversationType;
  group_id: string;
  business_id: string;
  sender_user_id: string;
  /** `YYYY-MM-DD HH:mm` in the user's local time. */
  created_at: string;
  message_text: string;
  media_type: MediaType;
  media_id: string;
  forwarded_count: number;
}

/** A labelled example from `sample_messages.csv`. */
export interface LabelledMessage extends Message {
  action: Action;
  message_type: MessageType;
  reason: string;
  confidence: number;
  evidence_message_ids: string;
}

export interface User {
  user_id: string;
  /** `HH:mm-HH:mm`, may wrap past midnight. */
  do_not_disturb_window: string;
  messages_opened_30d: number;
  messages_replied_30d: number;
  notifications_dismissed_30d: number;
  messages_reported_30d: number;
}

export interface Group {
  group_id: string;
  group_name: string;
  group_type: string;
  member_count: number;
  admin_count: number;
  created_at: string;
  messages_30d: number;
}

export interface GroupMember {
  group_id: string;
  user_id: string;
  role: string;
  joined_at: string;
  messages_sent_30d: number;
  messages_read_30d: number;
  replies_sent_30d: number;
  notifications_dismissed_30d: number;
  group_muted_by_user: number;
}

export interface BusinessAccount {
  business_id: string;
  display_name: string;
  brand_name: string;
  category: string;
  verified: number;
  official_domain: string;
  domain_used_by_sender: string;
  account_age_days: number;
  messages_sent_30d: number;
  user_reports_30d: number;
  domain_used_by_sender_age_days: number;
}

export interface UserBusinessHistory {
  user_id: string;
  business_id: string;
  why_user_knows_account: string;
  last_activity_at: string;
  allows_promotions: number;
  promotions_opted_out_at: string;
  activity_count_180d: number;
  messages_opened_30d: number;
  messages_dismissed_30d: number;
  messages_replied_30d: number;
  last_reply_at: string;
}

/** A past message, same shape as an incoming one. */
export type HistoricalMessage = Message;

export interface MessageEvent {
  user_id: string;
  message_id: string;
  message_opened: number;
  message_replied: number;
  reaction_time_minutes: number | null;
  notification_dismissed: number;
  muted_after_message: number;
  message_reported: number;
}

export interface DailyNotificationSummary {
  user_id: string;
  date: string;
  notifications_sent: number;
  notifications_dismissed: number;
}

// ---------------------------------------------------------------------------
// Media analysis (derived from dataset/media, cached in media_analysis.json)
// ---------------------------------------------------------------------------

export interface ImageAnalysis {
  kind: string;
  description: string;
  ocr_text: string;
  detected_brands: string[];
  signals: string[];
}

export interface VoiceNoteAnalysis {
  language: string;
  language_probability: number;
  duration_sec: number;
  transcript: string;
  translation_en?: string;
  signals: string[];
}

export interface MediaAnalysis {
  images: Record<string, ImageAnalysis | undefined>;
  voice_notes: Record<string, VoiceNoteAnalysis | undefined>;
}

// ---------------------------------------------------------------------------
// The bundle the engine reads from
// ---------------------------------------------------------------------------

/**
 * All reference data, pre-indexed for O(1) lookup.
 *
 * Built once per run by {@link buildContext}. Routing 110 messages against a
 * 412-row history is only fast because these indexes exist — a naive
 * implementation rescans every table per message.
 */
export interface RouterContext {
  users: ReadonlyMap<string, User>;
  groups: ReadonlyMap<string, Group>;
  /** Keyed by `${group_id}::${user_id}`. */
  groupMembers: ReadonlyMap<string, GroupMember>;
  businesses: ReadonlyMap<string, BusinessAccount>;
  /** Keyed by `${user_id}::${business_id}`. */
  userBusiness: ReadonlyMap<string, UserBusinessHistory>;
  /** Every historical message, keyed by id. */
  history: ReadonlyMap<string, HistoricalMessage>;
  /** Historical messages grouped by recipient, newest first. */
  historyByUser: ReadonlyMap<string, readonly HistoricalMessage[]>;
  /** Interaction outcome keyed by `${user_id}::${message_id}`. */
  events: ReadonlyMap<string, MessageEvent>;
  /** Notification load per user over the trailing window. */
  loadByUser: ReadonlyMap<string, NotificationLoad>;
  media: MediaAnalysis;
}

export interface NotificationLoad {
  user_id: string;
  days: number;
  totalSent: number;
  totalDismissed: number;
  /** Mean notifications per day. */
  avgPerDay: number;
  /** Share of notifications the user dismissed, 0–1. */
  dismissRate: number;
}

// ---------------------------------------------------------------------------
// Engine intermediates
// ---------------------------------------------------------------------------

/**
 * A single named contribution to the decision.
 *
 * Every number the engine produces is attributable to one of these, which is
 * what the UI renders in the explainability panel and what makes a wrong
 * prediction debuggable rather than mysterious.
 */
export interface Signal {
  /** Stable machine-readable identifier, e.g. `risk.otp_request`. */
  code: string;
  /** One-line human explanation. */
  label: string;
  /** Contribution to the action score. Positive urges `notify`. */
  weight: number;
  /** Optional supporting detail shown on drill-down. */
  detail?: string;
}

/** Text extracted from all modalities, normalised for matching. */
export interface ResolvedContent {
  /** Sender-authored caption or body, with injection spans removed. */
  text: string;
  /** Literal text read off an attached image. */
  imageText: string;
  /**
   * Model-authored prose describing what the image depicts.
   *
   * Kept apart from {@link imageText} because the two serve different purposes:
   * the description is valuable for classification but is vocabulary the sender
   * never wrote, so including it in a similarity query buries the real overlap
   * with historical messages under words no historical message contains.
   */
  imageDescription: string;
  /** ASR transcript of an attached voice note, if any. */
  transcript: string;
  /** Everything fused and lowercased, for keyword matching. */
  haystack: string;
  /** Sender-authored text across modalities only, for similarity matching. */
  authored: string;
  /** Signals contributed by the media analysis. */
  mediaSignals: readonly string[];
  /** Spans that tried to give the router instructions, quarantined verbatim. */
  quarantined: readonly string[];
  /** Detected script/language hints, e.g. `devanagari`, `latin`. */
  scripts: readonly string[];
}

export interface EvidenceItem {
  message_id: string;
  score: number;
  reason: string;
  outcome: 'opened' | 'replied' | 'dismissed' | 'muted' | 'reported' | 'ignored';
}

/** The full, explainable result for one message. */
export interface RoutingDecision {
  prediction: Prediction;
  content: ResolvedContent;
  signals: readonly Signal[];
  /** Final score per action; the argmax becomes the decision. */
  scores: Record<Action, number>;
  /** Gap between the best and second-best action. Small ⇒ borderline. */
  margin: number;
  evidence: readonly EvidenceItem[];
  /** Set when a hard safety rule overrode the score-based decision. */
  override?: string;
  /** Set when the optional LLM adjudicator changed the outcome. */
  adjudication?: {
    applied: boolean;
    from: Action;
    to: Action;
    rationale: string;
  };
}
