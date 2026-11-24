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

## Documents

- [System design and architecture](docs/ARCHITECTURE.md): data model, reasoning loops, graph ontology and queries, the agent team, integrated services.
- [Receipts in a Band room](docs/BAND.md): the crew, who talks to whom, one flow end to end, setup.
- [Demo video script](docs/DEMO_SCRIPT.md): a 2 to 3 minute walkthrough, beat by beat.

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

Eight roles hand work to each other. The human is one of them.

| Role | Job | Stops when |
| --- | --- | --- |
| Planner | Turns the product description into an ICP and a search plan | ICP fields carry confidence scores |
| Researcher | Finds accounts and signals; writes receipts with sources | Every lead has a live receipt or a dormant reason |
| Enricher | Resolves the contact and email | Contact resolved, or marked low confidence |
| Writer | Drafts email A and LinkedIn B outreach; every factual sentence carries receipt ids | No uncited factual sentence remains |
| Skeptic | Re-opens each source and tries to disprove each claim | Every claim is verified or struck |
| Security | Scans the verified draft for unverified links, leaked internal data and a wrong recipient | The draft is cleared, or blocked with the finding named |
| Human | Approves, edits or rejects | Nothing sends without this click |
| Analyst | Reads outcomes, reweights signal types, saves the next ICP version | A diff is ready for review |

**State and stage are separate.** State (active, not yet, disqualified) is derived from live receipts on every change and on every clock tick. Stage (Matched to Closed) is the sales position. Keeping them apart is what lets a lead go dormant without leaving the pipeline.

State rules, in [server/domain/state.ts](server/domain/state.ts):

1. Any live negative receipt: **disqualified**, and the reason is the claim.
2. Otherwise at least one live positive trigger: **active**.
3. Otherwise **not yet**: no trigger found, last trigger expired N days ago, or the only trigger failed re-verification.

Scoring, in [server/domain/scoring.ts](server/domain/scoring.ts): 0 to 100, half fit and half intent, with the inputs shown in the lead drawer. Fit is industry 45, headcount band 35, region 20. Intent is each live trigger's weight times its freshness, which falls from 1 to 0.15 across the signal's window. Tiers: A at 65, B at 45, C below. The point values, the windows and the 25% learning step are starting defaults to tune, not measured numbers.

**The email is a list of sentences.** Each is a claim or a connective, and each claim lists the receipts it rests on. Three checks stand between a model and a reviewer: the format check rejects an uncited claim or a figure that is not in the cited source, the Skeptic re-fetches every source, and a draft with no surviving claim is blocked before review.

**Every outreach sequence has two variants.** Variant A is email and variant B is LinkedIn. They are separately receipted, checked, reviewed, and recorded so the dashboard can compare drafts, sends, replies and meetings by variant without attributing an outcome to unsupported copy.

**The headline metric is catch rate:** claims struck divided by claims drafted. It is the number that proves the system is doing work. Proof rate of sent messages is not the headline, because failed claims are struck before sending and it would always read near 100%.

## The agent team

The eight roles run as a team with one lead. The **orchestrator** plans, assigns and reconciles, and does no agent work itself. The roles do scoped work in parallel and return an outcome. A worker cannot create a task, close a review or send anything: only the orchestrator decides what happens next.

```
Planner      one ICP run
Researcher   one search task, then one read task per account, in parallel
Enricher     one task per active lead, in parallel
Writer       one task per enriched lead, in parallel
Skeptic      one task per draft, in parallel
Security     one scan per verified draft
Human gate   one review task per cleared draft
Analyst      one task per outcome
```

**Every unit of work is a durable task run** (`task_runs`, in [server/services/tasks.ts](server/services/tasks.ts)):

| Field | Meaning |
| --- | --- |
| `id`, `run_id`, `lead_id`, `agent`, `kind` | Which task, in which pipeline run, for which lead, done by whom |
| `status` | `queued`, `running`, `blocked`, `review`, `done` or `failed` |
| `depends_on` | Tasks that must be done first. A task is never leased before them |
| `attempt`, `max_attempts` | How many times it has been tried |
| `lease_owner`, `lease_expires_at` | Who holds it, and until when |
| `input_receipt_ids`, `output_receipt_ids`, `output_message_ids` | What it was given and what it produced |
| `blocker`, `blocker_code`, `error`, `result` | Why it is stuck, why it failed, or what happened |

The rules that make parallel work safe:

- **A task is leased, not owned.** A worker holds a task for a short lease and renews it with a heartbeat. If the worker stops, the lease expires and the task is taken back and retried. A restart resumes the pipeline.
- **A task settles once.** Only the worker holding the current lease can settle a task, so a stale worker's late result is dropped.
- **Planning is idempotent.** Every task has a key (`enrich:<lead>`, `verify:<draft>:<n>`). Planning the same step twice returns the same task, and a retried task does not pay twice.
- **Blocked is a real state.** A task that cannot proceed says why. Credits are held per task in priority order, so parallel work cannot overspend, and a lead that is started can be finished.
- **Agents append, never overwrite.** The Skeptic adds a verdict (`verifications`) and a new draft version (`message_versions`); the Writer's version stays in the history. Lead state is derived by the orchestrator from the receipts.
- **One door out.** [server/services/delivery.ts](server/services/delivery.ts) is the only code that can mark a message sent. It needs an open human review task for that exact draft and refuses to run from inside any agent task.

The **Agent team** screen shows the team shape, every task by status, and each task's inputs, outputs, attempts, blocker and draft history. The activity sidebar is the event stream: each handoff is linked to its task and shows the receipts involved. Events are collected in one place, the task records are the model, and the screens only render them.

`RECEIPTS_CONCURRENCY` (default 4) sets how many tasks run at once, and `RECEIPTS_LEASE_MS` (default 30000) sets the lease length.

The coordination pattern is inspired by Tomville's lead-and-workers discipline: explicit assignment, visible blocked states, logged handoffs, review before completion and isolated parallel work. No Tomville code or runtime is used.

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
| `ANTHROPIC_API_KEY` | Anthropic-backed Planner and Writer. Every model call has a deterministic fallback, so a failed or malformed response never stops the pipeline. |
| `GROQ_API_KEY` | Uses Groq for the Planner and Writer; defaults to `openai/gpt-oss-20b`. Set `RECEIPTS_LLM_PROVIDER=anthropic` to override. |
| `MOSS_PROJECT_ID`, `MOSS_PROJECT_KEY` | Enables `GET /api/search?q=...`, hybrid semantic search over existing receipts. Moss ranks evidence; SQLite remains the source of truth. |
| `RECEIPTS_SOURCE=live` | Search and read the public web instead of the seeded world. Needs the key above. |
| `FLEXPRICE_API_KEY`, `FLEXPRICE_CUSTOMER_ID` | Mirror metered events (enrich, draft, send) to Flexprice. |
| `BAND_API_KEY`, `BAND_CHAT_ID` | Join a Band room as the Receipts Orchestrator agent. |
| `BAND_KEY_PLANNER` ... `BAND_KEY_ANALYST` | Optional: one Band agent key per role (`PLANNER`, `RESEARCHER`, `ENRICHER`, `WRITER`, `SKEPTIC`, `SECURITY`, `ANALYST`), so each role speaks and is mentioned as itself. |
| `BAND_HUMAN_HANDLE` | The person in the room who decides. Defaults to the room owner. |
| `BAND_API_BASE_URL` | Band API base URL; defaults to `https://app.band.ai/api/v1`. |
| `AGENT_EVENTS_WEBHOOK_URL` | Additionally POST every agent handoff as JSON to a generic external orchestrator. |

## Band

The agent team runs in a Band room. The room is where one agent hands work to the next, and where a named person makes the call that releases a send.

- **Each role can be its own Band agent.** A handoff is a message that mentions the next agent, as Band requires for routing: Enricher to Writer, Writer to Skeptic, Skeptic to Security.
- **The decision happens in the room.** A verified, security-cleared draft is put to the room owner with a blocking review. Their reply, `approve m_ab12cd` or `reject m_ab12cd <reason>`, is what releases or stops the send.
- **Only a person can decide.** A reply is acted on only when Band says a user sent it, and it runs the same approval as the review queue.
- **People can steer.** Mention an agent with an instruction and it is kept as a note for that agent.

Set `BAND_API_KEY` and `BAND_CHAT_ID`, and optionally one `BAND_KEY_<ROLE>` per role. Band stays optional: without it, or if it is unreachable, the pipeline runs the same and decisions are taken in the review queue.

The crew, a full flow, setup steps and what has been tested are in [docs/BAND.md](docs/BAND.md).

## What is real and what is simulated

Real, and covered by tests:

- Receipts, expiry, the state rules, scoring, tiers and ICP versions.
- Source fetching, snippet checking and the Skeptic's re-verification, over real HTTP.
- The sentence format, the figure check and the block on drafts with no surviving claim.
- The review queue, the human gate, stage transitions with attribution, the credit ledger and its gate.

Simulated, on purpose:

- **Email and LinkedIn delivery.** Approving a draft logs the send. Nothing leaves the machine.
- **The demo world.** Fictional companies, served locally.
- **Email guessing.** One pattern (`first.last@domain`), always labelled as a guess with no receipt.

## Inbound replies

`POST /api/inbound` accepts a provider-normalized payload with `message_id`, `text`, and an optional `source`.
It only accepts replies to messages that were already sent. A reply advances the lead from Contacted to Replied, creates the next ICP version from the cited receipts, and replies containing booking language also advance it to Meeting Booked. The endpoint is intentionally provider-neutral; a production mail-provider adapter still needs the provider's webhook-signature verification configured before it is exposed publicly.

Written but not yet exercised against the real service:

- **Model-backed agents and live web mode.** The code paths typecheck and fall back cleanly, but have not been run with a key.
- **Flexprice.** Events are posted to `POST /v1/events`; the local ledger remains the source of truth for the gate.
- **Band.** Built to Band's documented Agent API and tested against a stand-in for it: mention handoffs, the blocking review, and a person approving in the room. It has not yet been run in a real Band room.

## Layout

```
shared/            Types and constants used by both sides
server/
  domain/          Pure rules: state, scoring, snippet matching
  agents/          Planner, Researcher, Enricher, Writer, Skeptic, Analyst, the orchestrator and the worker pool
  services/        Store, task runs and leases, delivery guard, ledger, activity stream, fetcher, snapshot, model client
  world/           The seeded demo world and its routes
  integrations/    Flexprice and handoff webhook
web/src/           React client: one view per screen
test/              Rule tests, scheduler tests (concurrency, retries, leases, idempotency), send-gate tests, and the end-to-end pipeline test
```

One SQLite file (`data/receipts.db`, created on first run) is the only store. The knowledge graph is a projection of it.

## License

MIT. See [LICENSE](LICENSE).
