import type {
  Company,
  EntityType,
  IcpVersion,
  Lead,
  Message,
  Person,
  Profile,
  Receipt,
  Sentence,
  Sign,
  SignalType,
  Stage,
  StageTransition,
} from '../../shared/types';
import { SIGNALS } from '../../shared/constants';
import { all, get, getSetting, newId, parse, run, setSetting } from '../db';
import { daysFrom, now, nowIso } from '../clock';
import { normalize } from '../domain/text';

// ---------- profile ----------

export function getProfile(): Profile | null {
  return getSetting<Profile | null>('profile', null);
}

export function saveProfile(profile: Profile): void {
  setSetting('profile', profile);
}

// ---------- receipts ----------

type ReceiptRow = Omit<Receipt, 'data'> & { data: string };
const toReceipt = (row: ReceiptRow): Receipt => ({ ...row, data: parse<Record<string, string>>(row.data, {}) });

export function getReceipt(id: string): Receipt | null {
  const row = get<ReceiptRow>('SELECT * FROM receipts WHERE id = ?', id);
  return row ? toReceipt(row) : null;
}

export function receiptsFor(entityIds: (string | null | undefined)[]): Receipt[] {
  const ids = entityIds.filter((x): x is string => Boolean(x));
  if (ids.length === 0) return [];
  const marks = ids.map(() => '?').join(',');
  return all<ReceiptRow>(`SELECT * FROM receipts WHERE entity_id IN (${marks}) ORDER BY seen_at, id`, ...ids).map(toReceipt);
}

export function allReceipts(): Receipt[] {
  return all<ReceiptRow>('SELECT * FROM receipts ORDER BY seen_at, id').map(toReceipt);
}

export interface NewReceipt {
  entity_type: EntityType;
  entity_id: string;
  field: string;
  claim: string;
  source_url: string;
  snippet: string;
  signal_type: SignalType;
  sign: Sign;
  event_at?: string | null;
  confidence: number;
  data?: Record<string, string>;
}

/**
 * Write a receipt. The same fact from the same page is stored once, so re-ingesting is safe.
 * Expiry counts from when the event happened, using the window for its signal type.
 */
export function addReceipt(input: NewReceipt): { receipt: Receipt; created: boolean } {
  const existing = receiptsFor([input.entity_id]).find(
    (r) =>
      r.field === input.field &&
      r.signal_type === input.signal_type &&
      r.source_url === input.source_url &&
      normalize(r.snippet) === normalize(input.snippet),
  );
  if (existing) return { receipt: existing, created: false };

  const seen = now();
  const icp = currentIcp();
  const window = icp?.windows[input.signal_type] ?? SIGNALS[input.signal_type].window;
  const start = input.event_at ? new Date(input.event_at) : seen;
  const receipt: Receipt = {
    id: newId('r'),
    entity_type: input.entity_type,
    entity_id: input.entity_id,
    field: input.field,
    claim: input.claim,
    source_url: input.source_url,
    snippet: input.snippet,
    signal_type: input.signal_type,
    sign: input.sign,
    seen_at: seen.toISOString(),
    event_at: input.event_at ?? null,
    expires_at: window == null ? null : daysFrom(start, window).toISOString(),
    status: 'unverified',
    verified_by: null,
    verified_at: null,
    fail_reason: null,
    confidence: input.confidence,
    data: input.data ?? {},
  };
  run(
    `INSERT INTO receipts (id, entity_type, entity_id, field, claim, source_url, snippet, signal_type, sign,
       seen_at, event_at, expires_at, status, confidence, data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    receipt.id,
    receipt.entity_type,
    receipt.entity_id,
    receipt.field,
    receipt.claim,
    receipt.source_url,
    receipt.snippet,
    receipt.signal_type,
    receipt.sign,
    receipt.seen_at,
    receipt.event_at,
    receipt.expires_at,
    receipt.status,
    receipt.confidence,
    receipt.data,
  );
  return { receipt, created: true };
}

export function markReceipt(id: string, status: 'verified' | 'failed', failReason: string | null): void {
  run(
    'UPDATE receipts SET status = ?, verified_by = ?, verified_at = ?, fail_reason = ? WHERE id = ?',
    status,
    'skeptic',
    nowIso(),
    failReason,
    id,
  );
}

// ---------- companies and people ----------

export function getCompany(id: string): Company | null {
  return get<Company>('SELECT * FROM companies WHERE id = ?', id) ?? null;
}

export function findCompany(siteUrl: string, domain: string): Company | null {
  return get<Company>('SELECT * FROM companies WHERE site_url = ? OR domain = ?', siteUrl, domain) ?? null;
}

export function listCompanies(kind: Company['kind']): Company[] {
  return all<Company>('SELECT * FROM companies WHERE kind = ? ORDER BY name', kind);
}

export function createCompany(input: Pick<Company, 'name' | 'domain' | 'site_url' | 'kind'>): Company {
  const id = newId(input.kind === 'competitor' ? 'k' : 'c');
  run(
    'INSERT INTO companies (id, name, domain, site_url, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    id,
    input.name,
    input.domain,
    input.site_url,
    input.kind,
    nowIso(),
  );
  return getCompany(id)!;
}

export function updateCompany(id: string, patch: Partial<Company>): void {
  const keys = Object.keys(patch).filter((k) => k !== 'id');
  if (keys.length === 0) return;
  run(`UPDATE companies SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => (patch as Record<string, unknown>)[k]), id);
}

type PersonRow = Omit<Person, 'previous_companies'> & { previous_companies: string };
const toPerson = (row: PersonRow): Person => ({ ...row, previous_companies: parse<string[]>(row.previous_companies, []) });

export function getPerson(id: string | null): Person | null {
  if (!id) return null;
  const row = get<PersonRow>('SELECT * FROM persons WHERE id = ?', id);
  return row ? toPerson(row) : null;
}

export function createPerson(input: Omit<Person, 'id'>): Person {
  const id = newId('p');
  run(
    `INSERT INTO persons (id, company_id, name, title, email, email_status, previous_companies, confidence, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.company_id,
    input.name,
    input.title,
    input.email,
    input.email_status,
    input.previous_companies,
    input.confidence,
    nowIso(),
  );
  return getPerson(id)!;
}

// ---------- leads ----------

type LeadRow = Omit<Lead, 'score_inputs'> & { score_inputs: string | null };
const toLead = (row: LeadRow): Lead => ({ ...row, score_inputs: parse(row.score_inputs, null) });

export function getLead(id: string): Lead | null {
  const row = get<LeadRow>('SELECT * FROM leads WHERE id = ?', id);
  return row ? toLead(row) : null;
}

export function listLeads(): Lead[] {
  return all<LeadRow>('SELECT * FROM leads ORDER BY score DESC, created_at').map(toLead);
}

export function leadForCompany(companyId: string): Lead | null {
  const row = get<LeadRow>('SELECT * FROM leads WHERE company_id = ?', companyId);
  return row ? toLead(row) : null;
}

export function createLead(companyId: string): Lead {
  const id = newId('l');
  const at = nowIso();
  run(
    `INSERT INTO leads (id, company_id, state, stage, icp_version_id, created_at, updated_at)
     VALUES (?, ?, 'not_yet', 'Matched', ?, ?, ?)`,
    id,
    companyId,
    currentIcp()?.id ?? null,
    at,
    at,
  );
  return getLead(id)!;
}

export function updateLead(id: string, patch: Partial<Lead>): void {
  const keys = Object.keys(patch).filter((k) => k !== 'id');
  if (keys.length === 0) return;
  run(
    `UPDATE leads SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
    ...keys.map((k) => (patch as Record<string, unknown>)[k]),
    nowIso(),
    id,
  );
}

/** Every receipt behind a lead: the company's facts and signals, plus the contact's. */
export function leadReceipts(lead: Pick<Lead, 'company_id' | 'person_id'>): Receipt[] {
  return receiptsFor([lead.company_id, lead.person_id]);
}

// ---------- stage transitions ----------

export function addTransition(
  leadId: string,
  from: Stage | null,
  to: Stage,
  actorType: 'agent' | 'rep',
  actor: string,
  note: string | null,
): void {
  run(
    `INSERT INTO stage_transitions (id, lead_id, from_stage, to_stage, actor_type, actor, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    newId('t'),
    leadId,
    from,
    to,
    actorType,
    actor,
    note,
    nowIso(),
  );
}

export function listTransitions(): StageTransition[] {
  return all<StageTransition>('SELECT * FROM stage_transitions ORDER BY created_at, rowid');
}

// ---------- ICP versions ----------

interface IcpRow {
  id: string;
  version: number;
  parent_id: string | null;
  fields: string;
  weights: string;
  windows: string;
  expansions: string;
  search_plan: string;
  rationale: string;
  planned_by: IcpVersion['planned_by'];
  created_at: string;
}

const toIcp = (row: IcpRow): IcpVersion => ({
  ...row,
  fields: JSON.parse(row.fields),
  weights: JSON.parse(row.weights),
  windows: JSON.parse(row.windows),
  expansions: JSON.parse(row.expansions),
  search_plan: JSON.parse(row.search_plan),
});

export function listIcpVersions(): IcpVersion[] {
  return all<IcpRow>('SELECT * FROM icp_versions ORDER BY version').map(toIcp);
}

export function currentIcp(): IcpVersion | null {
  const id = getSetting<string | null>('current_icp', null);
  if (!id) return null;
  const row = get<IcpRow>('SELECT * FROM icp_versions WHERE id = ?', id);
  return row ? toIcp(row) : null;
}

export function setCurrentIcp(id: string): void {
  setSetting('current_icp', id);
}

export function saveIcpVersion(input: Omit<IcpVersion, 'id' | 'version' | 'created_at'>): IcpVersion {
  const id = newId('icp');
  const version = (get<{ v: number | null }>('SELECT MAX(version) AS v FROM icp_versions')?.v ?? 0) + 1;
  run(
    `INSERT INTO icp_versions (id, version, parent_id, fields, weights, windows, expansions, search_plan, rationale, planned_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    version,
    input.parent_id,
    input.fields,
    input.weights,
    input.windows,
    input.expansions,
    input.search_plan,
    input.rationale,
    input.planned_by,
    nowIso(),
  );
  setCurrentIcp(id);
  return currentIcp()!;
}

export function updateIcpExpansions(id: string, expansions: IcpVersion['expansions']): void {
  run('UPDATE icp_versions SET expansions = ? WHERE id = ?', expansions, id);
}

// ---------- messages ----------

type MessageRow = Omit<Message, 'sentences'> & { sentences: string };
const toMessage = (row: MessageRow): Message => ({ ...row, sentences: parse<Sentence[]>(row.sentences, []) });

export function getMessage(id: string): Message | null {
  const row = get<MessageRow>('SELECT * FROM messages WHERE id = ?', id);
  return row ? toMessage(row) : null;
}

export function listMessages(): Message[] {
  return all<MessageRow>('SELECT * FROM messages ORDER BY created_at, rowid').map(toMessage);
}

export function latestMessage(leadId: string): Message | null {
  const row = get<MessageRow>('SELECT * FROM messages WHERE lead_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', leadId);
  return row ? toMessage(row) : null;
}

export function createMessage(input: Pick<Message, 'lead_id' | 'subject' | 'sentences' | 'writer'>): Message {
  const id = newId('m');
  const at = nowIso();
  run(
    `INSERT INTO messages (id, lead_id, channel, subject, sentences, status, writer, created_at, updated_at)
     VALUES (?, ?, 'email', ?, ?, 'draft', ?, ?, ?)`,
    id,
    input.lead_id,
    input.subject,
    input.sentences,
    input.writer,
    at,
    at,
  );
  return getMessage(id)!;
}

export function updateMessage(id: string, patch: Partial<Message>): void {
  const keys = Object.keys(patch).filter((k) => k !== 'id');
  if (keys.length === 0) return;
  run(
    `UPDATE messages SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
    ...keys.map((k) => (patch as Record<string, unknown>)[k]),
    nowIso(),
    id,
  );
}
