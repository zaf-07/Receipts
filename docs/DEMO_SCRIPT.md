# Demo video script (2 to 3 minutes)

One take, one screen, one voice. The line to land: **"AI SDRs send confident nonsense. Ours can't."**

## Before recording

1. `npm run demo`, open http://localhost:8787.
2. Demo controls → **Reset the demo**.
3. If Band is connected, open the Band room in a second window, side by side.
4. Hide the activity panel until beat 6 so the screen is not busy.

Without model credentials the run is the same, with rule-based agents. With credentials the Planner takes about ten seconds; start it before you start talking.

## The script

| Time | Screen | Say |
| --- | --- | --- |
| 0:00 | Lead drawer → Draft → **Without** tab | "This is what an AI SDR sends. A funding round that never happened, a post nobody wrote. Every red line has no source. This burns the lead and the sender's domain." |
| 0:15 | **Intake & ICP** → Load the example → Plan the ICP | "We give Receipts two lines about the product. It infers the ICP, with a confidence on every field, and proposes adjacent segments. I accept one and dismiss the other." |
| 0:35 | **Run discovery** → **Accounts** | "It finds accounts and writes a receipt for every fact. Nothing here was typed in. Click any cell: the exact words, and the page they came from." |
| 0:55 | **Agent team** | "Eight agents work in parallel under one orchestrator: one task per account, per lead, per draft. Each task is leased, retried if its worker dies, and settled once." |
| 1:15 | **Graph** → pick Vectorly → Play | "Follow one lead. A page says something. A receipt is written. The Writer cites it. Then the Skeptic re-opens the source, and the job posting has been taken down. The sentence is struck before any person sees it." |
| 1:40 | **Not yet** | "And these are the leads it refused to contact. No trigger, an expired one, or a reason not to: layoffs, a hiring freeze, already signed with a competitor. Restraint is a state, not a filter." |
| 1:55 | **Review queue** (or the Band room) → approve one, reject one | "Nothing sends without a person. I approve one and reject one." If Band is connected: "The Security agent asks me in the room, with the evidence. I reply approve, and that reply is what releases the send." |
| 2:15 | **Pipeline** | "The card moved to Contacted with an AI badge. Every move records who made it." |
| 2:25 | **Not yet** → Refresh signals → header | "New signals arrive and a dormant lead wakes up. Enriching it needs credits we do not have, so the pipeline gates itself and says so." |
| 2:40 | **Pipeline** → Mark reply → **Intake & ICP** version history | "A lead replies. The signal that earned it gains weight, and ICP v2 appears as a diff." |
| 2:50 | **Dashboard** | "Catch rate: the share of drafted claims we struck before a human saw them. That number is the product. Proof is what licenses autonomy." |

## If time is short

Keep four beats: the failure (0:00), the Skeptic striking a claim (1:15), the Not yet queue (1:40), and the human approval (1:55).

## What to say if asked

- **"Is the data real?"** The companies are fictional and served by the app, so the Skeptic can really re-fetch pages that really change. Live web mode reads the public web through the same pipeline.
- **"Does it send email?"** No. Approving logs the send. That is deliberate for a demo.
- **"What is the catch rate measuring?"** Claims the Skeptic struck, divided by claims drafted. Proof rate of sent messages would always read near 100%, because failed claims never reach sending.
- **"Why should I trust the gate?"** One function can mark a message sent. It needs an open human review task for that exact draft and refuses to run from inside an agent. A test checks that no other code can do it.
