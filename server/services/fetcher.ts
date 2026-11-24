import { htmlToText } from '../domain/text';
import { safeSourceUrl } from './security';

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
    let current = url;
    let res: Response | null = null;
    for (let redirects = 0; redirects <= 4; redirects++) {
      const checked = await safeSourceUrl(current);
      if (!checked.ok) return { url: current, ok: false, status: 0, html: '', text: '', error: `source blocked: ${checked.reason}` };
      res = await fetch(checked.url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'user-agent': 'ReceiptsBot/0.1 (source verification)', accept: 'text/html,text/plain;q=0.9,*/*;q=0.5' },
      });
      if (res.status < 300 || res.status >= 400) break;
      const location = res.headers.get('location');
      if (!location) return { url: current, ok: false, status: res.status, html: '', text: '', error: 'redirect had no destination' };
      current = new URL(location, checked.url).toString();
      res = null;
    }
    if (!res) return { url: current, ok: false, status: 0, html: '', text: '', error: 'too many redirects' };
    const raw = await res.text();
    const html = raw.length > MAX_BYTES ? raw.slice(0, MAX_BYTES) : raw;
    if (!res.ok) {
      const gone = res.status === 404 || res.status === 410;
      return { url: current, ok: false, status: res.status, html, text: '', error: `${gone ? 'page is gone' : 'page returned an error'} (HTTP ${res.status})` };
    }
    return { url: current, ok: true, status: res.status, html, text: htmlToText(html), error: null };
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'TimeoutError';
    return { url, ok: false, status: 0, html: '', text: '', error: timedOut ? 'page timed out' : 'page is unreachable' };
  }
}
