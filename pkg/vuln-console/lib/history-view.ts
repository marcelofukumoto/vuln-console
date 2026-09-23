// The choices the history view offers, and the colours it draws them in.
//
// Kept out of the component so the palette decisions can carry their reasoning without burying
// the template, and so the options are a list rather than markup repeated five times.
import type { History, Severity } from './history';

export const MODES = [
  { id: 'area', label: 'Area (stacked)', hint: 'severities stacked — the estate over time' },
  { id: 'bars', label: 'Bars (by severity)', hint: 'the same, as columns' },
  { id: 'lines', label: 'Lines (per repo)', hint: 'one line per repository' },
] as const;

export type Mode = typeof MODES[number]['id'];

/** Ranges in DAYS, as the console this replaces offered them. */
export const RANGES = [
  { id: 14, label: '2 weeks' },
  { id: 90, label: '3 months' },
  { id: 182, label: '6 months' },
  { id: 365, label: '1 year' },
  { id: 0, label: 'All' },
] as const;

/** `total` is the sum of the four, and the default: it is the number people ask about. */
export const SEV_CHOICES = ['total', 'critical', 'high', 'medium', 'low'] as const;

export type SevChoice = typeof SEV_CHOICES[number];

/**
 * Eight categorical slots, in a fixed order, for per-repository lines.
 *
 * The documented palette, unmodified. It passes the adjacent-pair gates in both modes, which
 * is the pairlist lines are judged on. Three of the light slots sit below 3:1 on the surface,
 * so the relief rule applies - this view ships both a table and direct labels.
 *
 * A NINTH repository is never given a generated hue. Past the eight slots a line is drawn in
 * the muted ink and named only in the legend, because a ninth hue is one nobody can name.
 */
export const SERIES_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
export const SERIES_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];

/**
 * A repository's colour slot, fixed by WHICH repository it is.
 *
 * Deliberately not by its position among the selected ones: a filter that changes the series
 * count must not repaint the survivors, or two screenshots of the same repository disagree.
 */
export function slotFor(repo: string, all: string[]): number {
  return all.indexOf(repo);
}

/** How many buckets a range covers, given how many days one bucket spans. */
export function bucketsFor(days: number, bucketDays: number, total: number): number {
  return days ? Math.min(total, Math.ceil(days / bucketDays)) : total;
}

/** One line per repository, of whichever severity is chosen. */
export function linesFor(history: History, repos: string[], sev: SevChoice, from: number): { repo: string; values: number[] }[] {
  return repos.map((repo) => {
    const r = history.repos[repo];

    return { repo, values: (sev === 'total' ? r.total : r[sev as Severity]).slice(from) };
  });
}
