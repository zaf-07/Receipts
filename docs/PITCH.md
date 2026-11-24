# Receipts: the business case

This page follows the product's own rule. Every number on it was measured in this repository, and
anything that is a judgement or an assumption is labelled as one. There are no market-size figures
here, because we do not have a source for one that we would be willing to cite.

## The problem

Outbound tools made sending cheap, so the cost moved to the person receiving it. An AI SDR that
writes "congrats on the Series B" to a company that never raised one does three kinds of damage:

- **To the buyer.** The email is wrong in its first line, and they stop reading the sender's domain.
- **To the seller.** The rep's name is on a false statement. Legal and brand teams respond by
  taking autonomy away, which is why most "autonomous" SDR pilots end up as draft generators.
- **To deliverability.** Volume without relevance is what spam filters are built to catch.

The usual answer is a better prompt. A prompt cannot fix this, because the model is not the part
that knows whether a job posting was taken down this morning.

## The product, in one sentence

Receipts is a GTM agent that will not state a fact about a prospect unless it can show the sentence
on a public page that supports it, and re-opens that page before anything is sent.

What that buys the customer, each of which is on screen in the demo:

| Promise | How it is kept |
| --- | --- |
| No invented facts | Every factual sentence in a draft carries the receipts it rests on. A sentence with none is struck. |
| No stale facts | The Skeptic re-fetches each source before the draft reaches a person. Receipts expire on a clock. |
| No contact without a reason | A lead with no live trigger is held as **Not yet**, with the reason, instead of being emailed anyway. |
| No send without a person | One code path can mark a message sent, and it requires a named reviewer's approval. |
| No leak | A Security agent blocks other prospects' names, internal identifiers, unverified links and undeliverable recipients. |

## Who buys it

**First customer (judgement):** a B2B software company with a small sales team, roughly 2 to 15
reps, selling a product where timing matters: a hire, a funding round, a tool change, a compliance
deadline. They already pay for a data vendor and a sequencer and are unhappy with both the reply
rate and the embarrassment rate.

**Who signs:** the head of sales or the founder. **Who can veto:** whoever owns the brand or the
legal review of outbound. Receipts is the rare outbound tool that the second person argues *for*,
because the audit trail is the product.

**Why this buyer first:** they feel a wrong email personally, they can decide in one meeting, and
their accounts are few enough that precision beats volume.

## Why now (our judgement)

- Models became good enough to read a page and extract a claim with the supporting sentence. That
  is the capability a receipt needs, and it did not exist at a usable price two years ago.
- Inboxes got stricter about bulk senders. Sending less, to the right account, on a real trigger,
  stopped being a virtue and became the only thing that still lands.
- Buyers of AI tooling now ask how a decision was reached. A product built on an evidence trail
  answers that question by design.

## How it makes money

Usage-based, on credits, metered through Flexprice. The meter is already in the product:

| Operation | Credits | Why it is priced |
| --- | --- | --- |
| Enrich a lead | 5 | The expensive step: finding and reading a contact |
| Generate a draft | 2 | Model cost, plus the Skeptic's re-verification |
| Send | 1 | The outcome the customer wanted |

Research, scoring and the decision *not* to contact are free. That is deliberate: the customer
should never pay more because the agent was careful, and a lead held back costs them nothing.

**What it costs us (measured).** A live-web discovery pass, capped at 6 searches and 12 pages, cost
between $0.33 and $0.54 in model calls when we ran it against the real web. The app records the
token count and cost of every model call per agent and per task, so cost per lead is a number we
read off the dashboard, not one we estimate.

**What we would charge (assumption, to be tested with the first customers).** A platform fee that
covers research, plus prepaid credits, priced so that one approved, verified email costs the
customer on the order of a dollar. The comparison the buyer makes is with a human SDR's time per
researched email, not with the per-seat price of a sequencer.

## Why not the alternatives

| Alternative | What it does well | Where it stops |
| --- | --- | --- |
| Sequencers | Deliver volume reliably | They send whatever they are given. Truth is not their job. |
| Data vendors | Broad coverage of firmographics and contacts | A field with no source and no date. Nobody can tell which rows are stale. |
| AI SDRs | Write fluent, personalised copy | Fluency is the problem. The copy is confident whether or not the fact is true. |
| A human SDR | Judgement, and they can be held accountable | Ten researched emails a day, on a good day. |

Receipts does not replace the sequencer or the data vendor. It is the layer that decides whether
there is anything true and timely to say, and proves it.

## What is hard to copy

- **The evidence graph.** Every account accumulates dated, sourced claims and the outcome of every
  message that cited them. After a quarter, a customer's graph says which kinds of trigger earn
  replies *for their product*. That is their data, it compounds, and it is not in any vendor's file.
- **The learning loop.** A reply raises the weight of the signal type that earned it and produces a
  new, diffable version of the ICP. The system gets more selective with use, not louder.
- **Restraint as a feature.** Incumbents are paid per seat or per send. A product that proudly
  reports the emails it declined to write is awkward for them to ship.

## Risks, stated plainly

- **Coverage.** Insisting on a public source means fewer contacts than a data vendor returns. We
  think fewer and true is the better trade for this buyer; it is the first thing to validate.
- **The web is hostile to readers.** Pages block bots and change shape. The fetcher reports a
  source it cannot open instead of guessing, which keeps the product honest and costs coverage.
- **Delivery is simulated today.** Sending real mail means a provider, domain warm-up and
  compliance work that this prototype does not do.
- **Model cost.** Verification doubles the reads per claim. Costs are measured per task so pricing
  can follow them.

## The next ninety days (plan, not promise)

1. Five design partners in one vertical, running Receipts next to their current outbound. The
   metric is reply rate per approved email, and the number of false statements caught before send.
2. A real sending adapter behind the existing human gate, and signed inbound webhooks from the
   same provider.
3. A vendor adapter at the Enricher for contacts, accepted only when the vendor returns a source.
4. Turn the per-customer evidence graph into the weekly report the head of sales actually reads:
   which triggers worked, which accounts to leave alone, and why.
