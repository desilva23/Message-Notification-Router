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
putting it anywhere near the safety path.

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

Supabase is optional. `repository.ts` probes it and falls back to the bundled CSV snapshot when
it is unconfigured *or unreachable*, surfacing which source answered in the UI.

The fallback is what keeps the submission contract satisfied — a reviewer cloning the repo has
no credentials, and a solution that required them would not be runnable from a terminal. It
also means a database blink degrades the dashboard to "showing the snapshot" rather than to a
blank page.

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
