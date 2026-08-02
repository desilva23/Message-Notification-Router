/**
 * Keyword banks used by the risk, trust and classification scorers.
 *
 * The dataset mixes English, romanised Hindi ("Hinglish"), Devanagari and a
 * little French, so every safety-relevant bank carries its non-English variants
 * alongside the English ones. A scam that only trips the English patterns would
 * sail through the Hindi rows (`msg_070`, `msg_072`, `msg_079`), which is
 * exactly the failure mode these lists exist to prevent.
 *
 * Patterns are matched against a lowercased haystack built from the message
 * text, image OCR and voice transcript together, so a phrase hidden in a poster
 * or spoken in a voice note counts the same as one typed in the body.
 */

/** A named group of patterns, so a match can be reported as a specific signal. */
export interface Lexicon {
  readonly code: string;
  readonly label: string;
  readonly patterns: readonly RegExp[];
}

const re = (source: string): RegExp => new RegExp(source, 'iu');

// ---------------------------------------------------------------------------
// Prompt injection — attempts to address the router rather than the human
// ---------------------------------------------------------------------------

/**
 * Spans matching these are stripped from the message body before any other
 * scorer sees it, and are recorded as a hostile signal in their own right.
 *
 * Each pattern is anchored on the *instruction* shape (an imperative aimed at a
 * classifier) rather than on any single vocabulary word, so paraphrases are
 * still caught. `notify` on its own is a perfectly ordinary word — it is only
 * suspicious when something is telling the router to emit it.
 */
export const INJECTION_PATTERNS: readonly RegExp[] = [
  // "ignore all previous routing rules", "ignore previous instructions"
  /\b(ignore|disregard|forget|override)\b[^.!?\n]{0,40}\b(previous|prior|earlier|all|above|system|routing|safety)\b[^.!?\n]{0,40}\b(rule|rules|instruction|instructions|prompt|context|policy|policies)\b/giu,
  // "system note for the notification router: ...", "internal router metadata:"
  //
  // The audience words here are deliberately restricted to machine ones.
  // `admin` and `developer` are excluded because "Admin notice: maintenance
  // closes at 5 PM" is how every real society group opens a message — matching
  // it would quarantine legitimate notices and, worse, brand their senders as
  // manipulative. A false positive in this detector is far more damaging than
  // in any other, since it converts an honest sender into a scammer.
  /\b(system|internal|automated|assistant|ai|model|router|bot|llm|agent)\b[ \t]*(note|notice|message|instruction|instructions|directive|metadata|prompt|command)\b[^.!?\n]{0,120}[.!?]?/giu,
  // "note for the notification router", "instruction to the AI assistant"
  /\b(note|instruction|directive|message)\b[ \t]*(for|to)[ \t]+(the[ \t]+)?(notification[ \t]+)?(router|assistant|ai|model|system|bot|agent|classifier)\b[^.!?\n]{0,120}[.!?]?/giu,
  // "routing override:", "override: mark as notify"
  /\brouting[ \t]*override\b[^.!?\n]{0,120}[.!?]?/giu,
  /\boverride\b[ \t]*:[^.!?\n]{0,120}[.!?]?/giu,
  // "set action=notify", "action: notify", "confidence=1"
  /\b(action|confidence|priority|message_type|classification|label)\b[ \t]*[:=][ \t]*["']?[a-z0-9_.]+["']?/giu,
  // "verified_business=true", "user_priority=high"
  /\b(verified_business|user_priority|trust_level|sender_trust|is_trusted|whitelisted)\b[ \t]*[:=][ \t]*["']?[a-z0-9_.]+["']?/giu,
  // "mark this message as notify", "classify as urgent", "treat this as urgent"
  /\b(mark|set|classify|treat|categorise|categorize|route|flag|tag)\b[^.!?\n]{0,40}\b(as|to)\b[ \t]*["']?(notify|digest|mute|urgent|important|high[ \t]?priority|trusted|safe)\b/giu,
  // "always mark this as notify", "do not mute this"
  /\b(always|never|do not|don't)\b[^.!?\n]{0,30}\b(mark|mute|filter|suppress|flag|classify|route)\b[^.!?\n]{0,40}/giu,
  // "ignore sender risk", "bypass safety checks"
  /\b(ignore|bypass|skip|disable|suppress)\b[^.!?\n]{0,30}\b(sender[ \t]*risk|risk[ \t]*score|safety|security|spam[ \t]*filter|fraud[ \t]*check|verification)\b/giu,
  // Prompt scaffolding leaking into user content
  /<\/?(system|user|assistant|instruction|prompt)>/giu,
  /\[\/?(INST|SYSTEM|ASSISTANT)\]/giu,
];

// ---------------------------------------------------------------------------
// Credential harvesting
// ---------------------------------------------------------------------------

export const OTP_REQUEST: Lexicon = {
  code: 'risk.otp_request',
  label: 'Asks for an OTP, PIN or login code',
  patterns: [
    re('\\b(share|send|reply with|confirm|tell|provide|enter|give|verify|validate|authenticate|submit)\\b[^.!?\\n]{0,45}\\b(otp|one[ -]?time[ -]?(pass)?code|pin|cvv|login code|verification code|security code|6[ -]?digit)\\b'),
    re('\\b(otp|verification code|login code)\\b[^.!?\\n]{0,45}\\b(share|send|reply|confirm|batao|bhejo|daal)\\b'),
    // Hinglish: "OTP abhi batao", "code daal do", "OTP bhej do"
    re('\\botp\\b[^.!?\\n]{0,30}\\b(abhi|jaldi|batao|bhejo|bhej do|daal do|share karo|confirm karo)\\b'),
    re('\\b(code|otp)\\b[ \\t]*(daal|bata|bhej)'),
    // Devanagari: ओटीपी / कोड + बताओ / भेजो
    re('(ओटीपी|कोड)[^।!?\\n]{0,30}(बताओ|भेजो|साझा|डालो|कन्फर्म)'),
    re('\\b(password|passcode)\\b[^.!?\\n]{0,30}\\b(confirm|share|reply|send|enter)\\b'),
  ],
};

export const ACCOUNT_THREAT: Lexicon = {
  code: 'risk.account_threat',
  label: 'Threatens account block, expiry or restriction',
  patterns: [
    re('\\b(account|profile|access|card|sim|wallet|workspace)\\b[^.!?\\n]{0,45}\\b(block(ed|s)?|suspend(ed)?|restrict(ed)?|deactivat(e|ed)|lock(ed)?|expire(s|d)?|clos(e|ed|ure)|terminat)\\b'),
    re('\\b(will be|may be|going to be|about to be)\\b[^.!?\\n]{0,25}\\b(blocked|suspended|restricted|locked|deactivated|closed)\\b'),
    // Hinglish: "account block ho jayega", "profile band ho jayega"
    re('\\b(account|profile|sim|card)\\b[^.!?\\n]{0,30}\\b(block|band|bandh)\\b[^.!?\\n]{0,20}\\b(ho|hoga|jayega|jaayega)\\b'),
    re('(अकाउंट|खाता|प्रोफाइल)[^।!?\\n]{0,30}(ब्लॉक|बंद)'),
  ],
};

export const VERIFY_PRESSURE: Lexicon = {
  code: 'risk.verify_pressure',
  label: 'Pushes an urgent verification flow',
  patterns: [
    re('\\b(verify|verification|re[- ]?verify|kyc|authenticate|confirm your)\\b[^.!?\\n]{0,45}\\b(now|immediately|today|urgent|quickly|within|before|abhi|jaldi)\\b'),
    re('\\b(complete|finish|do)\\b[^.!?\\n]{0,25}\\b(verification|kyc|security check|account check|the check|the process)\\b'),
    // "one final verification step" — the manufactured last hurdle before some
    // promised outcome is released. No legitimate flow is ever phrased this way.
    re('\\b(final|one more|last|pending|additional)\\b[ \\t]*(verification|validation|security|kyc)?[ \\t]*(step|check|process)\\b'),
    re('\\bsecurity (alert|check|update)\\b[^.!?\\n]{0,45}\\b(now|today|immediately|required|pending)\\b'),
    re('(वेरिफिकेशन|सत्यापन)[^।!?\\n]{0,30}(अभी|तुरंत|जल्दी)'),
    re('\\bverification\\b[^.!?\\n]{0,25}\\b(nahi hua|nahin hua|pending hai)\\b'),
  ],
};

export const PAYMENT_PRESSURE: Lexicon = {
  code: 'risk.payment_pressure',
  label: 'Demands an immediate payment, fee or transfer',
  patterns: [
    re('\\b(pay|transfer|deposit|remit|send)\\b[^.!?\\n]{0,40}\\b(fee|charge|amount|token|clearance|penalty|processing|reattempt|advance)\\b'),
    re('\\b(fee|charge|amount|penalty|clearance)\\b[^.!?\\n]{0,35}\\b(pending|due|immediately|today|now|before)\\b'),
    re('\\bscan\\b[^.!?\\n]{0,25}\\b(qr|code)\\b[^.!?\\n]{0,35}\\b(pay|amount|now|today)\\b'),
    re('\\bscan (this|the) qr\\b'),
    re('\\b(processing|reattempt|reactivation|clearance|convenience|token) fee\\b'),
    // Advance-fee shape: money first, proof afterwards. The sequencing is the
    // tell — a genuine seller hands over papers at the point of sale.
    re('\\b(papers|documents|registry|receipt|proof|allotment|ownership)\\b[^.!?\\n]{0,35}\\b(after|post|once|following)\\b[^.!?\\n]{0,25}\\b(payment|paid|token|transfer)\\b'),
    re('\\bpay\\b[^.!?\\n]{0,30}\\btoken\\b[^.!?\\n]{0,30}\\b(today|now|to block|to reserve)\\b'),
    re('\\bsend (a )?screenshot\\b[^.!?\\n]{0,35}\\b(pay|paid|payment|done|transfer)\\b'),
    re('\\b(pay|paid)\\b[^.!?\\n]{0,25}\\bscreenshot\\b'),
  ],
};

/**
 * Payment routed around the official channel.
 *
 * This is the sharpest line in the whole corpus. The genuine society admin
 * writes "use the society app or the office QR only"; the impostor writes "use
 * this link and send screenshot here so I can update it faster". Both say money
 * is due today. The difference is entirely in *where the money goes* and who
 * reconciles it — an ad-hoc link plus a personally-collected screenshot is the
 * fraud, and no amount of surrounding politeness changes that.
 */
export const OFFCHANNEL_PAYMENT: Lexicon = {
  code: 'risk.offchannel_payment',
  label: 'Directs payment through an ad-hoc link or personal collection',
  patterns: [
    re('\\buse (this|the) link\\b'),
    re('\\b(pay|payment|amount|fee)\\b[^.!?\\n]{0,35}\\b(through|via|using|at) (this|the) link\\b'),
    re('\\b(send|share|drop)\\b[^.!?\\n]{0,20}\\bscreenshot\\b[^.!?\\n]{0,30}\\b(here|me|dm|personally|so i can)\\b'),
    re('\\bscan\\b[^.!?\\n]{0,30}\\b(and )?(pay|send|share|screenshot|amount|charge)\\b'),
    re('\\bi (will|can) (update|mark|confirm|reconcile) (it|the list|your name)\\b'),
    re('\\b(open|fill)\\b[^.!?\\n]{0,25}\\b(document|form|first page)\\b[^.!?\\n]{0,30}\\bbank details\\b'),
  ],
};

export const BANK_DETAIL_REQUEST: Lexicon = {
  code: 'risk.bank_detail_request',
  label: 'Asks for bank, card or wallet details',
  patterns: [
    re('\\b(share|send|fill|enter|confirm|provide|update)\\b[^.!?\\n]{0,45}\\b(bank (account|details)|account number|card (details|number)|wallet (details|address)|upi (id|pin)|ifsc|routing number)\\b'),
    re('\\b(bank|card|wallet)\\b[^.!?\\n]{0,20}\\bdetails\\b[^.!?\\n]{0,35}\\b(verify|confirm|before|now|today|update)\\b'),
    re('\\bverify\\b[^.!?\\n]{0,25}\\b(wallet|card|bank)\\b'),
  ],
};

export const REWARD_BAIT: Lexicon = {
  code: 'risk.reward_bait',
  label: 'Dangles a prize, refund or approval to bait a response',
  patterns: [
    re('\\b(congrat(s|ulations)?|you (have been|are|were) (selected|chosen)|lucky (winner|draw)|your number was selected)\\b'),
    re('\\b(claim|collect|release)\\b[^.!?\\n]{0,35}\\b(reward|prize|benefit|voucher|cashback|amount|refund|payout)\\b'),
    re('\\b(loan|refund|benefit|payout|amount)\\b[^.!?\\n]{0,25}\\b(approved|sanctioned|ready|pending release)\\b'),
    re('\\bapproval (window|is pending)\\b'),
  ],
};

export const CHAIN_FORWARD: Lexicon = {
  code: 'risk.chain_forward',
  label: 'Chain-letter phrasing that asks to be forwarded onward',
  patterns: [
    re('\\b(forward|share|send)\\b[^.!?\\n]{0,30}\\b(to|with)\\b[^.!?\\n]{0,20}\\b(\\d+|ten|five|all|everyone|every)\\b[^.!?\\n]{0,25}\\b(people|persons|friends|groups|contacts|family)\\b'),
    re("\\b(do not|don't) break the chain\\b"),
    re('\\bshare (this )?(blessing|message|with (10|ten) people)\\b'),
    re('\\bforward(ing)? (this )?(as received|to (all|every) (family )?groups?)\\b'),
    re('\\b(share|forward)\\b[^.!?\\n]{0,30}\\bbefore (midnight|sunset|tonight)\\b'),
    // Hinglish: "sab groups me share kar dena", "sabko bhej do"
    re('\\b(share|forward)\\b[^.!?\\n]{0,25}\\bkar (dena|do)\\b'),
    re('\\b(sab|sabko|sabhi)\\b[^.!?\\n]{0,25}\\b(bhej|share)\\b'),
    re('(सब|सभी)[^।!?\\n]{0,25}(शेयर|भेज)'),
  ],
};

export const MEDICAL_MISINFO: Lexicon = {
  code: 'risk.medical_misinfo',
  label: 'Unverified health advice, including advice to stop medication',
  patterns: [
    re('\\bstop (all |taking )?(tablets|medicines?|medication|pills)\\b'),
    re("\\bdoctors? (don'?t|do not|never) (tell|want you to know)\\b"),
    re('\\b(health (secret|tip)|herbal (mix|remedy)|this one habit will fix)\\b'),
    re('\\bcure[sd]? (cancer|diabetes|everything)\\b'),
  ],
};

export const SUSPICIOUS_LINK: Lexicon = {
  code: 'risk.suspicious_link',
  label: 'Shortened or lookalike link',
  patterns: [
    re('\\b(bit\\.ly|tinyurl|t\\.co|goo\\.gl|is\\.gd|cutt\\.ly|rb\\.gy|shorturl|rebrand\\.ly)\\b'),
    // Lookalike domains: a known brand glued to a service word under a cheap TLD.
    re('\\b[a-z0-9-]*(verify|secure|alert|kyc|reward|refund|helpdesk|support|login|update|billing|recovery)[a-z0-9-]*\\.(in|com|net|org|xyz|top|site|info|co)\\b'),
    re('\\b(account|profile|wallet|payment)-?(login|help|verify|secure|check)\\b'),
  ],
};

export const URGENCY_PRESSURE: Lexicon = {
  code: 'risk.urgency_pressure',
  label: 'Manufactured time pressure',
  patterns: [
    re('\\b(within|in) \\d+ (minutes?|mins?|hours?|hrs?)\\b[^.!?\\n]{0,35}\\b(or|otherwise|else)\\b'),
    re('\\b(before|by) (midnight|tonight|today|end of day)\\b[^.!?\\n]{0,35}\\b(or|otherwise|else|will be)\\b'),
    re('\\b(last|final) (chance|warning|reminder)\\b'),
    re("\\b(hurry|act now|don'?t delay|time is running out|limited window)\\b"),
    re('\\b(jaldi karo|time kam hai|turant)\\b'),
    re('(जल्दी|तुरंत)[^।!?\\n]{0,25}(करो|कीजिए)'),
  ],
};

/** Every risk lexicon, in the order the scorer applies them. */
export const RISK_LEXICONS: readonly Lexicon[] = [
  OTP_REQUEST,
  BANK_DETAIL_REQUEST,
  OFFCHANNEL_PAYMENT,
  ACCOUNT_THREAT,
  VERIFY_PRESSURE,
  PAYMENT_PRESSURE,
  REWARD_BAIT,
  SUSPICIOUS_LINK,
  URGENCY_PRESSURE,
  CHAIN_FORWARD,
  MEDICAL_MISINFO,
];

// ---------------------------------------------------------------------------
// Benign intent lexicons
// ---------------------------------------------------------------------------

export const DIRECT_ADDRESS: Lexicon = {
  code: 'trust.direct_address',
  label: 'Addresses this user directly',
  patterns: [re('@\\{?user\\}?'), re('@u_\\d+')],
};

export const RESPONSE_REQUESTED: Lexicon = {
  code: 'intent.response_requested',
  label: 'Asks this user for a reply or action',
  patterns: [
    re('\\b(can|could|will|would) you\\b[^.!?\\n]{0,40}\\?'),
    re('\\b(please|pls|plz|kindly)\\b[^.!?\\n]{0,30}\\b(confirm|reply|send|share|call|join|check|bring|sign|submit)\\b'),
    re('\\b(let me know|reply once|confirm if|tell me|send me)\\b'),
    re('\\b(call|ring|phone) me\\b'),
    re('\\bneed your (eyes|help|input|comments)\\b'),
    re('\\b(confirm|batao|bata do)\\b[^.!?\\n]{0,20}\\b(kar|karo|dena)\\b'),
  ],
};

export const IMMEDIATE_URGENCY: Lexicon = {
  code: 'intent.immediate_urgency',
  label: 'Genuine same-moment urgency',
  patterns: [
    re('\\b(call me (now|urgently)|come online now|join (the )?(call|bridge|incident) now)\\b'),
    re('\\b(right now|immediately)\\b'),
    // "in the next 20 minutes" and "for the next 30 minutes" are the same
    // demand phrased two ways; matching only the first drops standing-by
    // requests, which are among the most time-critical messages there are.
    re('\\b(in|for|over|within)\\b[ \\t]*(the[ \\t]+)?next \\d+ ?(minutes?|mins?|hours?|hrs?)\\b'),
    // Being asked to stay available *is* the interruption — deferring it to a
    // digest defeats the entire request.
    re('\\b(stay|remain|be|keep)\\b[^.!?\\n]{0,20}\\b(online|available|reachable|on call|near (the |your )?(laptop|phone|desk|system))\\b'),
    re('\\b(escalation|incident|outage|down|failing|blocked)\\b[^.!?\\n]{0,40}\\b(now|start(s|ing)?|live|prod)\\b'),
    re('\\b(\\d+ ?(mins?|minutes?))\\b[^.!?\\n]{0,30}\\b(leave|leaving|closes?|closing|left|max)\\b'),
    // The same countdown with the clause order reversed — "leaving in 20 mins"
    // rather than "20 mins before leaving". Both phrasings appear in the corpus
    // and only matching one of them silently drops half the genuine urgency.
    re('\\b(leave|leaves|leaving|close[sd]?|closing|start(s|ing)?|end(s|ing)?|expire[sd]?)\\b[^.!?\\n]{0,25}\\bin \\d+ ?(mins?|minutes?|hours?|hrs?)\\b'),
    re('\\b(fill|collect|move|bring|come|reach|pick)\\b[^.!?\\n]{0,25}\\b(now|immediately|right away)\\b'),
    re('\\b(unwell|emergency|hospital|clinic|ambulance)\\b'),
    // Same-day work deadlines. "Before EOD" is the standard phrasing and reads
    // as ordinary prose, so it needs its own pattern rather than relying on the
    // generic urgency wording.
    re('\\bbefore (eod|end of day|the (call|meeting|standup))\\b'),
    re('\\b(eod|end of day)\\b[^.!?\\n]{0,30}\\b(need|close|finish|send|submit)\\b'),
    re('\\b(need to|have to|must) (close|finish|ship|submit|decide)\\b[^.!?\\n]{0,35}\\b(today|tonight|before|by)\\b'),
    re('\\b(last[- ]minute|pulled (to|forward)|moved up|preponed)\\b'),
    re('\\b(build|deploy|job|queue|payment)s? (is |are )?(failing|failed|down|broken|stuck)\\b'),
    re('\\b(jaldi|abhi)\\b[^.!?\\n]{0,25}\\b(aao|le aao|hata|karo)\\b'),
    re('(जल्दी|अभी)[^।!?\\n]{0,20}(आओ|लाओ)'),
  ],
};

export const DEFERRABLE: Lexicon = {
  code: 'intent.deferrable',
  label: 'Sender explicitly says it can wait',
  patterns: [
    re('\\bno (rush|hurry|urgency|pressure|need to (reply|respond))\\b'),
    re('\\bnothing (urgent|dramatic|blocking)\\b'),
    re("\\b(whenever|when ?ever) (you get|you have) (time|a (minute|moment|chance))\\b"),
    re('\\b(read|check|look) (it |this )?later\\b'),
    re('\\b(tomorrow|next week|after|later)\\b[^.!?\\n]{0,25}\\b(fine|ok|okay|works)\\b'),
    re('\\bkoi urgency nahi\\b'),
    re('\\btill next (sunday|week|month)\\b'),
  ],
};

export const GREETING: Lexicon = {
  code: 'type.greeting',
  label: 'Greeting or well-wishing',
  patterns: [
    // A bare "Hi"/"Hello" opener is deliberately absent: almost every business
    // template starts with one ("Hi Customer, your order has shipped"), so
    // treating it as a greeting would swallow the transactional categories.
    // Only salutations that are the substance of the message count.
    re('^\\s*(good (morning|evening|night|afternoon)|namaste|namaskar)\\b'),
    re('\\b(stay (positive|blessed|safe)|keep smiling|good vibes|positive energy|blessings)\\b'),
    re('\\bhope (today|your day) is\\b'),
    re('(सुप्रभात|नमस्ते|शुभ)'),
    re('\\b(bhagwan|ishwar)\\b[^.!?\\n]{0,25}\\b(bhala|kare)\\b'),
  ],
};

export const PROMOTION: Lexicon = {
  code: 'type.promotion',
  label: 'Marketing or sales content',
  patterns: [
    re('\\b\\d{1,3} ?% ?off\\b'),
    re('\\b(discount|sale|offer|deal|coupon|promo ?code|cashback|voucher|bogo)\\b'),
    re('\\b(shop|buy|order) now\\b'),
    re('\\b(reply|send) stop\\b[^.!?\\n]{0,30}\\bunsubscribe\\b'),
    re('\\bunsubscribe\\b'),
    re('\\b(limited (time|period|stock)|while stocks last|starting at|from rs\\.? ?\\d)\\b'),
    re('\\b(press|dial) \\d\\b'),
    re('\\bfor sale\\b'),
    re('\\bselling\\b'),
  ],
};

export const EVENT: Lexicon = {
  code: 'type.event',
  label: 'A scheduled or dated commitment',
  patterns: [
    // Deliberately excludes a bare clock time: nearly every message in this
    // corpus mentions one, so it identifies nothing. An event needs a named
    // commitment, not just a number that looks like a time.
    re('\\b(meeting|sync|standup|stand-up|review|session|practice|rehearsal|class|trip|potluck|bridge|circular)\\b[^.!?\\n]{0,40}\\b(at|on|by|from|today|tomorrow|tonight|moved)\\b'),
    re('\\b(registration|rsvp|consent|form|sheet)\\b[^.!?\\n]{0,35}\\b(open|close[sd]?|till|by|before|submit|sign)\\b'),
    // Transport logistics only — a marketplace "pickup near Gate 2" is a sale,
    // not a scheduled event, so the pickup sense requires a transport subject.
    re('\\b(school ?bus|bus|driver|route|transport|shuttle)\\b[^.!?\\n]{0,35}\\b(at|by|from|time|gate|early|late|moved|leaving|change)\\b'),
    re('\\b(appointment|booking|reservation)\\b'),
    re('\\b(field ?trip|excursion)\\b'),
    re('\\b(moved|shifted|preponed|postponed) to\\b[^.!?\\n]{0,25}\\b(\\d|am|pm|studio|gate|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\\b'),
  ],
};

export const PAYMENT_LEGITIMATE: Lexicon = {
  code: 'type.payment',
  label: 'Money-related but not necessarily fraudulent',
  patterns: [
    re('\\b(payment|maintenance|invoice|bill|statement|due|dues|receipt|refund|fee|charge|emi|premium)\\b'),
    re('\\b(paid|pay|amount|rs\\.? ?\\d|₹ ?\\d)\\b'),
    re('\\b(maintenance|payment)\\b[^.!?\\n]{0,25}\\b(aaj|kar dena|tak)\\b'),
  ],
};

export const BUSINESS_UPDATE: Lexicon = {
  code: 'type.business_update',
  label: 'Transactional service update',
  patterns: [
    re('\\b(order|parcel|package|shipment|delivery|dispatch|courier|pickup)\\b[^.!?\\n]{0,40}\\b(packed|shipped|out for|arriv|deliver|attempt|schedul|status|hub|return)\\b'),
    // `your account` is deliberately absent: it is the opening of nearly every
    // marketing template in this corpus ("your account has a shopping offer"),
    // so treating it as transactional miscategorises adverts as order updates.
    re('\\b(your (order|booking|ride|trip|appointment|statement))\\b'),
    re('\\b(ride|route|driver|eta) (update|status|change)\\b'),
    re('\\b(feedback|review|rate (your|us)|experience with us)\\b'),
    re('\\b(statement|reward points|payment date) (is )?(ready|available)\\b'),
  ],
};

/** Words that indicate the sender is a stranger introducing themselves. */
export const STRANGER_INTRO: Lexicon = {
  code: 'trust.stranger_intro',
  label: 'Sender introduces themselves as unknown to the user',
  patterns: [
    re('\\b(i (found|got) (your|this) number|is this [a-z]+ from|this is [a-z]+ from the)\\b'),
    re('\\b(hi|hello|bonjour),? (i am|i\'m|this is|je suis)\\b'),
    re('\\bfrom the (courier desk|volunteer sheet|front desk|reception)\\b'),
  ],
};
