// Turn a gather snapshot into the three lists the board shows.
//
// This is a port of the console's `ledger.jq`, and it keeps that file's rules because each one
// was paid for:
//
//   * Placement is driven by the ALERT state, never by a merge. A merged pull request of ours
//     is evidence, not proof. The rule it replaced parked an open alert in "fixed by us" as
//     soon as one of our pull requests merged, and on 2026-07-30 that hid three of five open
//     brace-expansion alerts: the 5.0.7 bump landed, then a new advisory raised the bar to
//     5.0.8, so the alerts stayed open while the board showed two of them. An undercounting
//     security list is worse than a briefly noisy one.
//
//   * A pull request is matched to a library by LIBRARY ALONE, never by a version read out of
//     its title. Dependabot's "multi" pull requests bump every manifest and major line at once
//     but name a single version ("Bump diff to 5.2.2" while also taking the 8.x line to 8.0.3),
//     so a version-cover check split one library into an "in flight" row and a bogus
//     "actionable" one.
//
//   * A fixed alert is attributed by TIMING alone, for the same reason: a version gate drops
//     genuine fixes whose title names a lower version than the alert's `patched`.

import type { Alert, Ledger, PullRequest, Severity, Snapshot, VulnGroup } from '../types';

const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low'];

/** An hour of slack before a merge, and a week after, in milliseconds. */
const FIXED_BEFORE_MERGE_MS = 60 * 60 * 1000;
const FIXED_AFTER_MERGE_MS = 7 * 24 * 60 * 60 * 1000;

/** How long after a merge an open alert is still allowed to read as "awaiting re-scan". */
const RESCAN_LAG_MS = 12 * 60 * 60 * 1000;

export function severityRank(severity: string): number {
  const index = SEVERITY_ORDER.indexOf(severity as Severity);

  return index === -1 ? SEVERITY_ORDER.length : index;
}

function time(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const ms = Date.parse(value);

  return Number.isNaN(ms) ? null : ms;
}

/**
 * The library a pull request is about, or null when nothing says.
 *
 * The TITLE is authoritative. Dependabot writes "Bump <lib> from x to y" and we copy that, so
 * when a title is present it is the answer and the branch is not consulted - branch names do
 * not always agree with it. Pull request 18493 is titled "Bump serve-static from 1.14.1 to
 * 1.16.3" while its branch is `dependabot/npm_and_yarn/multi/send`; reading the branch too
 * attributes `send` alerts to a `serve-static` bump and invents a row the board has never
 * shown.
 */
export function prLibraryFromTitle(pr: Pick<PullRequest, 'title'>): string | null {
  const found = /^Bump\s+([@/A-Za-z0-9._-]+)/.exec(pr.title || '');

  return found ? found[1] : null;
}

/** The library a pull request is about, falling back to its branch. */
export function prLibrary(pr: Pick<PullRequest, 'title' | 'headRefName'>): string {
  const fromTitle = prLibraryFromTitle(pr);

  if (fromTitle) {
    return fromTitle;
  }

  const last = (pr.headRefName || '').split('/').pop() || '';

  return last.replace(/-[0-9].*$/, '');
}

/**
 * Every spelling Dependabot uses for one library.
 *
 * It names the branch for a scoped package by DROPPING the `@`, so `@babel/core` becomes
 * `dependabot/npm_and_yarn/multi/babel/core`, and elsewhere flattens the slash to a hyphen. A
 * matcher that knew only the written name never matched any scoped package, so every one of
 * them showed a Fix button beside an open pull request and never had its reviewers polled.
 */
function spellings(library: string): string[] {
  const bare = library.replace(/^@/, '');

  return [...new Set([library, bare, bare.replace(/\//g, '-')])];
}

/** Whether a pull request is about this library. */
export function prMatchesLibrary(pr: Pick<PullRequest, 'title' | 'headRefName'>, library: string): boolean {
  const names = spellings(library);
  const titled = prLibraryFromTitle(pr);

  if (titled) {
    return names.includes(titled);
  }

  const branch = pr.headRefName || '';

  return names.some((name) => branch.endsWith(`/${ name }`) || branch.includes(`/${ name }-`));
}

export interface LedgerInput {
  snapshot: Snapshot;
  /**
   * Alert ids a pull request is known to cover, recorded when that pull request was opened.
   * An explicit record beats any inference, and is the only thing that can tie a pull request
   * to an alert whose library was renamed or whose title says nothing useful.
   */
  locks?: Record<string, number[]>;
  now?: number;
}

function attribute(alert: Alert, input: LedgerInput, ourPrs: PullRequest[]): PullRequest | null {
  const locks = input.locks || {};

  for (const [number, ids] of Object.entries(locks)) {
    if (ids.includes(alert.id)) {
      const locked = ourPrs.find((pr) => pr.number === Number(number));

      if (locked) {
        return locked;
      }
    }
  }

  const ours = ourPrs.filter((pr) => prMatchesLibrary(pr, alert.library));
  const now = input.now ?? Date.now();

  if (alert.state === 'open') {
    // An open pull request of ours claims every open alert for its library. An OLD merged one
    // never does - that row stays actionable, which is the whole point of the rule above.
    const open = ours.find((pr) => pr.status === 'open');

    if (open) {
      return open;
    }

    const recentlyMerged = ours
      .filter((pr) => pr.status === 'merged')
      .filter((pr) => {
        const merged = time(pr.mergedAt);

        return merged !== null && now - merged <= RESCAN_LAG_MS;
      })
      .sort((a, b) => (time(b.mergedAt) || 0) - (time(a.mergedAt) || 0))[0];

    return recentlyMerged || null;
  }

  if (alert.state === 'fixed') {
    // Timing alone, deliberately. GitHub stamps `fixed_at` when the fix lands, so a merge just
    // before it is the one that closed it; the window is the guard against coincidence. Never
    // an open pull request - that would make the row vanish from every list.
    const fixedAt = time(alert.fixedAt);

    if (fixedAt === null) {
      return null;
    }

    return ours
      .filter((pr) => pr.status === 'merged')
      .filter((pr) => {
        const merged = time(pr.mergedAt);

        if (merged === null) {
          return false;
        }

        return fixedAt >= merged - FIXED_BEFORE_MERGE_MS && fixedAt <= merged + FIXED_AFTER_MERGE_MS;
      })
      .sort((a, b) => (time(b.mergedAt) || 0) - (time(a.mergedAt) || 0))[0] || null;
  }

  return null;
}

function group(rows: { alert: Alert; pr: PullRequest | null }[]): VulnGroup[] {
  const byLibrary = new Map<string, { alert: Alert; pr: PullRequest | null }[]>();

  for (const row of rows) {
    const existing = byLibrary.get(row.alert.library);

    if (existing) {
      existing.push(row);
    } else {
      byLibrary.set(row.alert.library, [row]);
    }
  }

  const groups: VulnGroup[] = [];

  for (const [library, members] of byLibrary) {
    const vulns = members.map((m) => m.alert).sort((a, b) => b.id - a.id);
    const severity = vulns
      .map((v) => v.severity)
      .sort((a, b) => severityRank(a) - severityRank(b))[0] || 'low';

    groups.push({
      library,
      severity,
      pr:        members.map((m) => m.pr).find((pr) => pr !== null) || null,
      vulns,
      unfixable: vulns.length > 0 && vulns.every((v) => !v.patched),
    });
  }

  return groups.sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.library.localeCompare(b.library));
}

export function buildLedger(input: LedgerInput): Ledger {
  const { snapshot } = input;
  const ourPrs = snapshot.ourPrs || [];
  const rows = (snapshot.alerts || []).map((alert) => ({ alert, pr: attribute(alert, input, ourPrs) }));

  const openNoPr = rows.filter((r) => r.alert.state === 'open' && r.pr?.status !== 'open');
  const openPrOpen = rows.filter((r) => r.alert.state === 'open' && r.pr?.status === 'open');
  const prMerged = rows.filter((r) => r.alert.state !== 'open' && r.pr?.status === 'merged');

  const lists = {
    openNoPr:   group(openNoPr),
    openPrOpen: group(openPrOpen),
    prMerged:   group(prMerged),
  };

  // Counts are ALERTS, not rows. A library with four advisories is one row and four
  // vulnerabilities, and the tiles are a security count - "3 libraries" would understate what
  // is open. The board's own header reads "<n> open" off these.
  return {
    generatedAt: snapshot.gatheredAt,
    lists,
    counts:      {
      openNoPr:   openNoPr.length,
      openPrOpen: openPrOpen.length,
      prMerged:   prMerged.length,
    },
  };
}

/**
 * Whether a row's attached pull request merged without clearing its alert.
 *
 * The row belongs in the open list - the vulnerability is still live - but the board says WHY
 * it is back, so nobody reads it as an un-attempted fix.
 */
export function mergedButStillOpen(row: VulnGroup): boolean {
  return row.pr?.status === 'merged' && row.vulns.some((v) => v.state === 'open');
}
