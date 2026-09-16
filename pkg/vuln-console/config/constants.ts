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
  /** Where branches are pushed. */
  fork: string;
  /**
   * Where pull requests are opened.
   *
   * The fork, for now. Branches and pull requests are made there first so a mistake costs
   * nothing; moving a board to its upstream is changing this one field.
   */
  prTarget: string;

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
    id:       'dashboard',
    label:    'Dashboard',
    repo:     'rancher/dashboard',
    fork:     'marcelofukumoto/dashboard',
    prTarget: 'marcelofukumoto/dashboard',
  },
  {
    id:           'rancher-ai-ui',
    label:        'Rancher AI UI',
    repo:         'rancher/rancher-ai-ui',
    fork:         'marcelofukumoto/rancher-ai-ui',
    prTarget:     'marcelofukumoto/rancher-ai-ui',
    ownerPackage: '@rancher/shell',
  },
];

export function boardById(id: string): Board {
  return BOARDS.find((b) => b.id === id) || BOARDS[0];
}

/** The Secret holding the GitHub token, and the key inside it. */
export const SECRET_NAME = 'settings';
export const GH_TOKEN_KEY = 'gh_token';

/**
 * Extension Studio keeps an account's GitHub token under this exact name. Ours is preferred -
 * setting one here is somebody choosing it for this extension - and theirs is the fallback, so
 * nobody has to keep two copies of one token in step.
 */
export const STUDIO_NAMESPACE = 'extension-studio';
export const STUDIO_SECRET = 'settings';

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
