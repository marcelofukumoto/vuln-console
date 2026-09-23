// Dependabot alerts over time, for every repository the UI team owns.
//
// The counts the boards show are today's. This is the other question - are we winning? - and it
// is answered from the alerts' own lifecycle: an alert is open on a date if it was created on or
// before it and not yet fixed, dismissed or auto-dismissed. That reconstructs seven years of
// history from one pull per repository, which is why there is no daily snapshot to keep.
//
// Reconstructed by seed/history.mjs on a schedule and stored whole, because the series is the
// artefact: a bucket is only correct relative to every other bucket, so half a history is not
// half as useful.
import { NAMESPACE } from '../config/constants';
import { STEVE_BASE, rancherFetch } from './rancher';

export const HISTORY_CONFIGMAP = 'dependabot-history';

/** One repository's four severity series, each aligned to `dates`. */
export interface RepoHistory {
  category: string;
  critical: number[];
  high: number[];
  medium: number[];
  low: number[];
  total: number[];
}

export interface History {
  generated_at: string;
  /** How many days one bucket covers. Weekly, so a seven-year series is ~360 points. */
  bucket_days: number;
  dates: string[];
  repos: Record<string, RepoHistory>;
  /** Repositories the token cannot read alerts for - listed, so their absence is not a claim. */
  skipped: string[];
}

/** Most severe first. The stack is drawn in this order from the baseline up. */
export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;

export type Severity = typeof SEVERITIES[number];

export async function readHistory(): Promise<History | null> {
  const cm = await rancherFetch(`${ STEVE_BASE }/configmaps/${ NAMESPACE }/${ HISTORY_CONFIGMAP }`).catch(() => null);
  const raw = cm?.data?.['history.json'];

  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as History;

    return parsed?.dates?.length ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The four series to draw, for one repository or for all of them summed.
 *
 * Summing is the honest default: the question "are we winning" is asked of the whole estate,
 * and a reader who wants one repository can pick it.
 */
export function seriesFor(history: History, repo: string): Record<Severity, number[]> {
  const out = {
    critical: [] as number[], high: [] as number[], medium: [] as number[], low: [] as number[],
  };
  const repos = repo === 'all' ? Object.values(history.repos) : [history.repos[repo]].filter(Boolean);

  for (const severity of SEVERITIES) {
    out[severity] = history.dates.map((_, i) => repos.reduce((sum, r) => sum + (r[severity][i] || 0), 0));
  }

  return out;
}

/** The tallest stack in the series, which is what the y axis has to reach. */
export function peakOf(series: Record<Severity, number[]>, dates: number): number {
  let peak = 0;

  for (let i = 0; i < dates; i++) {
    peak = Math.max(peak, SEVERITIES.reduce((sum, s) => sum + (series[s][i] || 0), 0));
  }

  return peak;
}
