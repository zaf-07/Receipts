import { useEffect, useMemo, useState } from 'react';
import type { Graph, GraphEdge, GraphNode } from '../../../shared/types';
import { call, useUi } from '../api';
import { Empty } from '../components';
import { LeadJourney } from './LeadJourney';
import { GraphQuestions } from './GraphQuestions';

const COL = { Signal: 130, Company: 380, Person: 630, Right: 880 };
const ROW = 30;

const EDGE_LABEL: Record<GraphEdge['type'], string> = {
  has_signal: 'has signal',
  works_at: 'works at',
  previously_employed_at: 'previously employed at',
  matched_to: 'matched to',
  competes_with: 'competes with',
  contacted_via: 'contacted',
  replied_to: 'replied',
  customer_of: 'customer of',
};

interface Placed extends GraphNode {
  x: number;
  y: number;
  lead: string | null;
}

export function GraphView() {
  const [tab, setTab] = useState<'journey' | 'all' | 'questions'>('journey');
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Graph</h1>
        </div>
        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'journey'} className={tab === 'journey' ? 'active' : ''} onClick={() => setTab('journey')}>
            One lead, step by step
          </button>
          <button type="button" role="tab" aria-selected={tab === 'all'} className={tab === 'all' ? 'active' : ''} onClick={() => setTab('all')}>
            All accounts
          </button>
          <button type="button" role="tab" aria-selected={tab === 'questions'} className={tab === 'questions' ? 'active' : ''} onClick={() => setTab('questions')}>
            Multi-hop questions
          </button>
        </div>
      </header>
      {tab === 'journey' ? <LeadJourney /> : tab === 'all' ? <AccountsGraph /> : <GraphQuestions />}
    </div>
  );
}

function AccountsGraph() {
  const { snap, openLead } = useUi();
  const [graph, setGraph] = useState<Graph | null>(null);
  const [hover, setHover] = useState<string | null>(null);

  // Refetch when the shape of the pipeline changes, not on every activity line.
  const signature = snap.leads.map((l) => `${l.id}${l.state}${l.stage}${l.person?.id ?? ''}${l.receipts.length}`).join('|') + snap.competitors.length;
  useEffect(() => {
    let live = true;
    void call<Graph>('/graph').then((g) => live && setGraph(g));
    return () => {
      live = false;
    };
  }, [signature]);

  const layout = useMemo(() => {
    if (!graph) return null;
    const leadOf = new Map<string, string>();
    for (const l of snap.leads) {
      leadOf.set(l.company.id, l.id);
      if (l.person) leadOf.set(l.person.id, l.id);
      for (const r of l.receipts) leadOf.set(r.id, l.id);
    }
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const signalsOf = new Map<string, string[]>();
    const personOf = new Map<string, string>();
    for (const e of graph.edges) {
      if (e.type === 'has_signal') signalsOf.set(e.to, [...(signalsOf.get(e.to) ?? []), e.from]);
      if (e.type === 'works_at') personOf.set(e.to, e.from);
    }

    const placed = new Map<string, Placed>();
    const order = { active: 0, not_yet: 1, disqualified: 2 } as Record<string, number>;
    const companies = graph.nodes.filter((n) => n.type === 'Company').sort((a, b) => (order[a.state ?? ''] ?? 3) - (order[b.state ?? ''] ?? 3));
    let y = 40;
    for (const c of companies) {
      const signals = signalsOf.get(c.id) ?? [];
      const rows = Math.max(1, signals.length);
      const mid = y + ((rows - 1) * ROW) / 2;
      placed.set(c.id, { ...c, x: COL.Company, y: mid, lead: leadOf.get(c.id) ?? null });
      signals.forEach((id, i) => {
        const n = byId.get(id);
        if (n) placed.set(id, { ...n, x: COL.Signal, y: y + i * ROW, lead: leadOf.get(id) ?? null });
      });
      const pid = personOf.get(c.id);
      const p = pid ? byId.get(pid) : null;
      if (p) placed.set(p.id, { ...p, x: COL.Person, y: mid, lead: leadOf.get(p.id) ?? null });
      y += rows * ROW + 14;
    }
    const height = Math.max(y + 20, 360);

    const customers = graph.nodes.filter((n) => n.type === 'Customer');
    const rivals = graph.nodes.filter((n) => n.type === 'Competitor');
    const product = graph.nodes.find((n) => n.type === 'Product');
    const centre = height / 2;
    customers.forEach((n, i) => placed.set(n.id, { ...n, x: COL.Right, y: 50 + i * 34, lead: null }));
    if (product) placed.set(product.id, { ...product, x: COL.Right, y: Math.max(centre, 50 + customers.length * 34 + 50), lead: null });
    rivals.forEach((n, i) => placed.set(n.id, { ...n, x: COL.Right, y: height - 40 - (rivals.length - 1 - i) * 34, lead: null }));

    return { placed, height };
  }, [graph, snap.leads]);

  if (snap.leads.length === 0) return <Empty title="Nothing to project yet">The graph is derived from receipts. Run discovery first.</Empty>;
  if (!graph || !layout) return <Empty title="Loading the graph" />;

  const { placed, height } = layout;
  const hoverLead = hover ? placed.get(hover)?.lead : null;
  const lit = (a?: Placed, b?: Placed) => !hover || a?.id === hover || b?.id === hover || (hoverLead != null && (a?.lead === hoverLead || b?.lead === hoverLead));

  return (
      <div className="graph-wrap">
        <svg viewBox={`0 0 1040 ${height}`} className="graph" role="img" aria-label="Knowledge graph of signals, companies, people and the product">
          <g className="col-heads">
            <text x={COL.Signal} y={16}>Signal</text>
            <text x={COL.Company} y={16}>Company</text>
            <text x={COL.Person} y={16}>Person</text>
            <text x={COL.Right} y={16}>Product</text>
          </g>
          {graph.edges.map((e, i) => {
            let a = placed.get(e.from);
            let b = placed.get(e.to);
            if (!a || !b) return null;
            // Draw the match from the person when there is one, so the path reads signal, company, person, product.
            if (e.type === 'matched_to') {
              const person = graph.edges.find((x) => x.type === 'works_at' && x.to === e.from);
              const p = person ? placed.get(person.from) : null;
              if (p) a = p;
            }
            if (a.x > b.x || (a.x === b.x && a.y > b.y)) [a, b] = [b, a];
            const x1 = a.x + 78;
            const x2 = b.x - 78;
            const mid = (x1 + x2) / 2;
            const dead = (a.type === 'Signal' && a.state === 'dead') || (b.type === 'Signal' && b.state === 'dead');
            // Nodes stacked in one column are joined down their shared right edge.
            const d =
              a.x === b.x
                ? `M ${a.x + 78} ${a.y} C ${a.x + 110} ${a.y}, ${a.x + 110} ${b.y}, ${a.x + 78} ${b.y}`
                : `M ${x1} ${a.y} C ${mid} ${a.y}, ${mid} ${b.y}, ${x2} ${b.y}`;
            return (
              <path
                key={i}
                d={d}
                className={`edge edge-${e.type} ${dead ? 'dead' : ''} ${lit(a, b) ? '' : 'dim'}`}
              >
                <title>{EDGE_LABEL[e.type]}</title>
              </path>
            );
          })}
          {[...placed.values()].map((n) => (
            <g
              key={n.id}
              className={`node node-${n.type} state-${n.state ?? 'none'} ${lit(n, n) ? '' : 'dim'} ${n.lead ? 'clickable' : ''}`}
              transform={`translate(${n.x}, ${n.y})`}
              onMouseEnter={() => setHover(n.id)}
              onMouseLeave={() => setHover(null)}
              onClick={() => n.lead && openLead(n.lead)}
            >
              <rect x={-78} y={-12} width={156} height={24} rx={4} />
              <text y={4}>{n.label.length > 24 ? `${n.label.slice(0, 23)}…` : n.label}</text>
              <title>{[n.label, n.sub].filter(Boolean).join(' · ')}</title>
            </g>
          ))}
        </svg>
        <ul className="legend">
          <li className="k-positive">live positive signal</li>
          <li className="k-negative">live negative signal</li>
          <li className="k-dead">expired or failed</li>
          <li className="k-active">active lead</li>
          <li className="k-warm">warm intro: previously employed at a customer</li>
        </ul>
      </div>
  );
}
