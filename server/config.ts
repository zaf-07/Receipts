try {
  process.loadEnvFile();
} catch {
  // No .env file. Everything has a default and the app runs without keys.
}

const env = process.env;
const provider = (env.RECEIPTS_LLM_PROVIDER ?? (env.GROQ_API_KEY ? 'groq' : 'anthropic')) as 'anthropic' | 'groq';

export const config = {
  port: Number(env.PORT ?? 8787),
  /** Absolute origin used in receipt source URLs. Set once the server is listening. */
  baseUrl: env.PUBLIC_URL ?? '',
  dbPath: env.RECEIPTS_DB ?? 'data/receipts.db',
  provider,
  model: env.RECEIPTS_MODEL ?? (provider === 'groq' ? 'openai/gpt-oss-20b' : 'claude-opus-5-5'),
  /** auto = use the LLM when credentials exist, off = always use the deterministic agents. */
  llm: (env.RECEIPTS_LLM ?? 'auto') as 'auto' | 'off',
  /** world = seeded local world the Skeptic can really re-fetch, live = the public web (needs the LLM). */
  source: (env.RECEIPTS_SOURCE ?? 'world') as 'world' | 'live',
  /** Tuned so the seeded run ends just short of one more enrichment, which shows the credit gate. */
  startingCredits: Number(env.RECEIPTS_STARTING_CREDITS ?? 38),
  costs: { enrich: 5, draft: 2, send: 1 },
  flexprice: {
    apiKey: env.FLEXPRICE_API_KEY ?? '',
    baseUrl: env.FLEXPRICE_BASE_URL ?? 'https://api.cloud.flexprice.io',
    customerId: env.FLEXPRICE_CUSTOMER_ID ?? '',
  },
  /** Legacy generic handoff sink. Prefer the first-class Band configuration below. */
  agentWebhook: env.AGENT_EVENTS_WEBHOOK_URL ?? '',
  /**
   * Band Agent API credentials. A single Receipts orchestrator identity writes the
   * visible activity stream into a Band room; each entry keeps the originating
   * Receipts role in its metadata.
   */
  band: {
    apiKey: env.BAND_API_KEY ?? '',
    chatId: env.BAND_CHAT_ID ?? '',
    baseUrl: (env.BAND_API_BASE_URL ?? 'https://app.band.ai/api/v1').replace(/\/$/, ''),
  },
  moss: {
    projectId: env.MOSS_PROJECT_ID ?? '',
    projectKey: env.MOSS_PROJECT_KEY ?? '',
  },
};

export function llmEnabled(): boolean {
  const credential = config.provider === 'groq' ? env.GROQ_API_KEY : env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN;
  return config.llm !== 'off' && Boolean(credential);
}

export function mossEnabled(): boolean {
  return Boolean(config.moss.projectId && config.moss.projectKey);
}
