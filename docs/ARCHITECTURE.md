# Architecture

## Why deterministic

The obvious build for this challenge is to hand each message plus its retrieved context to an
LLM and let it decide. That approach was rejected, and the reasoning is worth stating because
it drove everything else.

Routing decisions here are *judgements about someone's attention*. When the system gets one
wrong — mutes a hospital call, surfaces a scam — the operator needs to know exactly why, and
needs a change that fixes that case without silently moving a hundred others. A prompt gives
neither: its failures are diagnosed by re-reading generated prose, and its fixes are re-rolls.

So the engine is a scoring pipeline where every contribution is a named signal with a weight.
The decision is a sum you can read line by line, which means:

- a wrong prediction is traced to a specific rule in seconds (`npm run explain -- msg_022`)
- the same inputs always produce the same output, so `output.csv` is reproducible
- each rule is unit-testable in isolation, which is why the suite can be meaningful
- routing 110 messages costs ~60 ms with no network calls

The LLM is kept as an *adjudicator* on genuinely borderline cases rather than the primary
decision-maker — the place where its judgement adds something the rules cannot, without
putting it anywhere near the safety path. What it was actually worth is set out below.

---

## What the adjudicator was worth

It changes zero decisions today, so it is worth being precise about why it exists rather than
letting it read as unused scaffolding.

**Its role is verification, not decision.** A rule system cannot audit itself: the same
assumptions that produce a wrong rule produce the test that agrees with it. What finds those
bugs is a second opinion with *uncorrelated* failure modes, followed by investigating every
disagreement rather than averaging it away. That is how the adjudicator was used.

It disagreed on a handful of borderline messages. Three were real defects in the rules:

| Defect | Fix |
|---|---|
| `"for the next N minutes"` not matched as urgency | broadened the countdown patterns in `lexicons.ts` |
| direct ask + same-day deadline scored no urgency | added `intent.same_day_deadline` |
| mute reason said the user "usually ignores" this while citing evidence they *opened* it | reason/evidence coherence guard in `reasons.ts` |

Every fix landed in the deterministic engine; none was delegated to the model. The third
generalised into an invariant — a reason may never contradict the evidence it cites — asserted
across all 110 rows in `tests/contract.test.ts`. Six regression tests hold the set shut.

So "zero decisions changed" is a **measured convergence result, not silence**: before these
fixes the two disagreed, and after them they do not. That is a stronger statement about the
rules than never having checked.

Two properties keep it honest as a shipped component rather than dead code. It is called on
every run (`scripts/route.ts`) and no-ops when unconfigured, so it is a config branch and not
an unreferenced module. And 14 tests cover it, including that a failed request, a malformed
reply, an out-of-enum action and an action the engine was not weighing all leave the
deterministic decision untouched.

It is off for the submission because reproducing `output.csv` must not depend on an API key,
a network round trip, or a model version. `temperature: 0` bounds variance; it does not
promise bit-identical tokens across serving stacks.

---

## The pipeline

```
                  ┌─────────────────┐
   raw message ──▶│ resolveContent  │  fuse text + OCR + transcript
                  │                 │  quarantine router-directed spans
                  └────────┬────────┘
                           │  ResolvedContent
        ┌──────────────────┼──────────────────┬──────────────────┐
        ▼                  ▼                  ▼                  ▼
  ┌──────────┐      ┌──────────┐       ┌──────────┐      ┌─────────────┐
  │assessRisk│      │assessTrust│      │assessIntent│    │assessRepetition│
  └────┬─────┘      └─────┬────┘       └─────┬────┘      └──────┬──────┘
       │                  │                  │                  │
       └──────────────────┴────────┬─────────┴──────────────────┘
                                   ▼  Signal[]
                          ┌─────────────────┐
                          │    classify     │  → message_type
                          └────────┬────────┘
                                   ▼
                          ┌─────────────────┐
                          │  score actions  │  notify / digest / mute
                          │ safety override │
                          └────────┬────────┘
                                   ▼
                 ┌─────────────────┴──────────────────┐
                 ▼                 ▼                  ▼
          selectEvidence     selectReason     calibrateConfidence
```

Every stage is a pure function. `routeMessage` performs no I/O, which is what lets it run
inside a request handler, inside a test, and inside a CLI unchanged.

---

## Load-bearing decisions

### Safety overrides rather than votes

`engine.ts` computes three action scores, then applies hard overrides. A confirmed
credential-harvesting attempt sets `mute` regardless of what the scores said.

This is not defensive coding. The specification states that clear scam or safety risk must be
muted "regardless of the user's usual engagement", and an additive model cannot honour that:
a user engaged enough with a sender would eventually accumulate enough trust to outvote the
risk term. Making safety a separate gate is the only way the guarantee actually holds.

### `message_type` is scored independently of `action`

A `promotion` can be any of the three actions depending on the user; a `scam` is always muted.
Deriving one from the other collapses that distinction and loses accuracy on both. They are
graded separately too.

### Reasons come from a fixed bank

The labelled samples reuse the same sentences verbatim across unrelated messages — one phrase
covers every opted-out marketing case, another covers two different school notices. That is a
house style, and the rubric scores reasons on "usefulness and *consistency*".

So the router selects from a 29-phrase bank keyed to the dominant signal, rather than
generating prose per message. Two messages decided for the same underlying reason are
guaranteed to read the same way, and the reason always names the factor that actually moved
the outcome.

### Confidence is quantised into calibrated bands

Every labelled confidence falls into a narrow per-action band:

| Action | Observed values |
|---|---|
| `notify` | 0.85, 0.87, 0.89, 0.91 |
| `mute` | 0.81, 0.83, 0.85, 0.87 |
| `digest` | 0.78, 0.80, 0.82, 0.84 |

Two properties are preserved deliberately. Nothing is ever above 0.91 — a system deciding
whether to interrupt a person should not claim certainty. And `digest` sits lowest, because it
is the hedge action, chosen when neither interrupting nor suppressing is clearly right; its
number should say so.

Decision strength — margin between the top two actions, plus corroborating evidence, minus a
penalty when the deciding content came from OCR or ASR — maps onto the band for the chosen
action.

### Evidence is corroboration, not just similarity

The rubric checks that cited historical ids are *relevant*, so evidence is not the top
similarity hit. A candidate scores on resemblance, provenance, and whether the user's reaction
to it supports the decision *being made now*: a mute wants the messages they dismissed, a
notify wants the ones they replied to. Citing a message the user replied to as grounds for
muting would be incoherent.

When the decision rests on the *absence* of a prior relationship, evidence is `none` — "this is
the first message from this sender" and "here is a past message from them" cannot both be true.

### Retrieval is lexical, not embedded

`similarity.ts` is a TF-IDF cosine over an inverted index. An embedding model would capture
paraphrase better, but would also make routing non-deterministic and network-dependent. The
duplicates in this corpus are re-phrasings of the same offer, which lexical matching recovers.

One subtlety: the query uses *sender-authored* text only. Image scene descriptions are
model-authored vocabulary that appears on one side of a comparison and never the other, so
including them buries real overlap under words no historical message contains. They still
inform classification, just not retrieval.

### Indexes are built once per run

`buildContext` pre-indexes every reference table into maps keyed for O(1) lookup, and
`buildSimilarityIndex` builds the inverted index once for a batch. Against flat arrays each
scorer's lookups would be a linear scan and the run would be quadratic.

---

## Data layer

Supabase is a **mirror, not a source**, and the distinction is deliberate enough to be worth
stating precisely.

Rendering always reads the bundled CSV snapshot. `supabase/schema.sql` and `npm run db:seed`
publish the same reference data to Postgres under row level security, and `repository.ts`
probes it with a `head: true` count so the UI can report whether that mirror is answering. The
probe returns no rows. No rendered value is derived from it, and nothing downstream reads
Supabase.

That is why the snapshot field is named `mirror: MirrorStatus` rather than a data source. An
earlier revision called it `source: 'supabase' | 'local-csv'`, which read as though the rows
had come from whichever one won — they never do. Naming it for what it measures stops the UI
making a claim the code does not support.

The reason for the design is the submission contract: a reviewer clones the repo with no
credentials and must reproduce `output.csv` exactly. A render path that depended on a network
round trip, or on whichever rows a database happened to hold, could not promise that. It also
means a database blink changes a status line rather than blanking the dashboard.

Routing always runs locally against the same engine either way, so displayed decisions never
depend on which source answered.

---

## What I would do next

- **Evidence precision** sits at 63% against the labelled ids. Inspection shows the retrieved
  message is frequently a *closer* match than the labelled one (the labels appear to be
  synthetic 1:1 pairings), so chasing exact-id agreement would be fitting to an artefact. A
  cross-encoder re-ranker over the top-5 candidates is the principled improvement.
- **Threshold sensitivity.** Weights were tuned against 30 labelled examples. A larger labelled
  set would justify fitting them rather than hand-setting them.
- **Per-user calibration.** Confidence bands are global. Users with very different notification
  loads plausibly warrant different interrupt thresholds.
