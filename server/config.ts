try {
  process.loadEnvFile();
} catch {
  // No .env file. Everything has a default and the app runs without keys.
}

const env = process.env;

export const config = {
  port: Number(env.PORT ?? 8787),
  /** Absolute origin used in receipt source URLs. Set once the server is listening. */
  baseUrl: env.PUBLIC_URL ?? '',
  dbPath: env.RECEIPTS_DB ?? 'data/receipts.db',
  model: env.RECEIPTS_MODEL ?? 'claude-opus-5-5',
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
  /** Optional: every agent handoff is POSTed here as JSON (for Band or any other orchestrator). */
  agentWebhook: env.AGENT_EVENTS_WEBHOOK_URL ?? '',
};

export function llmEnabled(): boolean {
  return config.llm !== 'off' && Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
}
