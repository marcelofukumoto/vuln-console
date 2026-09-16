// The shapes the board is built from.
//
// Deliberately close to what GitHub returns, because the console this replaces lost a whole
// afternoon to matchers that re-derived facts from Dependabot PR *titles* - a "multi" PR names
// one version in its title while bumping three major lines, so every version-cover check split
// one library into two bogus rows. Carry the fields; do not infer them.

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export type AlertState = 'open' | 'fixed' | 'dismissed' | 'auto_dismissed';

/** One Dependabot alert. The board's primary key: a library is a grouping of these. */
export interface Alert {
  /** The alert number, unique within the repository. */
  id: number;
  library: string;
  ecosystem: string;
  ghsa: string;
  cve: string | null;
  severity: Severity;
  summary: string;
  /** The lockfile this alert is raised against - one library can have several. */
  manifest: string;
  scope: string;
  relationship: string;
  state: AlertState;
  vulnerableRange: string;
  /** The version that closes it, or null when Dependabot has no fix at all. */
  patched: string | null;
  url: string;
  createdAt: string;
  fixedAt: string | null;
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
