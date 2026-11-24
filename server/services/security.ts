import { createHmac, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { config } from '../config';

const SECRET_VALUE = /\b(api[_-]?key|token|secret|password)\s*([:=])\s*([^\s,;]+)/gi;
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi;

/** Keep credentials out of the activity feed, external event sinks, and model prompts. */
export function redactSensitive(value: string): string {
  return value.replace(SECRET_VALUE, '$1$2 [redacted]').replace(BEARER_VALUE, 'Bearer [redacted]');
}

export function inboundSignature(body: Buffer | string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

/** Accept either a bare hexadecimal signature or the conventional sha256=<hex> form. */
export function validInboundSignature(body: Buffer | string, supplied: string | undefined, secret: string): boolean {
  if (!supplied || !secret) return false;
  const actual = supplied.replace(/^sha256=/i, '').trim();
  const expected = inboundSignature(body, secret);
  const left = Buffer.from(actual, 'hex');
  const right = Buffer.from(expected, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

function trustedLocalWorld(url: URL): boolean {
  if (!config.baseUrl) return false;
  try {
    const base = new URL(config.baseUrl);
    return url.origin === base.origin && url.pathname.startsWith('/world/');
  } catch {
    return false;
  }
}

function privateAddress(address: string): boolean {
  const value = address.toLowerCase();
  if (value === '::1' || value === '::' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80:')) return true;
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Synchronous shape checks, exported for tests and before DNS/network work. */
export function sourceUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'source URL is malformed';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'only http and https sources are allowed';
  if (url.username || url.password) return 'source URLs cannot contain credentials';
  if (!url.hostname) return 'source URL has no host';
  if (trustedLocalWorld(url)) return null;
  if (url.hostname === 'localhost' || privateAddress(url.hostname.replace(/^\[|\]$/g, ''))) return 'private-network sources are not allowed';
  return null;
}

/** Defend the source fetcher against SSRF, including hostnames that resolve to private IP space. */
export async function safeSourceUrl(raw: string): Promise<{ ok: true; url: URL } | { ok: false; reason: string }> {
  const problem = sourceUrlProblem(raw);
  if (problem) return { ok: false, reason: problem };
  const url = new URL(raw);
  if (trustedLocalWorld(url)) return { ok: true, url };
  try {
    const addresses = await lookup(url.hostname, { all: true, verbatim: true });
    if (addresses.length === 0 || addresses.some((entry) => privateAddress(entry.address))) return { ok: false, reason: 'source resolves to a private-network address' };
  } catch {
    return { ok: false, reason: 'source hostname could not be resolved safely' };
  }
  return { ok: true, url };
}
