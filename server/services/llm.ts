import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { type z, toJSONSchema } from 'zod';
import { config, llmEnabled } from '../config';
import { recordUsage } from './usage';

let client: Anthropic | null = null;
const anthropic = () => (client ??= new Anthropic());

function report(where: string, err: unknown): void {
  if (err instanceof Anthropic.AuthenticationError) console.warn(`[llm] ${where}: credentials rejected`);
  else if (err instanceof Anthropic.RateLimitError) console.warn(`[llm] ${where}: rate limited`);
  else if (err instanceof Anthropic.APIError) console.warn(`[llm] ${where}: API error ${err.status}: ${err.message}`);
  else console.warn(`[llm] ${where}: ${String(err)}`);
}

/** Groq's OpenAI-compatible endpoint. Zod still validates every response before callers use it. */
async function groqStructured<S extends z.ZodType>(where: string, schema: S, system: string, user: string): Promise<z.infer<S> | null> {
  const key = process.env.GROQ_API_KEY;
  if (!key) return null;
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        max_completion_tokens: 16_000,
        messages: [
          { role: 'system', content: `${system}\n\nReturn only JSON that conforms to the requested schema.` },
          { role: 'user', content: user },
        ],
        response_format: { type: 'json_schema', json_schema: { name: `${where}_output`, strict: false, schema: toJSONSchema(schema) } },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    recordUsage(where, body.usage?.prompt_tokens ?? 0, body.usage?.completion_tokens ?? 0);
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error('empty completion');
    const parsed = schema.safeParse(JSON.parse(content));
    if (!parsed.success) throw new Error(`response failed schema validation: ${parsed.error.issues[0]?.message ?? 'unknown error'}`);
    return parsed.data;
  } catch (err) {
    report(`groq ${where}`, err);
    return null;
  }
}

/**
 * One structured call. Returns null on any failure (no credentials, refusal, bad output),
 * and every caller has a deterministic fallback, so the pipeline never depends on the model.
 */
export async function structured<S extends z.ZodType>(
  where: string,
  schema: S,
  system: string,
  user: string,
  effort: 'low' | 'medium' | 'high' = 'low',
): Promise<z.infer<S> | null> {
  if (!llmEnabled()) return null;
  if (config.provider === 'groq') return groqStructured(where, schema, system, user);
  try {
    const res = await anthropic().messages.parse({
      model: config.model,
      max_tokens: 16000,
      system,
      messages: [{ role: 'user', content: user }],
      output_config: { effort, format: zodOutputFormat(schema) },
    });
    if (res.stop_reason === 'refusal' || res.stop_reason === 'max_tokens') {
      console.warn(`[llm] ${where}: stopped with ${res.stop_reason}`);
      return null;
    }
    recordUsage(where, res.usage.input_tokens, res.usage.output_tokens);
    return (res.parsed_output as z.infer<S> | null) ?? null;
  } catch (err) {
    report(where, err);
    return null;
  }
}

const SECOND_HAND = ['wikipedia.org', 'g2.com', 'capterra.com', 'reddit.com', 'quora.com', 'youtube.com', 'linkedin.com', 'crunchbase.com', 'glassdoor.com', 'medium.com'];

export interface WebResult {
  url: string;
  title: string;
}

/** Live-web search through the hosted web search tool. Returns result URLs only; we fetch pages ourselves. */
export async function webSearch(query: string, maxResults = 6): Promise<WebResult[]> {
  if (!llmEnabled()) return [];
  if (config.provider === 'groq') {
    console.warn('[llm] web search is not configured for the Groq provider; use RECEIPTS_SOURCE=world or add a search integration.');
    return [];
  }
  try {
    const res = await anthropic().messages.create({
      model: config.model,
      max_tokens: 4000,
      output_config: { effort: 'low' },
      // Reference sites, review aggregators and social networks describe companies but are not where
      // a company announces a hire, a round or a pricing change. They are also the ones that block reads.
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 2, blocked_domains: SECOND_HAND }],
      messages: [
        {
          role: 'user',
          content: `Today is ${new Date().toISOString().slice(0, 10)}. Search the web for: ${query}
Find pages published in the last three months where one specific company announces something itself: a job posting on its careers page or a job board, a funding announcement, a new executive, a pricing or product change, layoffs. Skip roundups, listicles, vendor comparison posts and encyclopedia entries. Reply with one short line.`,
        },
      ],
    });
    const out: WebResult[] = [];
    recordUsage('web search', res.usage.input_tokens, res.usage.output_tokens);
    for (const block of res.content) {
      if (block.type !== 'web_search_tool_result' || !Array.isArray(block.content)) continue;
      for (const item of block.content) {
        if (item.type === 'web_search_result' && !out.some((o) => o.url === item.url)) out.push({ url: item.url, title: item.title });
      }
    }
    return out.slice(0, maxResults);
  } catch (err) {
    report('web search', err);
    return [];
  }
}
