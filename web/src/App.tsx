import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ActivityEntry } from '../../shared/types';
import { UiContext, call, useSnapshot, useUi, type Ui } from './api';
import { Chip, fmtDate, fmtTime } from './components';
import { Intake } from './views/Intake';
import { Accounts } from './views/Accounts';
import { Review } from './views/Review';
import { NotYet } from './views/NotYet';
import { Pipeline } from './views/Pipeline';
import { Dashboard } from './views/Dashboard';
import { GraphView } from './views/GraphView';
import { Competitors } from './views/Competitors';
import { LeadDrawer } from './views/LeadDrawer';
import { DemoPanel } from './views/DemoPanel';
import { Tour } from './views/Tour';
import { KIND_LABEL, Team, receiptIndex } from './views/Team';

const VIEWS = ['intake', 'accounts', 'review', 'not-yet', 'pipeline', 'team', 'dashboard', 'graph', 'competitors'] as const;
type View = (typeof VIEWS)[number];

const LABEL: Record<View, string> = {
  intake: 'Intake & ICP',
  accounts: 'Accounts',
  review: 'Review queue',
  'not-yet': 'Not yet',
  pipeline: 'Pipeline',
  team: 'Agent team',
  dashboard: 'Dashboard',
  graph: 'Graph',
  competitors: 'Competitors',
};

const AGENT_LABEL: Record<string, string> = {
  planner: 'Planner',
  researcher: 'Researcher',
  enricher: 'Enricher',
  writer: 'Writer',
  skeptic: 'Skeptic',
  security: 'Security',
  analyst: 'Analyst',
  human: 'Human',
  ledger: 'Ledger',
  system: 'System',
  world: 'World',
};

function initialView(): View {
  const hash = window.location.hash.replace('#', '') as View;
  return VIEWS.includes(hash) ? hash : 'intake';
}

/**
 * The event stream. Each line is an event; when it came from a task, the task's record is joined
 * in at render time to show its state, the receipts it was given or produced, and any blocker.
 */
function Feed({ entries, onLead }: { entries: ActivityEntry[]; onLead: (id: string) => void }) {
  const { snap, openTask } = useUi();
  const tasks = useMemo(() => new Map(snap.tasks.map((t) => [t.id, t])), [snap.tasks]);
  const receipts = useMemo(() => receiptIndex(snap), [snap]);
  if (entries.length === 0) return <p className="feed-empty">Nothing yet. Agent handoffs will appear here as they happen.</p>;
  return (
    <ol className="feed">
      {entries.map((e) => {
        const task = e.task_id ? tasks.get(e.task_id) : undefined;
        // A handoff shows what was produced; a block or warning shows what was being worked on.
        const ids = task && e.kind !== 'info' && e.kind !== 'start' ? (task.output_receipt_ids.length ? task.output_receipt_ids : task.input_receipt_ids) : [];
        const linked = ids.map((id) => receipts.get(id)).filter((r) => r !== undefined);
        return (
          <li key={e.id} className={`feed-item kind-${e.kind}`}>
            <div className="feed-top">
              <span className={`agent agent-${e.agent}`}>{AGENT_LABEL[e.agent] ?? e.agent}</span>
              <time>{fmtTime(e.at)}</time>
            </div>
            <p>
              {e.message}
              {e.lead_id && (
                <button type="button" className="link" onClick={() => onLead(e.lead_id!)}>
                  open
                </button>
              )}
            </p>
            {task && (
              <div className="feed-task">
                <button type="button" className={`task-pill status-${task.status}`} onClick={() => openTask(task.id)} title={task.title}>
                  {KIND_LABEL[task.kind]} · {task.status}
                  {task.attempt > 1 ? ` · attempt ${task.attempt}` : ''}
                </button>
                {linked.slice(0, 3).map((r) => (
                  <Chip key={r.id} r={r} now={snap.now} />
                ))}
                {linked.length > 3 && <span className="muted">+{linked.length - 3}</span>}
                {task.status === 'blocked' && task.blocker && <em>{task.blocker}</em>}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function App() {
  const { snap, offline, refresh } = useSnapshot();
  const [view, setView] = useState<View>(initialView);
  const [leadId, setLeadId] = useState<string | null>(null);
  // On a narrow window the feed overlays the page, so it starts closed there.
  const [feedOpen, setFeedOpen] = useState(() => window.innerWidth >= 1180);
  const [demoOpen, setDemoOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [tour, setTour] = useState(() => new URLSearchParams(window.location.search).has('tour'));
  // The tour reads the newest snapshot while it runs, without restarting on every refresh.
  const snapRef = useRef(snap);
  snapRef.current = snap;

  const go = useCallback((v: string) => {
    if (!VIEWS.includes(v as View)) return;
    setView(v as View);
    window.location.hash = v;
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 7000);
    return () => window.clearTimeout(t);
  }, [notice]);

  const act = useCallback(async (path: string, body: unknown = {}) => {
    try {
      await call(path, body);
      return true;
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'That did not work.');
      return false;
    }
  }, []);

  const ui = useMemo<Ui | null>(
    () =>
      snap
        ? {
            snap,
            refresh,
            act,
            openLead: setLeadId,
            openTask: (id: string) => {
              setTaskId(id);
              go('team');
            },
            taskId,
            go,
            reviewer: snap.profile?.sender || 'Reviewer',
            startTour: () => {
              setDemoOpen(false);
              setTour(true);
            },
          }
        : null,
    [snap, act, go, taskId],
  );

  if (!snap || !ui) {
    return (
      <div className="boot">
        <h1>Receipts</h1>
        <p>{offline ? 'Cannot reach the server. Start it with npm start, then reload.' : 'Loading.'}</p>
      </div>
    );
  }

  const counts: Partial<Record<View, number>> = {
    accounts: snap.leads.length,
    review: snap.leads.filter((l) => l.message?.status === 'pending_review').length,
    'not-yet': snap.leads.filter((l) => l.state !== 'active').length,
    team: snap.tasks.filter((t) => t.status === 'running' || t.status === 'blocked' || t.status === 'failed').length,
    competitors: snap.competitors.length,
  };
  const lead = leadId ? snap.leads.find((l) => l.id === leadId) : null;

  return (
    <UiContext.Provider value={ui}>
      <div className={`app ${feedOpen ? 'with-feed' : ''}`}>
        <header className="top">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true" />
            <div>
              <strong>Receipts</strong>
              <span>No receipt, no action.</span>
            </div>
          </div>
          <div className="top-status">
            {snap.running ? (
              <span className="running">
                <i /> {snap.running}
              </span>
            ) : (
              <span className="idle">Idle</span>
            )}
            <span className="mode" title={snap.mode.llm ? `Agents use ${snap.mode.model}, with deterministic fallbacks` : 'No model credentials found. Agents run on deterministic rules.'}>
              {snap.mode.source === 'world' ? 'Seeded world' : 'Live web'} · {snap.mode.llm ? 'model agents' : 'rule agents'}
            </span>
            <span className="clock" title="The app clock. Move it from the demo controls to watch receipts expire.">
              {fmtDate(snap.now)}
              {snap.clock_offset_days > 0 && <em> +{snap.clock_offset_days}d</em>}
            </span>
          </div>
          <div className="top-actions">
            <div className={`credits ${snap.credits.gated ? 'gated' : ''}`}>
              <span className="credits-n">{snap.credits.balance}</span>
              <span className="credits-l">{snap.credits.balance === 1 ? 'credit' : 'credits'}</span>
              {snap.credits.wallet.mode === 'source' && snap.credits.wallet.connected && (
                <span className="tag" title="The balance is read from the Flexprice wallet">
                  Flexprice
                </span>
              )}
              {snap.credits.gated && <span className="gate-note">Gate closed. Work is on hold.</span>}
              <button type="button" className="btn small" onClick={() => void act('/credits/topup', { amount: 50 })}>
                Top up 50
              </button>
            </div>
            <button type="button" className={`btn small ${demoOpen ? 'on' : ''}`} onClick={() => setDemoOpen((v) => !v)}>
              Demo controls
            </button>
            <button type="button" className={`btn small ${feedOpen ? 'on' : ''}`} onClick={() => setFeedOpen((v) => !v)}>
              Activity
            </button>
          </div>
        </header>

        <nav className="nav" aria-label="Sections">
          {VIEWS.map((v) => (
            <button key={v} type="button" className={v === view ? 'active' : ''} onClick={() => go(v)}>
              <span>{LABEL[v]}</span>
              {counts[v] != null && counts[v]! > 0 && <b className={v === 'review' ? 'hot' : ''}>{counts[v]}</b>}
            </button>
          ))}
          <p className="nav-foot">
            Catch rate
            <strong>{snap.metrics.catch_rate == null ? 'n/a' : `${Math.round(snap.metrics.catch_rate * 100)}%`}</strong>
            <span>
              {snap.metrics.claims_struck} of {snap.metrics.claims_drafted} drafted claims struck before a human saw them
            </span>
          </p>
        </nav>

        <main className="main">
          {notice && (
            <div className="notice" role="alert">
              {notice}
              <button type="button" className="link" onClick={() => setNotice(null)}>
                dismiss
              </button>
            </div>
          )}
          {offline && <div className="notice">Lost the connection to the server. Retrying.</div>}
          <div
            className={`demo-panel-shell ${demoOpen ? 'open' : ''}`}
            aria-hidden={!demoOpen}
            inert={!demoOpen}
          >
            <DemoPanel onClose={() => setDemoOpen(false)} />
          </div>
          {view === 'intake' && <Intake />}
          {view === 'accounts' && <Accounts />}
          {view === 'review' && <Review />}
          {view === 'not-yet' && <NotYet />}
          {view === 'pipeline' && <Pipeline />}
          {view === 'team' && <Team />}
          {view === 'dashboard' && <Dashboard />}
          {view === 'graph' && <GraphView />}
          {view === 'competitors' && <Competitors />}
        </main>

        <aside className="feed-rail" aria-label="Agent activity" aria-hidden={!feedOpen} inert={!feedOpen}>
            <header>
              <h3>Tasks and handoffs</h3>
              <button type="button" className="link" onClick={() => setFeedOpen(false)}>
                hide
              </button>
            </header>
            <Feed entries={snap.activity} onLead={setLeadId} />
        </aside>

        {lead && <LeadDrawer lead={lead} onClose={() => setLeadId(null)} />}
        {tour && (
          <Tour
            onDone={() => setTour(false)}
            controls={{ go, act, openLead: setLeadId, setFeed: setFeedOpen, snap: () => snapRef.current! }}
          />
        )}
      </div>
    </UiContext.Provider>
  );
}
