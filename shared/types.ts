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
}

/** A durable unit of work handed to one specialist agent. Dependencies prevent a task from starting early. */
export type AgentTaskStatus = 'todo' | 'doing' | 'blocked' | 'review' | 'done';

export interface AgentTask {
  id: string;
  title: string;
  detail: string;
  agent: AgentName;
  status: AgentTaskStatus;
  depends_on: string[];
  lead_id: string | null;
  created_at: string;
  updated_at: string;
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
  tasks: AgentTask[];
  task_messages: AgentTaskMessage[];
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
