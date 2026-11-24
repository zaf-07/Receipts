# Receipts in a Band room

Receipts runs its agent team in a Band room. The room is where one agent hands work to the next, and where a named person makes the call that releases a send.

This page covers the crew, who talks to whom, one flow end to end, what breaks without the room, and how to set it up.

## The crew

| Agent | What it does | Hands off to |
| --- | --- | --- |
| Planner | Turns the product description into an ICP and a search plan | Researcher |
| Researcher | Finds accounts and signals; writes a receipt for every fact | Enricher |
| Enricher | Resolves the contact; marks a guessed email as a guess | Writer |
| Writer | Drafts outreach in which every factual sentence cites receipts | Skeptic |
| Skeptic | Re-opens every cited source and strikes what it cannot confirm | Security |
| Security | Scans the verified draft for unverified links, leaked internal data and a wrong recipient | Human |
| Human | Approves or rejects, in the room | Analyst |
| Analyst | Reweights signal types from the reply and saves the next ICP version | Planner |

Each role can be its own Band remote agent with its own API key, so it speaks and is mentioned as itself. A role without a key speaks through the orchestrator's agent and says so (`[planner] ...`).

The Skeptic and the Security agent are critics: no draft reaches a person without passing both, and either can block it.

## Who talks to whom

Band routes a message only to the participants it mentions, so every handoff is a message that mentions the next agent.

```mermaid
sequenceDiagram
    participant E as Enricher
    participant W as Writer
    participant S as Skeptic
    participant X as Security
    participant H as Human (room owner)
    participant O as Orchestrator
    E->>W: @writer Northbeam AI: Priya Raman, VP Engineering. Receipts r_.. Yours to draft.
    W->>S: @skeptic Northbeam AI: 2 variants drafted. Claims cite r_.., r_.. Re-open every source.
    S->>X: @security Northbeam AI, email: 3 of 3 claims verified. Yours to scan.
    X->>H: @dana Northbeam AI: the email to Priya Raman is verified and cleared. Reply "approve m_ab12cd".
    Note over X,H: attention event, kind review, blocking
    H->>X: @security approve m_ab12cd
    O->>H: @dana m_ab12cd approved by Dana. The send is logged.
    Note over O,H: event that resolves the review
```

What goes into the room:

- **Mention messages** for handoffs, one per lead per step. Each carries the receipt ids the next agent needs.
- **An attention event** (`kind: review`, `blocking: true`) for every draft that is waiting for a person, resolved by a later event when the decision is made.
- **Execution events** (`thought`, `error`) mirroring every handoff and block from the activity stream, so the people in the room can follow the work.

## One flow, end to end

1. The Researcher reports which leads have a live reason to contact and mentions the Enricher.
2. The Enricher resolves a contact for one lead and mentions the Writer with the contact's receipts.
3. The Writer drafts and mentions the Skeptic with the receipt ids its claims rest on.
4. The Skeptic re-fetches each source. One job posting has been taken down, so it strikes that sentence and mentions Security with the result.
5. Security finds no outbound links, no internal data and a recipient at the target company. It mentions the room owner and raises a blocking review.
6. The owner replies `approve m_ab12cd` in the room.
7. Receipts checks that the reply came from a person, runs the same approval as its own review queue, logs the send, resolves the review and confirms in the room.

If the Skeptic leaves no claim standing, it tells the human directly and no review is raised. If the owner replies `reject m_ab12cd too generic`, the draft is rejected with that reason and nothing is sent.

A person can also instruct an agent: `@writer keep every email under sixty words`. The instruction is stored as a note on that agent's standing task and applied on its next run.

## What breaks without the room

- **The decision has no place to happen in the open.** In the room, the request, the evidence it rests on, the person's answer and the outcome sit in one thread that everyone can see.
- **Handoffs become invisible.** Without the mention messages, one agent's finding (a struck claim, a guessed email) reaches the next only inside Receipts.
- **Nobody outside the app can steer.** Instructions to an agent from the room are how a teammate who is not in Receipts changes what the Writer does next.

The pipeline itself does not stop. Band is best-effort: if the room is unreachable, tasks still run and decisions are taken in the Receipts review queue. That is deliberate, because a send gate must not depend on a third party being up.

## Safety

- **Only a person can approve.** A reply is acted on only when Band reports `sender_type: "User"`. A message from any agent, including our own, is consumed and ignored.
- **The room has no shortcut to delivery.** A reply runs the same `approve` as the review queue, which needs an open human review task for that exact draft. The delivery service repeats the evidence check and the security scan before it logs a send.
- **Instructions are bounded.** A note from the room is capped in length and passed to the model as operator intent, to be followed only within the evidence rules.

## The task board

Each lead's outreach is one card on the room's task board (the **Work** tab in Band Desktop). The orchestrator creates the card, and every agent reports its own status on it as the work reaches it, which is how Band assigns work: an agent joins a card by reporting on it, and nobody can report for another agent.

| Moment | Who reports | Status on the card |
| --- | --- | --- |
| The lead is handed to the Enricher | Enricher | `in_progress` |
| Contact resolved | Enricher, then Writer | `completed`, then `in_progress` |
| Draft written | Writer, then Skeptic | `completed`, then `in_progress` |
| Sources re-opened | Skeptic, then Security | `completed`, then `in_progress` |
| Draft cleared | Security | `in_review`, with a blocking review that points at the card |
| A person decides | Security | `completed`, or still `in_review` while another draft for the lead waits |
| No contact, every claim struck, a failed scan, or no credits | The agent that stopped | `blocked`, with the reason |

The result of each step is kept as a comment on the card, so the card carries its own history. **Reset the demo** archives the cards of the previous run.

## Setup with Band Desktop

1. Install Band Desktop and sign in. The `band` command-line tool comes with it.
2. Create one agent per role. From this folder:

   ```
   band agent create --identity-only --name "Receipts Orchestrator" --description "Runs the Receipts GTM pipeline." --session receipts-orchestrator
   ```

   Repeat for Planner, Researcher, Enricher, Writer, Skeptic, Security and Analyst. Two or three are enough to show real handoffs; a role without its own agent speaks through the orchestrator and says so.
3. In Band Desktop, open **Agents**, open each agent, and choose **⋮ → API key…** to copy its key.
4. Stop the local workers, because Receipts is the runtime for these agents and two clients would compete for the same messages:

   ```
   band stop --all
   ```

5. Create a room and add yourself. Any room the orchestrator is in works; its id is in the room URL and in `band room list`.
6. Put the values in `.env`:

   ```
   BAND_API_KEY=<orchestrator key>
   BAND_CHAT_ID=<room id>
   BAND_KEY_WRITER=<writer key>
   BAND_KEY_SKEPTIC=<skeptic key>
   BAND_KEY_SECURITY=<security key>
   ```

7. Start Receipts. On start it validates each key, adds the role agents to the room and logs who decisions go to. `GET /api/band/status` and the Agent team screen show the connection.

To decide on a draft, type `@` in the room, pick the agent that asked (Receipts Security), and write `approve m_ab12cd` or `reject m_ab12cd <reason>`.

Other settings: `BAND_HUMAN_HANDLE` picks the person who decides when it should not be the first person in the room, `BAND_API_BASE_URL` overrides the host, and `BAND_POLL_MS` sets how often replies are checked (default 4000).

## What has and has not been tested

- **Run in a real Band room, from Band Desktop.** Eight agents created with the `band` tool, their keys read from Band Desktop, and a full pipeline run against `app.band.ai`: every key validated, the agents added to the room, 120-odd messages, events and card updates accepted with no errors, the mention handoffs and the blocking reviews shown in the room, and the cards shown on the Work board.
- **What the real room changed.** Band stores a mention inside the text as `@[[participant-id]]`, so replies are parsed for that form as well as a typed handle. Band also reads the owner's handle at the front of `@owner/agent` as a mention of the owner, so instructions name the agent instead of writing its handle. Both are now in the stand-in.
- **A person approving in the real room: not yet.** The reply path is covered by the stand-in tests, which use the real message shape, but the approval itself has to be typed by a person, and that has not been done in the real room yet.
- **The stand-in.** [test/band.test.ts](../test/band.test.ts) runs the whole flow against a stand-in for Band's Agent API written from [docs.band.ai](https://docs.band.ai/api/agent-api). It enforces Band's documented rules: a mention is required, the mentioned participant must be in the room, and an agent cannot mention itself. The test suite never reads `.env`, so it cannot reach a real room.
- **Polling, not WebSocket.** Replies are read with Band's `messages/next` endpoint on a timer. Band recommends its WebSocket for production; polling keeps the integration to plain HTTP.
- **One process.** The agents are separate identities in the room, but they run in one Receipts process. The handoffs that route work inside Receipts are its own task runs; the room carries the same handoffs in the open and carries the human decision for real.
- **Not Band-run agents.** In Band Desktop these agents show as command-line agents with no active session, because Band does not start them: Receipts does their work and speaks for them through the Agent API.
