import { Router } from 'express';
import type { WorldPageView } from '../../shared/types';
import { all, get, getSetting, newId, run, setSetting } from '../db';
import { daysFrom, now } from '../clock';
import { config } from '../config';
import { htmlToText } from '../domain/text';
import { SEED_SITES } from './seed';

interface PageRow {
  id: string;
  site: string;
  company: string;
  domain: string;
  path: string;
  kind: string;
  title: string;
  body: string;
  published_at: string | null;
  days_ago: number | null;
  status: 'live' | 'gone' | 'scheduled';
  batch: number;
  after_crawl: string | null;
}

export const worldBase = () => `${config.baseUrl}/world`;
export const siteUrl = (slug: string) => `${worldBase()}/sites/${slug}/`;
const pageUrl = (row: Pick<PageRow, 'site' | 'path'>) => `${siteUrl(row.site)}${row.path}`;

export function isWorldUrl(url: string): boolean {
  return url.startsWith(`${worldBase()}/`);
}

/** Site root for a world page URL, or null when the URL is not in the world. */
export function worldSiteOf(url: string): string | null {
  const m = url.match(/\/world\/sites\/([a-z0-9-]+)\//);
  return m ? siteUrl(m[1]) : null;
}

/** Load the seeded world. Publication dates are relative to the app clock at seeding time. */
export function seedWorld(): void {
  run('DELETE FROM world_pages');
  const at = now();
  for (const site of SEED_SITES) {
    for (const page of site.pages) {
      const batch = page.batch ?? 0;
      run(
        `INSERT INTO world_pages (id, site, company, domain, path, kind, title, body, published_at, days_ago, status, batch, after_crawl)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newId('w'),
        site.slug,
        site.name,
        site.domain,
        page.path,
        page.kind,
        page.title,
        page.body,
        batch === 0 && page.daysAgo != null ? daysFrom(at, -page.daysAgo).toISOString() : null,
        page.daysAgo ?? null,
        batch === 0 ? 'live' : 'scheduled',
        batch,
        page.afterCrawl ? JSON.stringify(page.afterCrawl) : null,
      );
    }
  }
  setSetting('world_after_crawl_done', false);
}

export function worldSeeded(): boolean {
  return (get<{ n: number }>('SELECT COUNT(*) AS n FROM world_pages')?.n ?? 0) > 0;
}

export function pendingBatches(): number {
  return get<{ n: number }>("SELECT COUNT(DISTINCT batch) AS n FROM world_pages WHERE status = 'scheduled'")?.n ?? 0;
}

/** Publish the next scheduled batch of pages, as if the companies had just posted them. */
export function releaseNextBatch(): { company: string; title: string }[] {
  const next = get<{ b: number | null }>("SELECT MIN(batch) AS b FROM world_pages WHERE status = 'scheduled'")?.b;
  if (next == null) return [];
  const rows = all<PageRow>("SELECT * FROM world_pages WHERE status = 'scheduled' AND batch = ?", next);
  const at = now();
  for (const row of rows) {
    run("UPDATE world_pages SET status = 'live', published_at = ? WHERE id = ?", daysFrom(at, -(row.days_ago ?? 0)).toISOString(), row.id);
  }
  return rows.map((r) => ({ company: r.company, title: r.title }));
}

/**
 * The world moves on after the first crawl: one job posting is taken down and one
 * announcement is edited. Runs once. Returns a description of each change.
 */
export function applyAfterCrawl(): string[] {
  if (getSetting<boolean>('world_after_crawl_done', false)) return [];
  const changes: string[] = [];
  for (const row of all<PageRow>("SELECT * FROM world_pages WHERE after_crawl IS NOT NULL AND status = 'live'")) {
    const action = JSON.parse(row.after_crawl!) as { action: 'gone' } | { action: 'edit'; body: string };
    if (action.action === 'gone') {
      run("UPDATE world_pages SET status = 'gone' WHERE id = ?", row.id);
      changes.push(`${row.company} took down "${row.title}"`);
    } else {
      run('UPDATE world_pages SET body = ? WHERE id = ?', action.body, row.id);
      changes.push(`${row.company} rewrote "${row.title}"`);
    }
  }
  setSetting('world_after_crawl_done', true);
  return changes;
}

export function setPageStatus(id: string, status: 'live' | 'gone'): PageRow | null {
  const row = get<PageRow>('SELECT * FROM world_pages WHERE id = ?', id);
  if (!row || row.status === 'scheduled') return null;
  run('UPDATE world_pages SET status = ? WHERE id = ?', status, id);
  return { ...row, status };
}

export function listWorldPages(): WorldPageView[] {
  return all<PageRow>('SELECT * FROM world_pages ORDER BY company, batch, path').map((r) => ({
    id: r.id,
    site: r.site,
    company: r.company,
    path: r.path,
    title: r.title,
    kind: r.kind,
    status: r.status,
    url: pageUrl(r),
    published_at: r.published_at,
  }));
}

// ---------- rendering ----------

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const STYLE = `
  body{font:16px/1.6 Georgia,'Times New Roman',serif;color:#1b1b18;background:#fbfaf7;margin:0}
  .demo{font:12px/1.4 ui-monospace,Menlo,Consolas,monospace;background:#1b1b18;color:#e9e6dc;padding:6px 16px}
  header,main,footer{max-width:680px;margin:0 auto;padding:0 20px}
  header{padding-top:28px;display:flex;gap:18px;align-items:baseline;border-bottom:1px solid #dcd8cc;padding-bottom:12px}
  header strong{font-size:20px} header a{color:#55524a;text-decoration:none;font:13px ui-monospace,Menlo,Consolas,monospace}
  h1{font-size:30px;line-height:1.2;margin:32px 0 6px} .date{color:#77736a;font:13px ui-monospace,Menlo,Consolas,monospace;margin:0 0 20px}
  li{margin:8px 0} footer{color:#8a867c;font:12px ui-monospace,Menlo,Consolas,monospace;margin-top:48px;padding-bottom:40px}
`;

function shell(company: string, site: string, domain: string, title: string, inner: string): string {
  const root = `/world/sites/${site}/`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta property="og:site_name" content="${esc(company)}">
<meta name="robots" content="noindex">
<title>${esc(title)} | ${esc(company)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="demo">Seeded demo world. ${esc(company)} is a fictional company. This page is served locally so sources can really be re-fetched.</div>
<header><strong>${esc(company)}</strong><a href="${root}">Home</a><a href="${root}about">About</a></header>
<main>
${inner}
</main>
<footer>&copy; ${esc(company)} &middot; ${esc(domain)}</footer>
</body>
</html>`;
}

function renderPage(row: PageRow): string {
  const date = row.published_at
    ? `<p class="date">Published <time datetime="${row.published_at.slice(0, 10)}">${new Date(row.published_at).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      })}</time></p>`
    : '';
  return shell(row.company, row.site, row.domain, row.title, `<h1>${esc(row.title)}</h1>\n${date}\n${row.body}`);
}

function renderIndex(rows: PageRow[]): string {
  const first = rows[0];
  const items = rows.map((r) => `<li><a href="/world/sites/${r.site}/${r.path}">${esc(r.title)}</a></li>`).join('\n');
  return shell(first.company, first.site, first.domain, first.company, `<h1>${esc(first.company)}</h1>\n<ul>\n${items}\n</ul>`);
}

// ---------- search ----------

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'its', 'our', 'has', 'to', 'of', 'in', 'on', 'is', 'as', 'at', 'by', 'or', 'an']);

function searchWorld(query: string): { url: string; title: string; snippet: string }[] {
  const tokens = [...new Set(query.toLowerCase().split(/[^a-z0-9%$-]+/).filter((t) => t.length >= 2 && !STOP.has(t)))];
  if (tokens.length === 0) return [];
  const scored = all<PageRow>("SELECT * FROM world_pages WHERE status = 'live'").map((row) => {
    const text = ` ${`${row.company} ${row.title} ${htmlToText(row.body)}`.toLowerCase().replace(/[^a-z0-9%$-]+/g, ' ')} `;
    const hits = tokens.filter((t) => text.includes(` ${t} `) || text.includes(` ${t}s `)).length;
    return { row, hits };
  });
  return scored
    .filter((s) => s.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 30)
    .map(({ row }) => ({ url: pageUrl(row), title: `${row.title} | ${row.company}`, snippet: htmlToText(row.body).split('\n')[0] ?? '' }));
}

// ---------- routes ----------

export function worldRouter(): Router {
  const router = Router();

  router.get('/search', (req, res) => {
    res.json({ results: searchWorld(String(req.query.q ?? '')) });
  });

  router.get('/sites/:slug', (req, res) => {
    const rows = all<PageRow>("SELECT * FROM world_pages WHERE site = ? AND status = 'live' ORDER BY kind, path", req.params.slug);
    if (rows.length === 0) return void res.status(404).type('text/plain').send('Not found');
    res.type('html').send(renderIndex(rows));
  });

  router.get('/sites/:slug/*path', (req, res) => {
    const raw = (req.params as Record<string, string | string[]>).path;
    const path = Array.isArray(raw) ? raw.join('/') : String(raw);
    const row = get<PageRow>('SELECT * FROM world_pages WHERE site = ? AND path = ?', req.params.slug, path);
    if (!row || row.status === 'scheduled') return void res.status(404).type('text/plain').send('Not found');
    if (row.status === 'gone') return void res.status(410).type('text/plain').send('This page has been removed.');
    res.type('html').send(renderPage(row));
  });

  return router;
}
