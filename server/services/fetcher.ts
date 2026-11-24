import { htmlToText } from '../domain/text';

export interface FetchedPage {
  url: string;
  ok: boolean;
  status: number;
  html: string;
  text: string;
  /** Why the fetch failed, in words a reviewer can read. Null when ok. */
  error: string | null;
}

const MAX_BYTES = 1_500_000;

/**
 * Fetch a public page. Used by the Researcher to read sources and by the Skeptic to re-open them.
 * Unreachable is reported, never guessed around: a source we cannot open is a source we cannot cite.
 */
export async function fetchPage(url: string, timeoutMs = 8000): Promise<FetchedPage> {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'ReceiptsBot/0.1 (source verification)', accept: 'text/html,text/plain;q=0.9,*/*;q=0.5' },
    });
    const raw = await res.text();
    const html = raw.length > MAX_BYTES ? raw.slice(0, MAX_BYTES) : raw;
    if (!res.ok) {
      const gone = res.status === 404 || res.status === 410;
      return { url, ok: false, status: res.status, html, text: '', error: `${gone ? 'page is gone' : 'page returned an error'} (HTTP ${res.status})` };
    }
    return { url, ok: true, status: res.status, html, text: htmlToText(html), error: null };
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'TimeoutError';
    return { url, ok: false, status: 0, html: '', text: '', error: timedOut ? 'page timed out' : 'page is unreachable' };
  }
}
