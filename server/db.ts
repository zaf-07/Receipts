import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

// One operational store. The knowledge graph is a projection of it, not a second database.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  field TEXT NOT NULL,
  claim TEXT NOT NULL,
  source_url TEXT NOT NULL,
  snippet TEXT NOT NULL,
  signal_type TEXT NOT NULL,
  sign TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  event_at TEXT,
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'unverified',
  verified_by TEXT,
  verified_at TEXT,
  fail_reason TEXT,
  confidence REAL NOT NULL DEFAULT 0.5,
  data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS receipts_entity ON receipts (entity_id);

CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT NOT NULL,
  site_url TEXT NOT NULL,
  industry TEXT,
  headcount INTEGER,
  region TEXT,
  hq TEXT,
  kind TEXT NOT NULL DEFAULT 'prospect',
  differentiator TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS persons (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  email TEXT,
  email_status TEXT NOT NULL,
  previous_companies TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL UNIQUE,
  person_id TEXT,
  state TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'Matched',
  fit_score REAL NOT NULL DEFAULT 0,
  intent_score REAL NOT NULL DEFAULT 0,
  score REAL NOT NULL DEFAULT 0,
  tier TEXT NOT NULL DEFAULT 'C',
  reason_code TEXT NOT NULL DEFAULT 'no_trigger',
  dormant_reason TEXT,
  reason_receipt_id TEXT,
  icp_version_id TEXT,
  enrich_status TEXT NOT NULL DEFAULT 'pending',
  enrich_note TEXT,
  score_inputs TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stage_transitions (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  from_stage TEXT,
  to_stage TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS icp_versions (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  parent_id TEXT,
  fields TEXT NOT NULL,
  weights TEXT NOT NULL,
  windows TEXT NOT NULL,
  expansions TEXT NOT NULL,
  search_plan TEXT NOT NULL,
  rationale TEXT NOT NULL,
  planned_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'email',
  variant TEXT NOT NULL DEFAULT 'A',
  subject TEXT NOT NULL,
  sentences TEXT NOT NULL,
  status TEXT NOT NULL,
  reviewer TEXT,
  block_reason TEXT,
  writer TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT
);

CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  op TEXT NOT NULL,
  amount REAL NOT NULL,
  ref TEXT,
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  agent TEXT NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  lead_id TEXT,
  ref TEXT,
  task_id TEXT,
  run_id TEXT
);

-- One pipeline invocation: an intake, a discovery, a signal refresh. Groups its task runs.
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  phase TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  finished_at TEXT
);

-- The durable unit of agent work. One row per scoped task: one search, one account, one lead, one draft.
-- A task is leased to a worker, not owned by it: a lease that expires is taken back and retried.
CREATE TABLE IF NOT EXISTS task_runs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  lead_id TEXT,
  agent TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued',
  depends_on TEXT NOT NULL DEFAULT '[]',
  priority REAL NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  lease_owner TEXT,
  lease_expires_at TEXT,
  reserved_credits REAL NOT NULL DEFAULT 0,
  input TEXT NOT NULL DEFAULT '{}',
  input_receipt_ids TEXT NOT NULL DEFAULT '[]',
  output_receipt_ids TEXT NOT NULL DEFAULT '[]',
  output_message_ids TEXT NOT NULL DEFAULT '[]',
  result TEXT,
  blocker TEXT,
  blocker_code TEXT,
  error TEXT,
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS task_runs_status ON task_runs (status);
CREATE INDEX IF NOT EXISTS task_runs_run ON task_runs (run_id);

-- Append-only. The Skeptic never edits a receipt: it adds a verdict, and the receipt's status is derived from the latest one.
CREATE TABLE IF NOT EXISTS verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id TEXT NOT NULL,
  task_id TEXT,
  ok INTEGER NOT NULL,
  reason TEXT,
  checked_by TEXT NOT NULL,
  checked_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS verifications_receipt ON verifications (receipt_id);

-- Append-only. Every change to a draft is a new version with its author, so nobody's work is overwritten.
CREATE TABLE IF NOT EXISTS message_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  author TEXT NOT NULL,
  note TEXT NOT NULL,
  subject TEXT NOT NULL,
  sentences TEXT NOT NULL,
  task_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS message_versions_message ON message_versions (message_id);

CREATE TABLE IF NOT EXISTS agent_task_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS world_pages (
  id TEXT PRIMARY KEY,
  site TEXT NOT NULL,
  company TEXT NOT NULL,
  domain TEXT NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  published_at TEXT,
  days_ago INTEGER,
  status TEXT NOT NULL,
  batch INTEGER NOT NULL DEFAULT 0,
  after_crawl TEXT
);
`;

const TABLES = [
  'settings',
  'receipts',
  'companies',
  'persons',
  'leads',
  'stage_transitions',
  'icp_versions',
  'messages',
  'ledger',
  'activity',
  'runs',
  'task_runs',
  'verifications',
  'message_versions',
  'agent_task_messages',
  'world_pages',
];

type Param = string | number | bigint | null | Uint8Array;
let db: DatabaseSync;

export function initDb(path: string): void {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  const messageColumns = db.prepare('PRAGMA table_info(messages)').all() as { name: string }[];
  if (!messageColumns.some((column) => column.name === 'variant')) db.exec("ALTER TABLE messages ADD COLUMN variant TEXT NOT NULL DEFAULT 'A'");
  // Databases created before task runs existed: link each activity line to the task that produced it.
  const activityColumns = db.prepare('PRAGMA table_info(activity)').all() as { name: string }[];
  for (const column of ['task_id', 'run_id']) {
    if (!activityColumns.some((c) => c.name === column)) db.exec(`ALTER TABLE activity ADD COLUMN ${column} TEXT`);
  }
}

function clean(params: unknown[]): Param[] {
  return params.map((p) => {
    if (p === undefined || p === null) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (typeof p === 'object' && !(p instanceof Uint8Array)) return JSON.stringify(p);
    return p as Param;
  });
}

export function all<T>(sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...clean(params)) as T[];
}

export function get<T>(sql: string, ...params: unknown[]): T | undefined {
  return db.prepare(sql).get(...clean(params)) as T | undefined;
}

export function run(sql: string, ...params: unknown[]): void {
  db.prepare(sql).run(...clean(params));
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(3).toString('hex')}`;
}

const settingsCache = new Map<string, unknown>();

export function getSetting<T>(key: string, fallback: T): T {
  if (settingsCache.has(key)) return settingsCache.get(key) as T;
  const row = get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key);
  const value = row ? (JSON.parse(row.value) as T) : fallback;
  settingsCache.set(key, value);
  return value;
}

export function setSetting(key: string, value: unknown): void {
  settingsCache.set(key, value);
  run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    JSON.stringify(value),
  );
}

/** Empties every table. Used by the demo reset. */
export function wipe(): void {
  for (const table of TABLES) db.exec(`DELETE FROM ${table};`);
  db.exec("DELETE FROM sqlite_sequence WHERE name IN ('ledger', 'activity', 'verifications', 'message_versions', 'agent_task_messages');");
  settingsCache.clear();
}

export function parse<T>(text: string | null | undefined, fallback: T): T {
  if (text == null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
