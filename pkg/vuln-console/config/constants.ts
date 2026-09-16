// Every name this extension uses to find something in the cluster, in one place.
//
// The console it replaces had these spread across a 710-line watcher, a Python server and an
// HTML file, which is how `static-preview` ended up hardcoded in three of them and the PVC in
// `pvc.yaml` drifted away from the `emptyDir` the Deployment actually mounted. A constant that
// is read from one place cannot drift from itself.

/** Where this extension keeps its own state. Created on first use. */
export const NAMESPACE = 'vuln-console';

/** The repository whose Dependabot alerts the board shows. */
export const UPSTREAM_REPO = 'rancher/dashboard';

/**
 * The fork fixes are pushed to, and - for now - the repository pull requests are opened
 * against. Pointing both at the fork is deliberate: branches and PRs are made here first so a
 * mistake costs nothing, and only the `prTarget` moves to `rancher/dashboard` later.
 */
export const FORK_REPO = 'marcelofukumoto/dashboard';
export const PR_TARGET_REPO = FORK_REPO;

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

/** ConfigMap names and the label that marks the ones this extension owns. */
export const OWNER_LABEL = 'vuln-console.rancher.io/owns';
export const SNAPSHOT_CONFIGMAP = 'snapshot';
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
