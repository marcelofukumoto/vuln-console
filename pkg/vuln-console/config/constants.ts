// Every name this extension uses to find something in the cluster, in one place.
//
// The console it replaces had these spread across a 710-line watcher, a Python server and an
// HTML file, which is how `static-preview` ended up hardcoded in three of them and the PVC in
// `pvc.yaml` drifted away from the `emptyDir` the Deployment actually mounted. A constant that
// is read from one place cannot drift from itself.

/** Where this extension keeps its own state. Created on first use. */
export const NAMESPACE = 'vuln-console';

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
   * The package this repository gets most of its tree from, if it has one.
   *
   * `rancher-ai-ui` has exactly one runtime dependency - `@rancher/shell`, pinned exact - and
   * everything else is dev tooling. So most of its vulnerabilities are not its own: they are
   * shell's, seen from here, and the fix for them is a shell bump rather than a lockfile edit in
   * this repository.
   *
   * When this is set the gather works out which vulnerable libraries reach the tree ONLY through
   * it, and the board offers no Fix for those - it says where the fix belongs instead. A
   * repository that IS the shell (dashboard) has no owner and every row is its own to fix.
   */
  ownerPackage?: string;
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
    ownerPackage: '@rancher/shell',
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

/**
 * The Secret holding the GitHub tokens, and the prefix of the per-user keys inside it.
 *
 * One Secret, one key per Rancher user (`gh_token-<principal>`), because a fix is done BY
 * somebody: it pushes to their fork and opens the pull request as them. Extension Studio's
 * single shared `gh_token` is deliberately NOT used — its own code calls it "a token written by
 * anybody", which would make every fix in the cluster the work of one anonymous account.
 */
export const SECRET_NAME = 'settings';
export const GH_TOKEN_KEY = 'gh_token';

/**
 * The Rancher token key, also per user.
 *
 * A fix is verified by driving a browser at the dev server, and that server proxies Rancher's
 * API to the real cluster - so without a session the browser photographs a login page. Rancher's
 * session IS a cookie carrying a token, so the token is the login. Minted as the person looking
 * at the board, so what the screenshots show is what THEY can see.
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
export const BROWSER_PORT = 3000;
export const BROWSER_CDP_PORT = 9222;

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
