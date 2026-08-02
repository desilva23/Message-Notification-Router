/**
 * Unit tests for the individual scorers.
 *
 * Each test isolates one variable against an otherwise-identical context, so a
 * failure names the specific rule that broke rather than just reporting that
 * some end-to-end number moved.
 */

import { describe, expect, it } from 'vitest';
import { detectScripts, looksHinglish, resolveContent } from '../src/lib/router/content';
import { calibrateConfidence, permittedConfidences } from '../src/lib/router/confidence';
import { assessIntent } from '../src/lib/router/intent';
import { assessBusinessIdentity } from '../src/lib/router/risk';
import { jaccard, SimilarityIndex, tokenize } from '../src/lib/router/similarity';
import { assessTrust, isWithinQuietHours } from '../src/lib/router/trust';
import {
  EMPTY_MEDIA,
  makeBusiness,
  makeContext,
  makeGroup,
  makeMember,
  makeMessage,
  makeRelationship,
  makeUser,
} from './helpers';

const content = (text: string) => resolveContent(makeMessage({ message_text: text }), EMPTY_MEDIA);

describe('quiet hours', () => {
  it('handles a window that wraps midnight', () => {
    expect(isWithinQuietHours('22:00-07:00', '2026-07-30 23:30')).toBe(true);
    expect(isWithinQuietHours('22:00-07:00', '2026-07-30 03:00')).toBe(true);
    expect(isWithinQuietHours('22:00-07:00', '2026-07-30 12:00')).toBe(false);
  });

  it('handles a same-day window', () => {
    expect(isWithinQuietHours('09:00-17:00', '2026-07-30 12:00')).toBe(true);
    expect(isWithinQuietHours('09:00-17:00', '2026-07-30 20:00')).toBe(false);
  });

  it('treats the boundaries as half-open', () => {
    expect(isWithinQuietHours('22:00-07:00', '2026-07-30 22:00')).toBe(true);
    expect(isWithinQuietHours('22:00-07:00', '2026-07-30 07:00')).toBe(false);
  });

  it('returns false for a malformed window rather than throwing', () => {
    expect(isWithinQuietHours('', '2026-07-30 12:00')).toBe(false);
    expect(isWithinQuietHours('nonsense', '2026-07-30 12:00')).toBe(false);
  });
});

describe('business identity', () => {
  it('clears a verified brand on its official domain', () => {
    const result = assessBusinessIdentity(makeBusiness(), makeRelationship());
    expect(result.impersonation).toBe(false);
    expect(result.score).toBeLessThan(0.2);
  });

  it('flags an unverified lookalike with a fresh domain and many reports', () => {
    const result = assessBusinessIdentity(
      makeBusiness({
        display_name: 'HDFC Bank Helpdesk',
        category: 'bank',
        verified: 0,
        official_domain: 'hdfc.bank.in',
        domain_used_by_sender: 'hdfcbank-kyc.in',
        account_age_days: 20,
        domain_used_by_sender_age_days: 17,
        user_reports_30d: 38,
      }),
      undefined,
    );
    expect(result.impersonation).toBe(true);
    expect(result.score).toBeGreaterThan(0.7);
  });

  it('does not call a verified brand on a campaign domain an impersonator', () => {
    // One failure is not a pattern — verified brands legitimately use link
    // shorteners and campaign domains.
    const result = assessBusinessIdentity(
      makeBusiness({
        verified: 1,
        official_domain: 'thrillophilia.com',
        domain_used_by_sender: 'link.wame.pro',
        account_age_days: 4304,
        domain_used_by_sender_age_days: 3368,
        user_reports_30d: 4,
      }),
      undefined,
    );
    expect(result.impersonation).toBe(false);
  });
});

describe('intent', () => {
  it('detects explicit urgency', () => {
    expect(assessIntent(content('Call me now, I need to decide in the next ten minutes.')).isUrgent).toBe(true);
    expect(assessIntent(content('Tanker is leaving in 20 mins, fill water now.')).isUrgent).toBe(true);
  });

  it('honours the sender saying it can wait', () => {
    const result = assessIntent(content('No rush at all, read it whenever you get time.'));
    expect(result.isDeferrable).toBe(true);
    expect(result.isUrgent).toBe(false);
  });

  it('lets "no rush" cancel urgency wording', () => {
    const result = assessIntent(content('Can you check the doc tomorrow morning? Nothing urgent.'));
    expect(result.isUrgent).toBe(false);
  });

  it('still records the ask when the sender softens it', () => {
    const result = assessIntent(content('When you get 5 mins can you call? Nothing dramatic.'));
    expect(result.requestsResponse).toBe(true);
    expect(result.isDeferrable).toBe(true);
  });

  it('separates "happening today" from "act right now"', () => {
    const result = assessIntent(content('Your parcel is arriving today between 2 and 4 PM.'));
    expect(result.isTimeAnchored).toBe(true);
    expect(result.isUrgent).toBe(false);
  });

  it('treats a standing-by request as urgent', () => {
    // Being asked to stay available *is* the interruption; deferring it to a
    // digest defeats the request entirely.
    expect(
      assessIntent(content('Please stay online for the next 30 minutes while we drain the queue.'))
        .isUrgent,
    ).toBe(true);
    expect(assessIntent(content('Can you stay near your laptop for the release window?')).isUrgent).toBe(
      true,
    );
  });

  it('matches a countdown phrased either way round', () => {
    expect(assessIntent(content('Escalation starts in the next 20 minutes.')).isUrgent).toBe(true);
    expect(assessIntent(content('Please hold the line for the next 10 mins.')).isUrgent).toBe(true);
  });

  it('flags a direct ask carrying a same-day deadline', () => {
    const codes = assessIntent(
      content('Can you collect it from Gate 2 by 6 PM? Tell me honestly if you cannot make it.'),
    ).signals.map((signal) => signal.code);
    expect(codes).toContain('intent.same_day_deadline');
  });

  it('does not flag a bare timetable with no ask', () => {
    const codes = assessIntent(content('The library closes by 8 PM on weekdays.')).signals.map(
      (signal) => signal.code,
    );
    expect(codes).not.toContain('intent.same_day_deadline');
  });
});

describe('trust', () => {
  const groupContext = (member: Parameters<typeof makeMember>[0], senderRole = 'admin') =>
    makeContext({
      groups: [makeGroup({ group_type: 'society', messages_30d: 700, member_count: 180 })],
      groupMembers: [
        makeMember({ user_id: 'u_001', ...member }),
        makeMember({ user_id: 'u_099', role: senderRole }),
      ],
    });

  const groupMessage = (text: string) =>
    makeMessage({
      conversation_type: 'group',
      group_id: 'group_001',
      sender_user_id: 'u_099',
      message_text: text,
    });

  it('raises trust for an admin in an operational group', () => {
    const message = groupMessage('Maintenance closes at 5 PM today.');
    const result = assessTrust(message, content(message.message_text), groupContext({}));
    expect(result.senderIsAdmin).toBe(true);
    expect(result.score).toBeGreaterThan(0);
  });

  it('lowers trust when the user has muted the group', () => {
    const message = groupMessage('Society notice.');
    const muted = assessTrust(message, content(message.message_text), groupContext({ group_muted_by_user: 1 }));
    const unmuted = assessTrust(message, content(message.message_text), groupContext({}));
    expect(muted.groupMuted).toBe(true);
    expect(muted.score).toBeLessThan(unmuted.score);
  });

  it('recognises a mention of this user and not of another', () => {
    const mine = groupMessage('@u_001 can you confirm?');
    const theirs = groupMessage('@u_042 can you confirm?');
    expect(assessTrust(mine, content(mine.message_text), groupContext({})).directlyAddressed).toBe(true);
    expect(assessTrust(theirs, content(theirs.message_text), groupContext({})).directlyAddressed).toBe(false);
  });

  it('penalises a business the user opted out of', () => {
    const message = makeMessage({
      conversation_type: 'business',
      business_id: 'business_001',
      sender_user_id: '',
      message_text: 'Get 50% off today.',
    });
    const context = makeContext({
      businesses: [makeBusiness()],
      userBusiness: [makeRelationship({ promotions_opted_out_at: '2026-06-01 10:00' })],
    });
    const result = assessTrust(message, content(message.message_text), context);
    expect(result.signals.some((signal) => signal.code === 'fatigue.opted_out')).toBe(true);
  });

  it('flags arrival inside the do-not-disturb window', () => {
    const message = makeMessage({ created_at: '2026-07-30 23:30', message_text: 'Hello.' });
    const context = makeContext({ users: [makeUser({ do_not_disturb_window: '22:00-07:00' })] });
    expect(assessTrust(message, content(message.message_text), context).inQuietHours).toBe(true);
  });
});

describe('similarity', () => {
  const index = new SimilarityIndex([
    { id: 'a', text: 'Selling a barely used kurta set, size M. Pickup near Gate 2 this weekend.' },
    { id: 'b', text: 'Tower B water tanker is leaving in twenty minutes, please fill drinking water.' },
    { id: 'c', text: 'Share your OTP now to restore account access before it is locked.' },
  ]);

  it('ranks the closest document first', () => {
    const hits = index.query('Selling a kurta set size M, pickup at Gate 2 this weekend');
    expect(hits[0]?.id).toBe('a');
  });

  it('restricts results to the candidate set', () => {
    const hits = index.query('kurta set pickup', { candidates: new Set(['b', 'c']) });
    expect(hits.every((hit) => hit.id !== 'a')).toBe(true);
  });

  it('returns nothing for text sharing no terms', () => {
    expect(index.query('zzzz qqqq')).toEqual([]);
  });

  it('produces cosine scores within [0, 1]', () => {
    for (const hit of index.query('kurta set pickup gate')) {
      expect(hit.score).toBeGreaterThanOrEqual(0);
      expect(hit.score).toBeLessThanOrEqual(1.0001);
    }
  });

  it('drops stopwords and very short tokens', () => {
    expect(tokenize('the a of an is to')).toEqual([]);
    expect(tokenize('kurta set')).toEqual(['kurta', 'set']);
  });

  it('scores jaccard overlap symmetrically', () => {
    const a = 'selling kurta set pickup gate';
    const b = 'selling kurta set pickup gate today';
    expect(jaccard(a, b)).toBeCloseTo(jaccard(b, a));
    expect(jaccard(a, a)).toBe(1);
    expect(jaccard(a, 'completely different words entirely')).toBe(0);
  });
});

describe('content resolution', () => {
  it('identifies writing systems', () => {
    expect(detectScripts('ओटीपी बताओ')).toContain('devanagari');
    expect(detectScripts('hello world')).toContain('latin');
  });

  it('recognises romanised Hindi', () => {
    expect(looksHinglish('tank aa gaya, jaldi bucket le aao')).toBe(true);
    expect(looksHinglish('the meeting is at four')).toBe(false);
  });

  it('keeps the scene description out of the matching text', () => {
    const media = {
      images: {
        img_1: {
          kind: 'photo',
          description: 'A photograph of a clothing rail in a boutique.',
          ocr_text: 'SALE 50% OFF',
          detected_brands: [],
          signals: ['price_promotion'],
        },
      },
      voice_notes: {},
    };
    const resolved = resolveContent(
      makeMessage({ media_type: 'image', media_id: 'img_1', message_text: 'Photos attached.' }),
      media,
    );

    // The description informs classification…
    expect(resolved.haystack).toContain('boutique');
    // …but must not pollute the text used to match against history.
    expect(resolved.authored).not.toContain('boutique');
    expect(resolved.authored).toContain('SALE 50% OFF');
  });

  it('folds a voice transcript into the searchable text', () => {
    const media = {
      images: {},
      voice_notes: {
        vn_1: {
          language: 'en',
          language_probability: 0.99,
          duration_sec: 4,
          transcript: 'Please call now, dad is unwell.',
          signals: ['family_health_emergency'],
        },
      },
    };
    const resolved = resolveContent(
      makeMessage({ media_type: 'voice', media_id: 'vn_1' }),
      media,
    );
    expect(resolved.haystack).toContain('dad is unwell');
    expect(resolved.mediaSignals).toContain('family_health_emergency');
  });

  it('tolerates a media id with no analysis entry', () => {
    const resolved = resolveContent(
      makeMessage({ media_type: 'image', media_id: 'missing', message_text: 'See attached.' }),
      EMPTY_MEDIA,
    );
    expect(resolved.imageText).toBe('');
    expect(resolved.text).toBe('See attached.');
  });
});

describe('confidence calibration', () => {
  it('emits only values from the observed bands', () => {
    const permitted = new Set(permittedConfidences());
    for (const action of ['notify', 'digest', 'mute'] as const) {
      for (const margin of [0, 0.05, 0.2, 0.4, 1]) {
        for (const evidenceCount of [0, 1, 2]) {
          const value = calibrateConfidence({
            action,
            margin,
            hardOverride: false,
            evidenceCount,
            mediaDerived: false,
          });
          expect(permitted).toContain(value);
        }
      }
    }
  });

  it('never claims certainty', () => {
    const value = calibrateConfidence({
      action: 'notify',
      margin: 10,
      hardOverride: true,
      evidenceCount: 5,
      mediaDerived: false,
    });
    expect(value).toBeLessThanOrEqual(0.91);
  });

  it('rates a wider margin at least as confidently as a narrow one', () => {
    const narrow = calibrateConfidence({
      action: 'notify', margin: 0.01, hardOverride: false, evidenceCount: 1, mediaDerived: false,
    });
    const wide = calibrateConfidence({
      action: 'notify', margin: 0.5, hardOverride: false, evidenceCount: 1, mediaDerived: false,
    });
    expect(wide).toBeGreaterThan(narrow);
  });

  it('keeps digest below notify, matching the labelled distribution', () => {
    const digest = calibrateConfidence({
      action: 'digest', margin: 0.5, hardOverride: false, evidenceCount: 2, mediaDerived: false,
    });
    const notify = calibrateConfidence({
      action: 'notify', margin: 0.5, hardOverride: false, evidenceCount: 2, mediaDerived: false,
    });
    expect(digest).toBeLessThan(notify);
  });

  it('discounts a decision resting on OCR or ASR', () => {
    const base = { action: 'digest' as const, margin: 0.2, hardOverride: false, evidenceCount: 1 };
    expect(calibrateConfidence({ ...base, mediaDerived: true })).toBeLessThanOrEqual(
      calibrateConfidence({ ...base, mediaDerived: false }),
    );
  });
});
