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
  /** The GitHub account the stored token belongs to — who "ours" means. */
  tokenLogin: string;
  alerts: Alert[];
  /** Dependabot's own open pull requests, so the board can show "there is already one". */
  dependabotPrs: PullRequest[];
  /** Our pull requests on the target repository, open and recently merged. */
  ourPrs: PullRequest[];

  /**
   * The Rancher packages this repository's tree comes through, and what upstream has done.
   *
   * Absent for a repository that is its own tree (dashboard).
   */
  rancherPackages?: RancherPackageState[];

  /**
   * For each vulnerable library, the DIRECT dependencies that actually reach it.
   *
   * Walked from the lockfile. A library commonly has several - `js-yaml` arrives through
   * `@rancher/shell`, through `@rancher/cypress` and through `jest` - which is why the board
   * groups rather than files each library in one place, and why this is a list.
   */
  sources?: Record<string, string[]>;
}

/**
 * How a library that arrives through one Rancher package can be cleared from THIS repository.
 *
 * Judged on what a bump would actually install here, not on rancher/dashboard master's
 * lockfile: master fixes most things with `resolutions` pins, and yarn never applies a
 * dependency's pins - so "clean on master" said nothing about what a consumer gets.
 */
export type UpstreamState =
  /** Bumping to the package's `target` clears it (refreshing any copy still left in range). */
  | 'fixed'
  /** Bumping to `target` stops pulling the library at all - a fix even with no patch published. */
  | 'gone'
  /** No bump needed: every range pulling a vulnerable copy already admits a patched version. */
  | 'refresh'
  /** Rancher clears it only with a `resolutions` pin, which no release carries: pin it here. */
  | 'pinned'
  /** Fixed on rancher's master, and no published version carries it yet. */
  | 'unreleased'
  /** Rancher's own master still resolves a vulnerable copy. */
  | 'open';

/** The states this repository can act on itself, with a Fix on the row. */
export const LOCAL_FIX_STATES: UpstreamState[] = ['refresh', 'pinned'];

/** One Rancher package a board depends on, as the gather found it. */
export interface RancherPackageState {
  name: string;
  label: string;
  /** What this repository has pinned. */
  version: string;
  /** The version tagged `latest` on the registry. */
  latest: string;
  /** The newest pre-release, when one is newer than `latest`. Absent on older snapshots. */
  prerelease?: string;
  /**
   * The version the group's bump goes to: whichever of `latest` / `prerelease` is newer than
   * `version` and clears the most, the stable one winning a tie. Empty when neither is newer.
   * Absent on snapshots written before pre-releases were considered.
   */
  target?: string;
  /** Whether there is a newer published version at all. */
  newerRelease: boolean;
  upstreamRepo: string;
  /** Per library, how it can be cleared here. */
  upstream: Record<string, UpstreamState>;
  /** For a `pinned` library, the pin rancher uses, as `"key": "value"`, when it pins it directly. */
  pins?: Record<string, string>;
  /** Set when the upstream could not be read; every row then reads unknown. */
  error?: string;
}

/** One row of the board: a library, its alerts, and the pull request tied to them. */
export interface VulnGroup {
  library: string;
  severity: Severity;
  pr: PullRequest | null;
  vulns: Alert[];
  /** True when every alert lacks a patched version - there is nothing to bump to. */
  unfixable: boolean;
  /**
   * The Rancher packages that reach this library, and how each stands upstream.
   *
   * Empty for a library that arrives some other way. Non-empty does NOT mean the row has no fix
   * of its own: a library can come through shell AND through jest, and then both the group's
   * bump and a local override are real options.
   */
  rancher: { name: string; label: string; state: UpstreamState; pin?: string }[];
  /** True when something other than a Rancher package also reaches it - so it is fixable here. */
  fixableHere: boolean;
  /**
   * True when a Fix on this row can clear it in this repository: reached by something other
   * than a Rancher package, or a Rancher-package path that a lockfile refresh or a pin clears.
   */
  localFix: boolean;
  /** For a group's bump: the exact version to bump the package to. */
  bumpTo?: string;
  /** What the board knows about how to fix this, handed to the run as a fact. */
  note?: string;
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
  /**
   * Where the run has got to, written by whatever is doing the work.
   *
   * Recorded rather than inferred. A first fix spends most of its life before the agent has done
   * anything - Fleet rendering a Bundle, an image pull, a clone, a yarn install - and a board
   * that says "Running" through all of it is a board that looks stuck. Each step names itself as
   * it starts, so the strip can say what is actually being waited for.
   */
  stage?: string;
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
