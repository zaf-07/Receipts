import { useState } from 'react';
import type { LeadView, Stage } from '../../../shared/types';
import { STAGES } from '../../../shared/constants';
import { useUi } from '../api';
import { Empty, StateBadge, Tier } from '../components';

function Card({ lead }: { lead: LeadView }) {
  const { act, openLead, reviewer } = useUi();
  const next = STAGES[STAGES.indexOf(lead.stage) + 1];
  const move = (to: Stage) => act(`/leads/${lead.id}/stage`, { to_stage: to, actor: reviewer });
  return (
    <article
      className="card"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/lead', lead.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onClick={() => openLead(lead.id)}
    >
      <header>
        <strong>{lead.company.name}</strong>
        <Tier tier={lead.tier} />
      </header>
      <p className="muted small">
        {lead.person
          ? `${lead.person.name}, ${lead.person.title}`
          : lead.enrich_status === 'unresolved'
            ? 'Contact unresolved'
            : lead.enrich_status === 'blocked_credits'
              ? 'On hold: credit gate'
              : 'No contact yet'}
      </p>
      <footer>
        {lead.stage_actor ? (
          <span className={`who who-${lead.stage_actor}`} title={lead.transitions.filter((t) => t.to_stage === lead.stage).pop()?.note ?? ''}>
            {lead.stage_actor === 'agent' ? 'AI' : 'Rep'}
          </span>
        ) : (
          <span className="who who-agent" title="Matched by the Researcher">
            AI
          </span>
        )}
        {lead.state !== 'active' && <StateBadge state={lead.state} />}
        {lead.stage === 'Contacted' && (
          <button
            type="button"
            className="btn small"
            onClick={(e) => {
              e.stopPropagation();
              void move('Replied');
            }}
          >
            Mark reply
          </button>
        )}
        {lead.stage !== 'Contacted' && lead.stage !== 'Matched' && next && next !== 'Lost' && (
          <button
            type="button"
            className="btn small"
            onClick={(e) => {
              e.stopPropagation();
              void move(next);
            }}
          >
            {next}
          </button>
        )}
      </footer>
    </article>
  );
}

export function Pipeline() {
  const { snap, act, reviewer } = useUi();
  const [over, setOver] = useState<Stage | null>(null);
  // Matched holds leads with a live reason. Later stages keep their cards even if the lead goes dormant.
  const inStage = (stage: Stage) => snap.leads.filter((l) => l.stage === stage && (stage !== 'Matched' || l.state === 'active'));

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Pipeline</h1>
          <p>
            Approving a draft moves the card from Matched to Contacted with an AI badge. Moves you make by hand carry a Rep badge. Marking a reply triggers the
            Analyst. Drag a card to move it.
          </p>
        </div>
      </header>
      {snap.leads.length === 0 ? (
        <Empty title="The pipeline is empty">Run discovery first.</Empty>
      ) : (
        <div className="kanban">
          {STAGES.map((stage) => {
            const cards = inStage(stage);
            return (
              <section
                key={stage}
                className={`column ${over === stage ? 'over' : ''}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setOver(stage);
                }}
                onDragLeave={() => setOver((s) => (s === stage ? null : s))}
                onDrop={(e) => {
                  e.preventDefault();
                  setOver(null);
                  const id = e.dataTransfer.getData('text/lead');
                  if (id) void act(`/leads/${id}/stage`, { to_stage: stage, actor: reviewer });
                }}
              >
                <header>
                  <h3>{stage}</h3>
                  <b>{cards.length}</b>
                </header>
                {cards.map((l) => (
                  <Card key={l.id} lead={l} />
                ))}
                {cards.length === 0 && <p className="column-empty">Empty</p>}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
