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

/**
 * The closest NAICS 2022 class for each industry label, so an ICP lines up with the codes that
 * company databases and filings use. It classifies the label, not any one company.
 */
export const INDUSTRY_NAICS: Record<string, { code: string; title: string }> = {
  'AI / ML': { code: '518210', title: 'Computing Infrastructure Providers, Data Processing, Web Hosting, and Related Services' },
  'Developer Tools': { code: '513210', title: 'Software Publishers' },
  SaaS: { code: '513210', title: 'Software Publishers' },
  Fintech: { code: '522320', title: 'Financial Transactions Processing, Reserve, and Clearinghouse Activities' },
  'E-commerce': { code: '44-45', title: 'Retail Trade' },
  Healthcare: { code: '62', title: 'Health Care and Social Assistance' },
  Cybersecurity: { code: '541512', title: 'Computer Systems Design Services' },
  Logistics: { code: '48-49', title: 'Transportation and Warehousing' },
  Media: { code: '516210', title: 'Media Streaming Distribution Services, Social Networks, and Other Media Networks and Content Providers' },
  Education: { code: '61', title: 'Educational Services' },
};

export const HEADCOUNT_BANDS = ['1-10', '11-50', '51-200', '201-500', '501-1000', '1001-5000', '5000+'];

/**
 * A revenue band for each headcount band, at roughly $200,000 of revenue per employee. This is a
 * rule of thumb for software companies, used to state the ICP in revenue terms. It is a targeting
 * criterion, never a fact about a company: a company only gets a revenue figure from a receipt.
 */
export const REVENUE_BY_HEADCOUNT: Record<string, string> = {
  '1-10': 'Under $2M',
  '11-50': '$2M to $10M',
  '51-200': '$10M to $40M',
  '201-500': '$40M to $100M',
  '501-1000': '$100M to $200M',
  '1001-5000': '$200M to $1B',
  '5000+': 'Over $1B',
};

export const SENIORITY_LEVELS = ['C-level', 'VP', 'Head of function', 'Director', 'Manager', 'Individual contributor'] as const;

/** The seniority level a job title implies. */
export function seniorityOf(title: string): (typeof SENIORITY_LEVELS)[number] {
  const t = title.toLowerCase();
  if (/\b(vp|svp|evp|vice president)\b/.test(t)) return 'VP';
  if (/\bchief\b|\bc[a-z]o\b|\bfounder\b|\bpresident\b|\bowner\b/.test(t)) return 'C-level';
  if (/\bhead\b/.test(t)) return 'Head of function';
  if (/\bdirector\b/.test(t)) return 'Director';
  if (/\b(manager|lead)\b/.test(t)) return 'Manager';
  return 'Individual contributor';
}

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
