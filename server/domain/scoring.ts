import type { Company, FitPart, IcpVersion, IntentPart, Receipt, ScoreInputs, Tier } from '../../shared/types';
import { FIT_POINTS, FRESHNESS_FLOOR, SIGNALS, TIER_A, TIER_B, bandFor } from '../../shared/constants';
import { isLive, isTrigger } from './state';

const DAY = 86_400_000;

/** Freshness falls linearly from 1 to 0.15 across the signal's window. */
export function freshness(r: Pick<Receipt, 'event_at' | 'seen_at'>, now: Date, windowDays: number): number {
  const start = new Date(r.event_at ?? r.seen_at).getTime();
  const age = Math.max(0, (now.getTime() - start) / DAY);
  const t = Math.min(1, age / windowDays);
  return 1 - (1 - FRESHNESS_FLOOR) * t;
}

export function tierFor(score: number): Tier {
  if (score >= TIER_A) return 'A';
  if (score >= TIER_B) return 'B';
  return 'C';
}

function fitPart(
  max: number,
  value: string | null,
  inIcp: (v: string) => boolean,
  inExpansion: (v: string) => boolean,
): FitPart {
  if (value == null) return { points: 0, max, matched: false, value: null, via: null };
  if (inIcp(value)) return { points: max, max, matched: true, value, via: 'icp' };
  if (inExpansion(value)) return { points: max, max, matched: true, value, via: 'expansion' };
  return { points: 0, max, matched: false, value, via: null };
}

/**
 * 0 to 100, half fit and half intent, with every input kept so the UI can show its work.
 * Fit: industry 45, headcount band 35, region 20. Accepted expansion segments widen fit.
 * Intent: for each live positive trigger, the signal type's weight times its freshness.
 */
export function scoreLead(
  company: Pick<Company, 'industry' | 'headcount' | 'region'>,
  receipts: Receipt[],
  icp: IcpVersion,
  now: Date,
): ScoreInputs {
  const accepted = icp.expansions.filter((e) => e.status === 'accepted');
  const has = <T>(list: { value: T }[], v: T) => list.some((x) => x.value === v);
  const band = bandFor(company.headcount);

  const fit = {
    industry: fitPart(
      FIT_POINTS.industry,
      company.industry,
      (v) => has(icp.fields.industries, v),
      (v) => accepted.some((e) => e.industries.includes(v)),
    ),
    headcount: fitPart(
      FIT_POINTS.headcount,
      band,
      (v) => has(icp.fields.headcount_bands, v),
      (v) => accepted.some((e) => e.headcount_bands.includes(v)),
    ),
    region: fitPart(
      FIT_POINTS.region,
      company.region,
      (v) => has(icp.fields.regions, v),
      () => false,
    ),
  };
  const fit_score = fit.industry.points + fit.headcount.points + fit.region.points;

  const intent: IntentPart[] = receipts
    .filter((r) => r.sign === 'positive' && isTrigger(r) && isLive(r, now))
    .map((r) => {
      const weight = icp.weights[r.signal_type] ?? SIGNALS[r.signal_type].weight;
      const window = icp.windows[r.signal_type] ?? SIGNALS[r.signal_type].window ?? 90;
      const f = freshness(r, now, window);
      return { receipt_id: r.id, signal_type: r.signal_type, weight, freshness: round(f, 3), points: round(weight * f, 1) };
    })
    .sort((a, b) => b.points - a.points);
  const intent_score = Math.min(100, round(intent.reduce((sum, p) => sum + p.points, 0), 1));

  const score = round(0.5 * fit_score + 0.5 * intent_score, 1);
  return { fit, fit_score, intent, intent_score, score, tier: tierFor(score) };
}

function round(n: number, places: number): number {
  const k = 10 ** places;
  return Math.round(n * k) / k;
}
