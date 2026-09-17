// Every name this extension uses to find something in the cluster, in one place.
//
// The console it replaces had these spread across a 710-line watcher, a Python server and an
// HTML file, which is how `static-preview` ended up hardcoded in three of them and the PVC in
// `pvc.yaml` drifted away from the `emptyDir` the Deployment actually mounted. A constant that
// is read from one place cannot drift from itself.

/** Where this extension keeps its own state - snapshots, job records. Created on first use. */
export const NAMESPACE = 'vuln-console';

/**
 * Where the SETTINGS live, shared by every console in this family.
 *
 * One namespace rather than one per extension. The credential is the same GitHub token whoever
 * is using whichever board, and keeping a copy per extension meant the same secret pasted
 * twice, expiring at different times, with two dialogs disagreeing about whether it was set.
 */
export const SETTINGS_NAMESPACE = 'ui-internal-tools';

/**
 * One board: a repository whose Dependabot alerts are shown, and the fork its fixes go to.
 *
 * A list rather than a constant because the same process serves more than one repository, and
 * the process is the point - `rancher-ai-ui` is fixed exactly the way `dashboard` is, by the
 * same prompt in the same kind of workspace. Adding a third is adding an entry here.
 *
 * Everything a board owns is namespaced by its `id`: its snapshot, its jobs and its workspaces.
 * Two boards never share an object, so a fix on one cannot be confused for a fix on the other.
 */
/**
 * A Rancher package a board depends on, and where the fix for it actually lands.
 *
 * `upstreamRepo` + `manifest` say which subtree upstream to judge against. Both `@rancher/shell`
 * and `@rancher/cypress` are published from the rancher/dashboard monorepo - different
 * workspaces of one repository sharing one lockfile - so the question "has rancher fixed this
 * already" is asked of that workspace's own dependencies, not of the whole lockfile. Asking the
 * whole lockfile reports copies that this package never pulls.
 */
export interface RancherPackage {
  /** The dependency as this board's package.json names it. */
  name: string;
  /** A short name for its group on the board. */
  label: string;
  /** The repository the package is published from. */
  upstreamRepo: string;
  /** The manifest of the workspace inside it that builds the package. */
  manifest: string;
}

export interface Board {
  id: string;
  label: string;
  repo: string;
  /**
   * Where branches are pushed — an override, not the usual case.
   *
   * Normally left unset and DERIVED from the stored token: the fork is `<token owner>/<repo>`,
   * because the account that owns the token is the only account that can push. Hard-coding a
   * fork means an extension that only works for whoever wrote it, and fails at `git push` with
   * a 403 for everybody else - after doing all the work.
   *
   * Set it only to push somewhere that is not the token owner's own fork.
   */
  fork?: string;
  /**
   * Where pull requests are opened. Unset means the repository itself.
   *
   * The branch and the pull request go to different places, and that is the normal shape of
   * contributing: the branch is pushed to the token owner's fork, because that is the only
   * repository their token can write to, and the pull request is opened against the upstream
   * from `<owner>:<branch>`. Set this only to aim a board somewhere else - at the fork, say,
   * while trying something out.
   */
  prTarget?: string;

  /**
   * The Rancher packages this repository gets most of its tree from.
   *
   * `rancher-ai-ui` has exactly one runtime dependency - `@rancher/shell`, pinned exact - plus
   * `@rancher/cypress` for its tests, and everything else is dev tooling. So most of its
   * vulnerabilities are not its own: they are shell's or cypress's, seen from here, and the fix
   * is to bump that package rather than pin an override in a lockfile the next release
   * overwrites.
   *
   * A library can belong to several of these at once, and also be reachable from something that
   * is neither - `js-yaml` arrives through shell, through cypress AND through jest. So this is
   * a list and membership is not exclusive; the board groups by it rather than filing each
   * library in one place. A repository that IS the shell (dashboard) declares none, and every
   * row there is its own to fix.
   */
  rancherPackages?: RancherPackage[];

  /**
   * What this repository's dev server speaks. Defaults to https.
   *
   * Not a preference — an observation, and it differs per repository. rancher/dashboard's own
   * vue.config serves TLS; rancher-ai-ui goes through `@rancher/shell`'s and serves plain http.
   * Getting it wrong is silent and total: the readiness probe never passes, so the pod never
   * becomes Ready, and the service-proxy URL speaks the wrong protocol at it.
   */
  devScheme?: 'http' | 'https';
}

export const BOARDS: Board[] = [
  {
    id:    'dashboard',
    label: 'Dashboard',
    repo:  'rancher/dashboard',
  },
  {
    id:           'rancher-ai-ui',
    label:        'Rancher AI UI',
    repo:         'rancher/rancher-ai-ui',
    devScheme:    'http',
    rancherPackages: [
      {
        name: '@rancher/shell', label: 'Rancher shell', upstreamRepo: 'rancher/dashboard', manifest: 'shell/package.json',
      },
      {
        name: '@rancher/cypress', label: 'Rancher cypress', upstreamRepo: 'rancher/dashboard', manifest: 'cypress/package.json',
      },
    ],
  },
  {
    id:        'harvester-ui-extension',
    label:     'Harvester UI',
    repo:      'harvester/harvester-ui-extension',
    devScheme: 'http',
    /**
     * Shell only - it does NOT use `@rancher/cypress`, which rancher-ai-ui does. Declaring
     * cypress here would draw a group that is permanently empty.
     *
     * Having nineteen direct dependencies to ai-ui's one, I expected most of its
     * vulnerabilities to be its own. Measured on the first gather, they are not: 15 of 19 open
     * libraries still arrive through `@rancher/shell` and only 4 are reachable from anything
     * else - `ip`, which is a direct dependency, and `elliptic`, `fast-uri` and `js-yaml`,
     * which come through shell AND through a polyfill plugin or commitlint. Counting direct
     * dependencies predicts very little about who owns the tree; walking the lockfile is the
     * only thing that answers it, which is why this is computed per board and not assumed.
     */
    rancherPackages: [
      {
        name: '@rancher/shell', label: 'Rancher shell', upstreamRepo: 'rancher/dashboard', manifest: 'shell/package.json',
      },
    ],
  },
];

export function boardById(id: string): Board {
  return BOARDS.find((b) => b.id === id) || BOARDS[0];
}

/** The repository's short name: `rancher/dashboard` -> `dashboard`. */
export function repoName(repo: string): string {
  return repo.split('/').pop() || repo;
}

/**
 * Where this board's branches go, given who owns the stored token.
 *
 * The board's own `fork` wins when it has one; otherwise the token owner's fork of the same
 * repository. A fork is not assumed to exist - the workspace setup creates it if it is missing,
 * which is one API call and saves a failure three minutes into a run.
 */
export function forkFor(board: Board, tokenLogin: string): string {
  return board.fork || (tokenLogin ? `${ tokenLogin }/${ repoName(board.repo) }` : '');
}

export function prTargetFor(board: Board): string {
  return board.prTarget || board.repo;
}

export function devSchemeFor(board: Board): 'http' | 'https' {
  return board.devScheme || 'https';
}

/**
 * The Secret holding the GitHub tokens, and the prefix of the per-user keys inside it.
 *
 * One Secret, one key per Rancher user (`gh_token-<principal>`), because a fix is done BY
 * somebody: it pushes to their fork and opens the pull request as them. Extension Studio's
 * One credential for the installation, not one per person.
 *
 * It was per user, so a fix pushed to the pusher's own fork and was authored by them. That is
 * still the nicer shape, and it is not what is wanted here: the token is now set by the `admin`
 * user alone and everybody's runs use it, so every fix is the work of whatever account it
 * belongs to. Said plainly because it is a real trade - attribution for one place to manage.
 */
export const SECRET_NAME = 'settings';
export const GH_TOKEN_KEY = 'gh_token';

/**
 * The Rancher token key.
 *
 * A fix is verified by driving a browser at the dev server, and that server proxies Rancher's
 * API to the real cluster - so without a session the browser photographs a login page.
 *
 * Not typed into the Credentials dialog like the GitHub one: it is minted same-origin at the
 * start of each run, from the session of whoever pressed the button, and lands here only so
 * the workspace setup can read it back out. The screenshots then show what that person can
 * see, while the branch is pushed as the shared account.
 */
export const RANCHER_TOKEN_KEY = 'rancher_token';

/** How long a minted Rancher token lives. Long enough for any fix, short enough to expire. */
export const RANCHER_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** ConfigMap names and the labels that mark what this extension owns, and for which board. */
export const OWNER_LABEL = 'vuln-console.rancher.io/owns';
export const BOARD_LABEL = 'vuln-console.rancher.io/board';
export const SNAPSHOT_PREFIX = 'snapshot-';
export const REVIEWERS_CONFIGMAP = 'reviewers';
export const JOB_PREFIX = 'job-';

/** The apps-plus App that describes a fix workspace, and the instances made from it. */
export const WORKSPACE_APP = 'vuln-workspace';
export const WORKSPACE_PORT = 8005;
/** The Chromium sidecar in a fix workspace. Not a browser of anybody's own - see below. */
export const BROWSER_PORT = 3000;

/** Where a workspace's checkout lives, on both sides of the exec tunnel. */
export const WORKSPACES_ROOT = '/workspaces';

/** How many alerts a single gather will page through before giving up. */
export const MAX_ALERT_PAGES = 20;

/**
 * A fix that has not written a heartbeat for this long is presumed dead, so the board offers
 * Stop rather than showing a spinner for ever. The old console force-cleared `busy` after 45
 * seconds, which was short enough to free a run that was merely slow.
 */
export const STALE_RUN_MS = 15 * 60 * 1000;
