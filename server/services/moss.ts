import { createHash } from 'node:crypto';
import { MossClient, type DocumentInfo } from '@moss-js/moss';
import type { PipelineSearchResult, Receipt, ReceiptView } from '../../shared/types';
import { config, mossEnabled } from '../config';
import { isExpired, isLive } from '../domain/state';
import { now } from '../clock';
import { getCompany, leadForCompany, listLeads, leadReceipts } from './store';

const INDEX_PREFIX = 'receipts-pipeline-';
let client: MossClient | null = null;
let loadedIndex: string | null = null;

interface ReceiptDocument {
  receipt: Receipt;
  companyId: string;
  leadId: string | null;
  document: DocumentInfo;
}

function companyForReceipt(receipt: Receipt): { companyId: string; leadId: string | null } | null {
  for (const lead of listLeads()) {
    if (lead.company_id === receipt.entity_id || lead.person_id === receipt.entity_id) return { companyId: lead.company_id, leadId: lead.id };
  }
  // Competitor receipts have no lead but are still useful for semantic research.
  return getCompany(receipt.entity_id) ? { companyId: receipt.entity_id, leadId: null } : null;
}

/** Convert already-stored receipts to Moss documents. No generated facts are ever indexed. */
export function receiptDocuments(): ReceiptDocument[] {
  const seen = new Map<string, Receipt>();
  for (const lead of listLeads()) for (const receipt of leadReceipts(lead)) seen.set(receipt.id, receipt);
  const documents: ReceiptDocument[] = [];
  for (const receipt of seen.values()) {
    const owner = companyForReceipt(receipt);
    if (!owner) continue;
    const company = getCompany(owner.companyId);
    if (!company) continue;
    documents.push({
      receipt,
      companyId: company.id,
      leadId: owner.leadId,
      document: {
        id: receipt.id,
        text: `${company.name}. ${receipt.claim}\nEvidence: ${receipt.snippet}`,
        metadata: {
          company_id: company.id,
          company: company.name,
          lead_id: owner.leadId ?? '',
          signal_type: receipt.signal_type,
          sign: receipt.sign,
          status: receipt.status,
          field: receipt.field,
          event_at: receipt.event_at ?? '',
        },
      },
    });
  }
  return documents;
}

function indexName(docs: ReceiptDocument[]): string {
  const fingerprint = createHash('sha256')
    .update(docs.map((item) => `${item.receipt.id}:${item.receipt.status}:${item.receipt.snippet}`).sort().join('\n'))
    .digest('hex')
    .slice(0, 16);
  return `${INDEX_PREFIX}${fingerprint}`;
}

function mossClient(): MossClient {
  if (!mossEnabled()) throw new Error('Moss is not configured. Set MOSS_PROJECT_ID and MOSS_PROJECT_KEY.');
  return (client ??= new MossClient(config.moss.projectId, config.moss.projectKey, { identity: { deviceId: 'receipts-backend' }, keepModels: true }));
}

async function ensureIndex(docs: ReceiptDocument[]): Promise<string> {
  const name = indexName(docs);
  if (loadedIndex === name) return name;
  const moss = mossClient();
  try {
    await moss.loadIndex(name);
  } catch {
    try {
      await moss.createIndex(name, docs.map((item) => item.document));
    } catch {
      // Another process may have completed the same content-addressed index first.
    }
    await moss.loadIndex(name);
  }
  loadedIndex = name;
  return name;
}

/** Semantic/hybrid evidence retrieval. Results are joined back to local receipts before returning. */
export async function searchPipeline(query: string, limit = 8): Promise<PipelineSearchResult[]> {
  if (!mossEnabled()) throw new Error('Moss is not configured.');
  const docs = receiptDocuments();
  if (docs.length === 0) return [];
  const name = await ensureIndex(docs);
  const matches = await mossClient().query(name, query, { topK: Math.min(20, Math.max(1, limit)), alpha: 0.65 });
  const byId = new Map(docs.map((item) => [item.receipt.id, item]));
  const at = now();
  return matches.docs.flatMap((match) => {
    const item = byId.get(match.id);
    if (!item) return [];
    const company = getCompany(item.companyId);
    if (!company) return [];
    const receipt: ReceiptView = { ...item.receipt, live: isLive(item.receipt, at), expired: isExpired(item.receipt, at) };
    return [{ receipt, company, lead_id: item.leadId, score: match.score }];
  });
}
