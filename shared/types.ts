// Types shared by the server and the web client.

export type SignalType =
  | 'job_posting'
  | 'funding'
  | 'exec_hire'
  | 'tech_change'
  | 'layoffs'
  | 'hiring_freeze'
  | 'competitor_signed'
  | 'firmographic'
  | 'contact';

export type Sign = 'positive' | 'negative';
export type ReceiptStatus = 'unverified' | 'verified' | 'failed';
export type EntityType = 'company' | 'person' | 'competitor';

/** A claim with a source, a sign and an expiry date. Everything else is derived from these. */
export interface Receipt {
  id: string;
  entity_type: EntityType;
  entity_id: string;
  field: string;
  claim: string;
  source_url: string;
  snippet: string;
  signal_type: SignalType;
  sign: Sign;
  seen_at: string;
  /** When the thing happened, read from the page. Expiry counts from here, not from when we found it. */
  event_at: string | null;
  expires_at: string | null;
  status: ReceiptStatus;
  verified_by: string | null;
  verified_at: string | null;
  fail_reason: string | null;
  confidence: number;
  data: Record<string, string>;
}

export interface ReceiptView extends Receipt {
  live: boolean;
  expired: boolean;
}

export type LeadState = 'active' | 'not_yet' | 'disqualified';
export type ReasonCode = 'live' | 'negative' | 'no_trigger' | 'expired' | 'failed_verification';
export type Stage = 'Matched' | 'Contacted' | 'Replied' | 'Meeting Booked' | 'Closed' | 'Lost';
export type Tier = 'A' | 'B' | 'C';

export interface Company {
  id: string;
  name: string;
  domain: string;
  site_url: string;
  industry: string | null;
  headcount: number | null;
  region: string | null;
  hq: string | null;
  kind: 'prospect' | 'competitor';
  differentiator: string | null;
}

export type EmailStatus = 'verified' | 'guessed' | 'unresolved';

export interface Person {
  id: string;
  company_id: string;
  name: string;
  title: string;
  email: string | null;
  email_status: EmailStatus;
  previous_companies: string[];
  confidence: number;
}

export interface FitPart {
  points: number;
  max: number;
  matched: boolean;
  value: string | null;
  via: 'icp' | 'expansion' | null;
}

export interface IntentPart {
  receipt_id: string;
  signal_type: SignalType;
  weight: number;
  freshness: number;
  points: number;
}

export interface ScoreInputs {
  fit: { industry: FitPart; headcount: FitPart; region: FitPart };
  fit_score: number;
  intent: IntentPart[];
  intent_score: number;
  score: number;
  tier: Tier;
}

export type EnrichStatus = 'pending' | 'resolved' | 'low_confidence' | 'unresolved' | 'blocked_credits';

export interface Lead {
  id: string;
  company_id: string;
  person_id: string | null;
  state: LeadState;
  stage: Stage;
  fit_score: number;
  intent_score: number;
  score: number;
  tier: Tier;
  reason_code: ReasonCode;
  dormant_reason: string | null;
  reason_receipt_id: string | null;
  icp_version_id: string | null;
  enrich_status: EnrichStatus;
  enrich_note: string | null;
  score_inputs: ScoreInputs | null;
  created_at: string;
  updated_at: string;
}

export interface StageTransition {
  id: string;
  lead_id: string;
  from_stage: Stage | null;
  to_stage: Stage;
  actor_type: 'agent' | 'rep';
  actor: string;
  note: string | null;
  created_at: string;
}

export interface Scored<T> {
  value: T;
  confidence: number;
}

export interface IcpFields {
  industries: Scored<string>[];
  headcount_bands: Scored<string>[];
  regions: Scored<string>[];
  personas: Scored<string>[];
  trigger_events: Scored<SignalType>[];
  excluded_regions: string[];
  /** Product-category words, used to build searches and to recognise competitors. */
  keywords: string[];
}

export interface Expansion {
  id: string;
  name: string;
  reasoning: string;
  industries: string[];
  headcount_bands: string[];
  status: 'proposed' | 'accepted' | 'dismissed';
}

export interface IcpVersion {
  id: string;
  version: number;
  parent_id: string | null;
  fields: IcpFields;
  weights: Record<string, number>;
  windows: Record<string, number>;
  expansions: Expansion[];
  search_plan: string[];
  rationale: string;
  planned_by: 'llm' | 'heuristic' | 'analyst';
  created_at: string;
}

export interface Sentence {
  text: string;
  kind: 'claim' | 'connective';
  receipt_ids: string[];
  status: 'ok' | 'struck';
  strike_reason?: string | null;
  edited?: boolean;
}

export type MessageStatus = 'draft' | 'pending_review' | 'blocked' | 'sent' | 'rejected';
export type MessageVariant = 'A' | 'B';

export interface Message {
  id: string;
  lead_id: string;
  channel: 'email' | 'linkedin';
  variant: MessageVariant;
  subject: string;
  sentences: Sentence[];
  status: MessageStatus;
  reviewer: string | null;
  block_reason: string | null;
  writer: 'llm' | 'template';
  created_at: string;
  updated_at: string;
  sent_at: string | null;
}

export interface LedgerEntry {
  id: number;
  op: string;
  amount: number;
  ref: string | null;
  note: string | null;
  created_at: string;
}

export type AgentName =
  | 'planner'
  | 'researcher'
  | 'enricher'
  | 'writer'
  | 'skeptic'
  | 'analyst'
  | 'human'
  | 'ledger'
  | 'system'
  | 'world';

export interface ActivityEntry {
  id: number;
  at: string;
  agent: AgentName;
  kind: 'start' | 'info' | 'handoff' | 'done' | 'warn' | 'block';
  message: string;
  lead_id: string | null;
  ref: string | null;
  /** The task run this line was written from, when there was one. The feed joins on it to show inputs and outcome. */
  task_id: string | null;
  run_id: string | null;
}

/**
 * queued: waiting for its dependencies or a free worker. running: leased to a worker.
 * blocked: cannot proceed, with the reason named. review: waiting for a person.
 * done / failed: settled. Failed means every attempt was used.
 */
export type TaskStatus = 'queued' | 'running' | 'blocked' | 'review' | 'done' | 'failed';

/** What a task does. Each kind is scoped to one unit: one ICP, one search, one account, one lead, one draft. */
export type TaskKind = 'plan' | 'search' | 'read' | 'recheck' | 'enrich' | 'write' | 'verify' | 'approve' | 'learn' | 'manual';

export type BlockerCode = 'credits' | 'dependency' | 'operator';

/** A durable unit of work leased to one specialist agent. Only the orchestrator creates these. */
export interface TaskRun {
  id: string;
  run_id: string;
  lead_id: string | null;
  agent: AgentName;
  kind: TaskKind;
  title: string;
  detail: string;
  status: TaskStatus;
  depends_on: string[];
  priority: number;
  attempt: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  /** Credits held for this task so parallel work cannot overspend the balance. */
  reserved_credits: number;
  input: Record<string, string>;
  input_receipt_ids: string[];
  output_receipt_ids: string[];
  output_message_ids: string[];
  result: string | null;
  blocker: string | null;
  blocker_code: BlockerCode | null;
  error: string | null;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

/** One pipeline invocation and the tasks it fanned out into. */
export interface PipelineRun {
  id: string;
  kind: 'intake' | 'discovery' | 'ingest' | 'resume' | 'reverify' | 'outcome' | 'manual';
  label: string;
  phase: string | null;
  status: 'active' | 'done';
  created_at: string;
  finished_at: string | null;
}

/** One entry in a draft's append-only history: who changed it, and what the claims looked like after. */
export interface DraftVersion {
  id: number;
  message_id: string;
  version: number;
  author: AgentName;
  note: string;
  claims: number;
  struck: number;
  task_id: string | null;
  created_at: string;
}

/** A short instruction or handoff note. Messages belong to a task, so agent communication stays auditable. */
export interface AgentTaskMessage {
  id: number;
  task_id: string;
  author: string;
  body: string;
  created_at: string;
}

export interface Profile {
  product_name: string;
  description: string;
  customers: string[];
  pricing: string;
  excluded_regions: string[];
  sender: string;
}

export interface LeadView extends Lead {
  company: Company;
  person: Person | null;
  receipts: ReceiptView[];
  transitions: StageTransition[];
  message: Message | null;
  messages: Message[];
  /** Who moved the card into its current stage. Drives the AI / rep badge. */
  stage_actor: 'agent' | 'rep' | null;
  warm_intro: string | null;
}

export interface CompetitorView {
  company: Company;
  receipts: ReceiptView[];
  positioning: string | null;
  pricing: string | null;
}

export interface SegmentRow {
  segment: string;
  matched: number;
  contacted: number;
  replied: number;
}

export interface Metrics {
  claims_drafted: number;
  claims_struck: number;
  catch_rate: number | null;
  /** Sent messages whose factual claims all passed the Skeptic's live re-verification. */
  proof_rate: number | null;
  declined: { not_yet: number; disqualified: number };
  messages_sent: number;
  replies: number;
  reply_rate: number | null;
  meetings: number;
  by_industry: SegmentRow[];
  by_tier: SegmentRow[];
  variants: VariantMetric[];
  usage: { leads_enriched: number; drafts_generated: number; outreach_sent: number; graph_queries: number };
}

export interface VariantMetric {
  variant: MessageVariant;
  channel: Message['channel'];
  drafted: number;
  sent: number;
  replied: number;
  meetings: number;
  reply_rate: number | null;
}

export interface WorldPageView {
  id: string;
  site: string;
  company: string;
  path: string;
  title: string;
  kind: string;
  status: 'live' | 'gone' | 'scheduled';
  url: string;
  published_at: string | null;
}

export interface Snapshot {
  now: string;
  clock_offset_days: number;
  mode: { llm: boolean; model: string; source: 'world' | 'live'; flexprice: boolean; webhook: boolean; band: boolean };
  running: string | null;
  profile: Profile | null;
  icp: IcpVersion | null;
  icp_versions: IcpVersion[];
  credits: {
    balance: number;
    costs: { enrich: number; draft: number; send: number };
    ledger: LedgerEntry[];
    gated: boolean;
  };
  leads: LeadView[];
  competitors: CompetitorView[];
  metrics: Metrics;
  activity: ActivityEntry[];
  tasks: TaskRun[];
  runs: PipelineRun[];
  task_messages: AgentTaskMessage[];
  draft_versions: DraftVersion[];
  team: { concurrency: number; lease_seconds: number };
  world: { pages: WorldPageView[]; pending_batches: number };
}

export interface GraphNode {
  id: string;
  type: 'Company' | 'Person' | 'Product' | 'Competitor' | 'Signal' | 'Customer';
  label: string;
  sub?: string;
  state?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  type:
    | 'works_at'
    | 'previously_employed_at'
    | 'has_signal'
    | 'matched_to'
    | 'competes_with'
    | 'contacted_via'
    | 'replied_to'
    | 'customer_of';
  receipt_id?: string;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface WhyStep {
  question: 'Why now' | 'Why this company' | 'Why this person' | 'Why us' | 'Warm intro';
  node: GraphNode;
  answer: string;
  receipt_ids: string[];
}

export interface ContrastSentence {
  text: string;
  factual: boolean;
  verdict: string;
}

/** A retrieved receipt. Moss ranks the evidence; Receipts remains the source of truth. */
export interface PipelineSearchResult {
  receipt: ReceiptView;
  company: Company;
  lead_id: string | null;
  score: number;
}
