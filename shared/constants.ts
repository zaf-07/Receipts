import type { SignalType, Sign, Stage } from './types';

export interface SignalSpec {
  label: string;
  sign: Sign;
  /** Days a receipt of this type keeps counting. null = does not expire. */
  window: number | null;
  /** Intent points a fresh receipt of this type contributes. */
  weight: number;
  /** A trigger is a why-now. Firmographics and contacts are facts, not triggers. */
  trigger: boolean;
}

/**
 * Windows and weights are starting defaults, not measured values.
 * The Analyst reweights signal types from reply data.
 */
export const SIGNALS: Record<SignalType, SignalSpec> = {
  job_posting: { label: 'Job posting', sign: 'positive', window: 60, weight: 40, trigger: true },
  exec_hire: { label: 'Exec hire', sign: 'positive', window: 90, weight: 30, trigger: true },
  tech_change: { label: 'Tech or pricing change', sign: 'positive', window: 90, weight: 45, trigger: true },
  funding: { label: 'Funding', sign: 'positive', window: 120, weight: 30, trigger: true },
  hiring_freeze: { label: 'Hiring freeze', sign: 'negative', window: 120, weight: 0, trigger: true },
  layoffs: { label: 'Layoffs', sign: 'negative', window: 180, weight: 0, trigger: true },
  competitor_signed: { label: 'Signed with a competitor', sign: 'negative', window: 365, weight: 0, trigger: true },
  firmographic: { label: 'Firmographic', sign: 'positive', window: null, weight: 0, trigger: false },
  contact: { label: 'Contact', sign: 'positive', window: null, weight: 0, trigger: false },
};

export const POSITIVE_TRIGGERS: SignalType[] = ['job_posting', 'exec_hire', 'tech_change', 'funding'];
export const NEGATIVE_TRIGGERS: SignalType[] = ['hiring_freeze', 'layoffs', 'competitor_signed'];

export const STAGES: Stage[] = ['Matched', 'Contacted', 'Replied', 'Meeting Booked', 'Closed', 'Lost'];

/** Industry labels are a closed set so ICP fields and company records join exactly. */
export const INDUSTRY_TAXONOMY: Record<string, string[]> = {
  'AI / ML': ['ai', 'machine learning', 'language model', 'llm', 'inference', 'vector database', 'model'],
  'Developer Tools': ['developer tools', 'developer', 'api', 'sdk', 'observability', 'devops', 'infrastructure'],
  SaaS: ['saas', 'subscription', 'workflow', 'b2b software'],
  Fintech: ['fintech', 'payments', 'banking', 'lending', 'lender', 'ledger', 'reconciliation'],
  'E-commerce': ['e-commerce', 'ecommerce', 'retail', 'storefront', 'checkout', 'marketplace'],
  Healthcare: ['health', 'healthcare', 'hospital', 'patient', 'clinical', 'medical'],
  Cybersecurity: ['security', 'cybersecurity', 'threat', 'compliance', 'identity'],
  Logistics: ['logistics', 'shipping', 'freight', 'supply chain', 'fleet'],
  Media: ['media', 'streaming', 'podcast', 'video', 'publisher'],
  Education: ['education', 'edtech', 'students', 'courses'],
};
export const INDUSTRIES = Object.keys(INDUSTRY_TAXONOMY);

export const HEADCOUNT_BANDS = ['1-10', '11-50', '51-200', '201-500', '501-1000', '1001-5000', '5000+'];

export function bandFor(headcount: number | null | undefined): string | null {
  if (headcount == null || !Number.isFinite(headcount)) return null;
  if (headcount <= 10) return '1-10';
  if (headcount <= 50) return '11-50';
  if (headcount <= 200) return '51-200';
  if (headcount <= 500) return '201-500';
  if (headcount <= 1000) return '501-1000';
  if (headcount <= 5000) return '1001-5000';
  return '5000+';
}

export const REGIONS = ['North America', 'Europe', 'APAC', 'LATAM', 'Middle East & Africa'];

/** Scoring constants from the idea doc. Design choices to tune, not measured numbers. */
export const FIT_POINTS = { industry: 45, headcount: 35, region: 20 };
export const TIER_A = 65;
export const TIER_B = 45;
export const FRESHNESS_FLOOR = 0.15;
export const LEARNING_STEP = 0.25;
