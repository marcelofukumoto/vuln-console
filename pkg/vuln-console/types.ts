// The shapes the board is built from.
//
// Deliberately close to what GitHub returns, because the console this replaces lost a whole
// afternoon to matchers that re-derived facts from Dependabot PR *titles* - a "multi" PR names
// one version in its title while bumping three major lines, so every version-cover check split
// one library into two bogus rows. Carry the fields; do not infer them.

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export type AlertState = 'open' | 'fixed' | 'dismissed' | 'auto_dismissed';

/**
 * One Dependabot alert. The board's primary key: a library is a grouping of these.
 *
 * The optional half is carried for OPEN alerts only. rancher/dashboard has around a thousand
 * alerts and all but a handful are closed, so a snapshot holding the advisory text for every
 * one of them spends half a ConfigMap saying things the shipped list never shows. What a closed
 * alert is for is "we fixed this", and the fields above the line are what says it.
 */
export interface Alert {
  /** The alert number, unique within the repository. */
  id: number;
  library: string;
  ghsa: string;
  severity: Severity;
  /** The lockfile this alert is raised against - one library can have several. */
  manifest: string;
  state: AlertState;
  /** The version that closes it, or null when Dependabot has no fix at all. */
  patched: string | null;
  fixedAt: string | null;

  ecosystem?: string;
  cve?: string | null;
  summary?: string;
  createdAt?: string;
}

/**
 * Where an alert is read, built rather than stored.
 *
 * A thousand of these is 65 KiB of one identical prefix, and the only part that varies is the
 * number the alert already carries.
 */
export function alertUrl(repo: string, id: number): string {
  return `https://github.com/${ repo }/security/dependabot/${ id }`;
}

export type PrStatus = 'open' | 'merged' | 'closed';

export interface PullRequest {
  number: number;
  url: string;
  title: string;
  headRefName: string;
  status: PrStatus;
  author: string;
  createdAt: string;
  mergedAt: string | null;
  /** Set once a verification video has been attached to the pull request body. */
  videoUrl?: string | null;
}

/** What one gather wrote. Everything the board shows is derived from this. */
export interface Snapshot {
  gatheredAt: string;
  repo: string;
  alerts: Alert[];
  /** Dependabot's own open pull requests, so the board can show "there is already one". */
  dependabotPrs: PullRequest[];
  /** Our pull requests on the target repository, open and recently merged. */
  ourPrs: PullRequest[];
}

/** One row of the board: a library, its alerts, and the pull request tied to them. */
export interface VulnGroup {
  library: string;
  severity: Severity;
  pr: PullRequest | null;
  vulns: Alert[];
  /** True when every alert lacks a patched version - there is nothing to bump to. */
  unfixable: boolean;
}

export interface Ledger {
  generatedAt: string;
  lists: {
    openNoPr: VulnGroup[];
    openPrOpen: VulnGroup[];
    prMerged: VulnGroup[];
  };
  counts: {
    openNoPr: number;
    openPrOpen: number;
    prMerged: number;
  };
}

export type JobAction =
  | 'fix'
  | 'pr'
  | 'record'
  | 'publish'
  | 'addresscomment'
  | 'resolveconflict';

export type JobPhase = 'Running' | 'Fixed' | 'Done' | 'Failed' | 'Cancelled';

/** One library's run record. Keyed by library, which is what the board groups on. */
export interface Job {
  /** Which board this belongs to. Two boards can hold a library of the same name. */
  board: string;
  library: string;
  phase: JobPhase;
  action: JobAction;
  /** Who pressed the button, for the pull request body and the row. */
  by: string;
  startedAt: number;
  updatedAt: number;
  /** The agents conversation, so the session can be watched and stopped. */
  sessionId: string | null;
  /** The apps-plus installation the work happens in. */
  workspace: string | null;
  branch: string | null;
  previewUrl: string | null;
  prUrl: string | null;
  prNumber: number | null;
  videoUrl: string | null;
  infoUrl: string | null;
  replyUrl: string | null;
  message: string | null;
  /** The alert ids this run covers, locked in when the pull request is opened. */
  vulnIds: number[];
}

export interface Reviewers {
  selected: string[];
  candidates: { login: string; email: string }[];
}
