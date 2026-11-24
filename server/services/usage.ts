import { all, run } from '../db';
import { config } from '../config';
import { currentTask } from './context';

// Execution telemetry: every model call is recorded against the agent and the task that made it.

/** List prices in dollars per million tokens, input then output. A model missing here is counted in tokens only. */
const PRICES: Record<string, [number, number]> = {
  'claude-fable-5-2': [8, 40],
  'claude-opus-5-5': [4, 20],
  'claude-opus-5': [5, 25],
  'claude-sonnet-5-5': [2, 10],
  'claude-sonnet-5': [2, 10],
  'claude-haiku-5-5': [0.1, 0.5],
};

export function costOf(model: string, inputTokens: number, outputTokens: number): number | null {
  const price = PRICES[model];
  if (!price) return null;
  return (inputTokens * price[0] + outputTokens * price[1]) / 1_000_000;
}

/** Record one model call. Never throws: telemetry must not be able to break a task. */
export function recordUsage(purpose: string, inputTokens: number, outputTokens: number): void {
  try {
    const scope = currentTask();
    run(
      `INSERT INTO llm_usage (task_id, run_id, agent, purpose, provider, model, input_tokens, output_tokens, cost_usd, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      scope?.task_id ?? null,
      scope?.run_id ?? null,
      scope?.agent ?? 'system',
      purpose,
      config.provider,
      config.model,
      inputTokens,
      outputTokens,
      costOf(config.model, inputTokens, outputTokens),
      new Date().toISOString(),
    );
  } catch {
    // Dropped on purpose.
  }
}

interface Row {
  agent: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
  unpriced: number;
}

export function usageSummary() {
  const rows = all<Row>(
    `SELECT agent, COUNT(*) AS calls, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
            SUM(cost_usd) AS cost_usd, SUM(cost_usd IS NULL) AS unpriced
     FROM llm_usage GROUP BY agent ORDER BY calls DESC`,
  );
  const total = (pick: (r: Row) => number) => rows.reduce((n, r) => n + pick(r), 0);
  // A dollar figure is only shown when every call behind it had a known price.
  const priced = rows.every((r) => !r.unpriced);
  return {
    calls: total((r) => r.calls),
    input_tokens: total((r) => r.input_tokens),
    output_tokens: total((r) => r.output_tokens),
    cost_usd: rows.length && priced ? total((r) => r.cost_usd ?? 0) : null,
    by_agent: rows.map((r) => ({ agent: r.agent, calls: r.calls, tokens: r.input_tokens + r.output_tokens, cost_usd: r.unpriced ? null : r.cost_usd })),
  };
}
