# Receipts

**A GTM agent that only acts when it can prove why now.**

Receipts takes a plain-language product description, infers the ICP, finds accounts with live buying signals, writes outreach built only from verified evidence, and holds back every lead that has no fresh reason. A human approves every send.

> AI SDRs send confident nonsense. Ours can't.

Built for HackwithBay 4.0.

## Run it

Needs Node 22.13 or newer. No API keys, no database to install.

```bash
npm install
npm run demo
```

Open http://localhost:8787, click **Load the example**, then **Plan the ICP**, then **Run discovery**.

Other commands:

| Command | What it does |
| --- | --- |
| `npm run demo` | Build the web client and start the server on one port |
| `npm run dev` | API on 8787 and Vite on 5173, both reloading on change |
| `npm test` | Unit tests for the rules, plus one end-to-end run of the whole pipeline over HTTP |
| `npm run typecheck` | Typecheck the server and the web client |

## The idea in one object

A **receipt** is a claim with a source, a sign and an expiry date.

| Field | Meaning |
| --- | --- |
| `claim` | One sentence stating the fact, naming the company |
| `source_url` | The public page the claim came from |
| `snippet` | The exact words on that page that support the claim |
| `signal_type` | Job posting, funding, exec hire, tech change, layoffs, hiring freeze, competitor signed, firmographic, contact |
| `sign` | Positive (a reason to contact) or negative (a reason not to) |
| `event_at`, `seen_at`, `expires_at` | When it happened, when it was found, when it stops counting |
| `status` | Unverified, verified or failed, set by the Skeptic |
| `confidence` | 0 to 1, from the extraction step |

Five behaviours follow from that one object, and each is a thing you can click:

1. **Every field has a receipt.** Records write themselves. Every cell in the grid has a chip that opens the exact words and the source. There is no Create Record button.
2. **No receipt, no action.** A lead without a live positive receipt goes to the Not yet queue with the missing evidence named.
3. **Receipts are re-checked, not trusted.** Before a draft reaches a human, the Skeptic re-fetches each cited source and confirms the snippet is still there. Failed claims are struck and stay visible.
4. **Receipts are the audit trail.** AI-versus-rep attribution and stage history come from the same records.
5. **Receipts that earn replies gain weight.** A reply raises the weight of the signal types the email cited, and the change is saved as a new, visible ICP version.

## How it works

Seven roles hand work to each other. The human is one of them.

| Role | Job | Stops when |
| --- | --- | --- |
| Planner | Turns the product description into an ICP and a search plan | ICP fields carry confidence scores |
| Researcher | Finds accounts and signals; writes receipts with sources | Every lead has a live receipt or a dormant reason |
| Enricher | Resolves the contact and email | Contact resolved, or marked low confidence |
| Writer | Drafts outreach; every factual sentence carries receipt ids | No uncited factual sentence remains |
| Skeptic | Re-opens each source and tries to disprove each claim | Every claim is verified or struck |
| Human | Approves, edits or rejects | Nothing sends without this click |
| Analyst | Reads outcomes, reweights signal types, saves the next ICP version | A diff is ready for review |

**State and stage are separate.** State (active, not yet, disqualified) is derived from live receipts on every change and on every clock tick. Stage (Matched to Closed) is the sales position. Keeping them apart is what lets a lead go dormant without leaving the pipeline.

State rules, in [server/domain/state.ts](server/domain/state.ts):

1. Any live negative receipt: **disqualified**, and the reason is the claim.
2. Otherwise at least one live positive trigger: **active**.
3. Otherwise **not yet**: no trigger found, last trigger expired N days ago, or the only trigger failed re-verification.

Scoring, in [server/domain/scoring.ts](server/domain/scoring.ts): 0 to 100, half fit and half intent, with the inputs shown in the lead drawer. Fit is industry 45, headcount band 35, region 20. Intent is each live trigger's weight times its freshness, which falls from 1 to 0.15 across the signal's window. Tiers: A at 65, B at 45, C below. The point values, the windows and the 25% learning step are starting defaults to tune, not measured numbers.

**The email is a list of sentences.** Each is a claim or a connective, and each claim lists the receipts it rests on. Three checks stand between a model and a reviewer: the format check rejects an uncited claim or a figure that is not in the cited source, the Skeptic re-fetches every source, and a draft with no surviving claim is blocked before review.

**The headline metric is catch rate:** claims struck divided by claims drafted. It is the number that proves the system is doing work. Proof rate of sent messages is not the headline, because failed claims are struck before sending and it would always read near 100%.

## The demo world

By default Receipts runs on a seeded world: fourteen fictional company websites served by the app itself under `/world`. They are real HTTP pages, so the Researcher reads them and the Skeptic re-fetches them exactly as it would on the public web. Every page says it is fictional.

The world moves, which is what makes the demo honest:

- After the first crawl, one company takes down a job posting and another rewrites an announcement. The Skeptic catches both.
- **Refresh signals** publishes the next batch of pages and re-reads every site. One dormant lead wakes up.
- **Demo controls** let you take any page down, restore it, or move the clock forward and watch receipts expire.

Demo controls act on the outside world only. The agents find out the same way they would in production: by reading and re-reading sources.

## Demo script

| # | Beat | Where |
| --- | --- | --- |
| 1 | **The failure.** A generic AI email with an invented funding round, next to the Receipts version with every line clickable. | Open a lead, Draft section, **Without** tab |
| 2 | **Intake.** The ICP appears with a confidence per field. Accept one adjacent segment, dismiss the other. | Intake & ICP |
| 3 | **Discovery.** Companies load into the grid. Click a chip and the source sentence opens. | Accounts |
| 4 | **Enrichment.** Emails resolve. Cobalt Ledger drops to low confidence and says so. Tessera Health is unresolved and says so. | Accounts |
| 5 | **Why now.** Signal, company, person, product, plus the warm-intro edge. Press **Play** to watch the receipts travel step by step, from the source page to the human gate. | Graph, with Northbeam AI selected |
| 6 | **The Skeptic.** Vectorly's job posting was taken down; the sentence is struck on screen. Take another page down from Demo controls and press **Re-verify sources**. | Review queue |
| 7 | **Restraint.** Dormant leads with reasons, disqualified leads with negative receipts. Press **Refresh signals** and Brightloop wakes up. Say out loud that you are triggering the refresh. | Not yet |
| 8 | **Approval.** Approve one draft, reject one. The approved card moves to Contacted with an AI badge. | Review queue, Pipeline |
| 9 | **Credits.** The woken lead needs enriching, the balance is too low, the pipeline gates itself and says so. Top up to resume. | Header |
| 10 | **Learning.** Mark a reply. The signal type gains weight, scores re-rank and ICP v2 appears as a diff against v1. | Pipeline, then Intake & ICP |

Beats 1, 6 and 7 carry the pitch. If time is short, show those three plus approval.

The **Graph** screen can also carry beats 5 to 8 on its own. Pick a lead and it walks that lead's real records as an animated, step-by-step path: the page, the receipt, fit, freshness, the contact, the draft, the Skeptic re-opening each source, and the human gate. Vectorly shows a claim being struck, Fathom Works a draft being blocked, and Kestrel Systems a lead being held back before any credits are spent. Use the arrow keys to step, `R` to replay and `Space` to play or pause. The animation follows the system's reduced-motion setting until you press Play or turn Motion on.

## Configuration

Copy [.env.example](.env.example) to `.env`. Everything is optional.

| Variable | Effect |
| --- | --- |
| `ANTHROPIC_API_KEY` | Model-backed Planner and Writer. Every model call has a deterministic fallback, so a failed or malformed response never stops the pipeline. |
| `RECEIPTS_SOURCE=live` | Search and read the public web instead of the seeded world. Needs the key above. |
| `FLEXPRICE_API_KEY`, `FLEXPRICE_CUSTOMER_ID` | Mirror metered events (enrich, draft, send) to Flexprice. |
| `BAND_API_KEY`, `BAND_CHAT_ID` | Send handoff and block events to a Band room as the Receipts Orchestrator remote agent. |
| `BAND_API_BASE_URL` | Band API base URL; defaults to `https://app.band.ai/api/v1`. |
| `AGENT_EVENTS_WEBHOOK_URL` | Additionally POST every agent handoff as JSON to a generic external orchestrator. |

## Band Desktop

Receipts is ready to join a Band room without making Band a dependency of the product flow. Create a **Remote Agent** named `Receipts Orchestrator` in Band, add it to the hackathon room, and put its one-time API key and the room ID in `.env` as `BAND_API_KEY` and `BAND_CHAT_ID`. `GET /api/band/status` confirms the connection is configured without exposing credentials.

On every handoff or block, Receipts writes a first-class Band room event with the originating role (`planner`, `researcher`, `enricher`, `writer`, `skeptic`, `human`, or `analyst`), the lead/reference where available, and an event time. Band remains the shared observability and human-collaboration surface; the product pipeline stays resilient if Band is offline. This is intentional: Band text messages route work only with concrete participant @mentions, while Receipts itself executes the pipeline.

## What is real and what is simulated

Real, and covered by tests:

- Receipts, expiry, the state rules, scoring, tiers and ICP versions.
- Source fetching, snippet checking and the Skeptic's re-verification, over real HTTP.
- The sentence format, the figure check and the block on drafts with no surviving claim.
- The review queue, the human gate, stage transitions with attribution, the credit ledger and its gate.

Simulated, on purpose:

- **Email delivery.** Approving a draft logs the send. Nothing leaves the machine.
- **The demo world.** Fictional companies, served locally.
- **Email guessing.** One pattern (`first.last@domain`), always labelled as a guess with no receipt.

Written but not yet exercised against the real service:

- **Model-backed agents and live web mode.** The code paths typecheck and fall back cleanly, but have not been run with a key.
- **Flexprice.** Events are posted to `POST /v1/events`; the local ledger remains the source of truth for the gate.
- **Band.** A configured Band Agent API integration writes each handoff and block to the selected Band room; role metadata preserves the seven-agent story. `GET /api/band/status` shows whether it is configured.

## Layout

```
shared/            Types and constants used by both sides
server/
  domain/          Pure rules: state, scoring, snippet matching
  agents/          Planner, Researcher, Enricher, Writer, Skeptic, Analyst, orchestrator
  services/        Store, ledger, activity feed, fetcher, snapshot, model client
  world/           The seeded demo world and its routes
  integrations/    Flexprice and handoff webhook
web/src/           React client: one view per screen
test/              Rule tests and the end-to-end pipeline test
```

One SQLite file (`data/receipts.db`, created on first run) is the only store. The knowledge graph is a projection of it.

## License

MIT. See [LICENSE](LICENSE).
