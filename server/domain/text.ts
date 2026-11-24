// Text helpers. The snippet check here is the whole basis of "no receipt, no action",
// so it is deliberately strict: a snippet either appears on the page or it does not.

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
  '&middot;': '·',
  '&mdash;': '—',
  '&ndash;': '–',
  '&copy;': '©',
};

export function decodeEntities(text: string): string {
  return text
    .replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

/** Visible text of an HTML page, one block element per line. */
export function htmlToText(html: string): string {
  const body = html
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|ul|ol|h[1-6]|tr|section|article|header|footer|main|nav|table|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(body)
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/** Lowercase, straighten quotes and dashes, collapse whitespace. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when the snippet appears on the page, ignoring case and whitespace differences. */
export function containsSnippet(pageText: string, snippet: string): boolean {
  const needle = normalize(snippet);
  if (needle.length < 8) return false;
  return normalize(pageText).includes(needle);
}

export function splitSentences(text: string): string[] {
  return text
    .split('\n')
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z"'(])/))
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Digit groups in a sentence, e.g. "$42 million Series B" gives ["42"]. */
export function extractNumbers(text: string): string[] {
  return (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, ''));
}

export function metaContent(html: string, key: string): string | null {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*content=["']([^"']*)["']`,
    'i',
  );
  const m = html.match(re);
  return m ? decodeEntities(m[1]) : null;
}

export function pageTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
}

/** Publication date stated on the page, if any. */
export function pageDate(html: string): string | null {
  const candidates = [
    html.match(/<time[^>]+datetime=["']([^"']+)["']/i)?.[1],
    metaContent(html, 'article:published_time'),
    metaContent(html, 'date'),
  ];
  for (const c of candidates) {
    if (!c) continue;
    const d = new Date(c);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

export function links(html: string, baseUrl: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/<a[^>]+href=["']([^"'#]+)["']/gi)) {
    try {
      out.add(new URL(m[1], baseUrl).toString());
    } catch {
      // Ignore malformed hrefs.
    }
  }
  return [...out];
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
