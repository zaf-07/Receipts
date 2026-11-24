import { Fragment, useEffect, useMemo, useState } from 'react';
import type { GraphAnswer, ReceiptView } from '../../../shared/types';
import { call, useUi } from '../api';
import { Chip, Empty } from '../components';
import { receiptIndex } from './Team';

// Questions that take more than one hop to answer. Each row is a path through the graph, with
// the receipts behind its edges. Every question asked is counted as a metered graph query.

type Question = Pick<GraphAnswer, 'name' | 'question' | 'pattern'>;

export function GraphQuestions() {
  const { snap, openLead } = useUi();
  const [questions, setQuestions] = useState<Question[]>([]);
  const [name, setName] = useState<string | null>(null);
  const [answer, setAnswer] = useState<GraphAnswer | null>(null);
  const index = useMemo(() => receiptIndex(snap), [snap]);

  useEffect(() => {
    void call<Question[]>('/graph/questions').then((q) => {
      setQuestions(q);
      setName((current) => current ?? q[0]?.name ?? null);
    });
  }, []);

  // Asked again when the pipeline changes shape, not on every activity line.
  const shape = snap.leads.map((l) => `${l.id}${l.state}${l.stage}${l.person?.id ?? ''}${l.receipts.length}`).join('|');
  useEffect(() => {
    if (!name) return;
    let live = true;
    void call<GraphAnswer>(`/graph/query/${name}`).then((a) => live && setAnswer(a));
    return () => {
      live = false;
    };
  }, [name, shape]);

  if (snap.leads.length === 0) return <Empty title="Nothing to ask yet">The graph is derived from receipts. Run discovery first.</Empty>;

  return (
    <div className="gq">
      <div className="gq-list" role="tablist" aria-label="Graph questions">
        {questions.map((q) => (
          <button key={q.name} type="button" role="tab" aria-selected={q.name === name} className={q.name === name ? 'active' : ''} onClick={() => setName(q.name)}>
            {q.question}
          </button>
        ))}
        <p className="muted small">
          {snap.metrics.usage.graph_queries} graph queries evaluated so far. Each one is a metered event.
        </p>
      </div>

      <section className="gq-answer" aria-live="polite">
        {!answer || answer.name !== name ? (
          <p className="muted">Walking the graph.</p>
        ) : (
          <>
            <h2 className="group">{answer.question}</h2>
            <p className="gq-pattern">{answer.pattern}</p>
            {answer.rows.length === 0 ? (
              <p className="muted">No path matches yet. This fills in as receipts arrive.</p>
            ) : (
              <ol className="gq-rows">
                {answer.rows.map((row, i) => (
                  <li key={i}>
                    <div className="gq-path">
                      {row.path.map((node, j) => (
                        <Fragment key={j}>
                          {j > 0 && <i>→</i>}
                          <b>{node}</b>
                        </Fragment>
                      ))}
                    </div>
                    <p>
                      {row.note}{' '}
                      {row.receipt_ids
                        .map((id) => index.get(id))
                        .filter((r): r is ReceiptView => Boolean(r))
                        .map((r) => (
                          <Chip key={r.id} r={r} now={snap.now} />
                        ))}
                      {row.lead_id && (
                        <button type="button" className="link" style={{ marginLeft: 8 }} onClick={() => openLead(row.lead_id!)}>
                          open lead
                        </button>
                      )}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </>
        )}
      </section>
    </div>
  );
}
