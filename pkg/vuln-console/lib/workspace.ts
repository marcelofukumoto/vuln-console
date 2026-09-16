// The place a fix happens: a rancher/dashboard checkout with a dev server and a browser, made
// for one library and thrown away afterwards.
//
// It is an apps-plus App, not a set of manifests this file POSTs, and that is a deliberate
// choice with one sharp edge worth stating plainly:
//
//   apps-plus has NO CONTROLLER. Its CRDs are inert. An `AppInstance` is turned into a Fleet
//   Bundle by a method on the Vuex model - `reconcile()` - which runs in the browser, and
//   Fleet's controllers do the rest. So `kubectl apply -f appinstance.yaml` deploys precisely
//   nothing, and an instance created with a raw POST is a record with nothing behind it.
//
// Everything here therefore goes through `management/create` and `save()`. That is fine for
// this extension because this extension IS the browser; it would not be fine for the agent, so
// the agent is never asked to make one.
//
// What apps-plus buys in return: the workspace is described as data, editable in the dashboard
// by somebody who is not us, deployed by Fleet with real reconciliation and real teardown, and
// it is the same App shape the dev extension already uses - so the two are recognisably the
// same kind of thing rather than two inventions.
import { BROWSER_PORT, WORKSPACE_APP, WORKSPACE_PORT } from '../config/constants';
import type { Board } from '../config/constants';
import { MANIFESTS } from '../yaml.generated';

const APP_TYPE = 'appsplus.io.app';
const APP_INSTANCE_TYPE = 'appsplus.io.appinstance';

/** The labels that say which library and which board a workspace belongs to. */
export const LABEL_LIBRARY = 'vuln-console.rancher.io/library';
export const LABEL_BOARD = 'vuln-console.rancher.io/board';

/** A minimal view of the Vuex store, so this file does not depend on the dashboard's types. */
export interface Store {
  dispatch(action: string, payload?: any, options?: any): Promise<any>;
  getters: Record<string, any>;
}

/**
 * Whether apps-plus is here AND usable.
 *
 * Both schemas, not just one: a workspace needs an App to exist and an AppInstance made from it,
 * and a store that knows one type and not the other fails at `save()` rather than at the check.
 */
export function appsPlusInstalled(store: Store): boolean {
  const schemaFor = store.getters['management/schemaFor'];

  return !!schemaFor?.(APP_TYPE) && !!schemaFor?.(APP_INSTANCE_TYPE);
}

/**
 * A library name as a workspace name.
 *
 * It becomes a Kubernetes object name, a namespace and a directory on the node, so it has to be
 * a DNS label - and `@scope/name` is neither. The job carries the real library name; this is
 * only an address.
 */
export function workspaceName(board: string, library: string): string {
  const slug = library
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);

  return `vuln-${ board }-${ slug || 'fix' }`;
}

/**
 * The App, as the YAML files in `yaml/workspace/` say it is.
 *
 * The templates are real files that a human can read and a linter can check, packed into the
 * bundle by `yarn gen-seed` - not a string array assembled here. apps-plus substitutes
 * `${value}` for the values below when it renders, and leaves everything else byte for byte,
 * which is what lets a ConfigMap full of shell survive the trip.
 */
export function workspaceApp(): Record<string, any> {
  const templates = Object.keys(MANIFESTS)
    .filter((name) => name.startsWith('workspace/'))
    .sort()
    .map((name) => ({ name: name.replace('workspace/', ''), content: MANIFESTS[name] }));

  return {
    // `type` is what the dashboard store dispatches on, and without it `save()` cannot find a
    // schema and throws "insufficient permissions or resource type not found" - with the type it
    // was looking for printed as `undefined`, which is the tell. apiVersion and kind are for the
    // apiserver; `type` is for the store, and both are needed.
    type:       APP_TYPE,
    apiVersion: 'appsplus.io/v1alpha1',
    kind:       'App',
    metadata:   { name: WORKSPACE_APP },
    spec:       {
      description: 'A rancher/dashboard checkout with its dependencies installed, the dev server running, and a browser beside it — where one Dependabot fix is made and verified. The first start is minutes: a clone, a yarn install and a first compile.',
      // `port` is a number on purpose. apps-plus emits a declared number bare and a declared
      // string quoted, and a Service port that arrives as "8005" is one the apiserver refuses.
      // The repository and the fork are DEFAULTS here and are overridden per installation: one
      // App describes what a fix workspace is, and each board's installations point it at their
      // own repository. Adding a board does not add an App.
      values:      {
        repo:         'rancher/dashboard',
        fork:         'marcelofukumoto/dashboard',
        port:         WORKSPACE_PORT,
        // The dashboard's dev server serves TLS from its own config, so the service proxy has
        // to be told to speak it too - otherwise every "is it up yet" is a 503.
        scheme:       'https',
        image:        'node:24',
        hostCluster:  'local',
        // `$(NODE_IP)` is expanded by Kubernetes in the pod's environment, not by apps-plus:
        // this cluster is k3s inside the Rancher container, so the node's address is how the
        // dev server reaches the Rancher it belongs to.
        rancherUrl:   'https://$(NODE_IP)',
        a11yPackages: 'at-spi2-core|dbus-x11|gir1.2-atspi-2.0|python3-gi|python3-pyatspi',
      },
      valueLabels: {
        repo:         'Repository the fix is made against',
        fork:         'Fork the branch is pushed to',
        port:         'Port the dev server listens on',
        scheme:       'http or https',
        image:        'Container image',
        hostCluster:  'Cluster the workspace runs on',
        rancherUrl:   'Rancher the dev server points at',
        a11yPackages: 'What the browser installs (pipe separated)',
      },
      templates,
    },
  };
}

/**
 * The App, created or brought up to date.
 *
 * Written every time the board loads rather than once, because the templates travel inside this
 * bundle: an extension upgrade that changes a workspace script must reach the App, or the next
 * fix runs last version's workspace. apps-plus redeploys the instances of an App when the App
 * is saved, which is the behaviour wanted here.
 */
export async function ensureWorkspaceApp(store: Store): Promise<void> {
  const desired = workspaceApp();
  const existing = await store.dispatch('management/find', { type: APP_TYPE, id: WORKSPACE_APP })
    .catch(() => null);

  if (!existing) {
    const app = await store.dispatch('management/create', desired);

    await app.save();

    return;
  }

  if (JSON.stringify(existing.spec?.templates) === JSON.stringify(desired.spec.templates)) {
    return;
  }

  existing.spec = { ...existing.spec, ...desired.spec };
  await existing.save();
}

/**
 * The workspace for one library, created if it is not there.
 *
 * Reattaching rather than replacing is the point: a second Fix on the same library while the
 * first is still in flight must find the same checkout, not start a second one beside it. The
 * console this replaces had no such notion and could put two agents on ONE shared checkout,
 * where they clobbered each other's lockfile work.
 */
export async function ensureWorkspace(
  store: Store,
  board: Board,
  /**
   * The fork, already resolved.
   *
   * Passed in rather than read off the board, because the board no longer carries one: it is
   * derived from whoever's token is stored. Reading `board.fork` here got `undefined`, apps-plus
   * fell back to the App's DEFAULT value, and a rancher-ai-ui workspace came up with its `fork`
   * remote pointing at the dashboard fork - which would have pushed a rancher-ai-ui branch into
   * the wrong repository.
   */
  fork: string,
  library: string,
): Promise<string> {
  const name = workspaceName(board.id, library);
  const existing = await store.dispatch('management/find', { type: APP_INSTANCE_TYPE, id: name })
    .catch(() => null);

  if (existing) {
    return name;
  }

  await ensureWorkspaceApp(store);

  const instance = await store.dispatch('management/create', {
    type:     APP_INSTANCE_TYPE,
    metadata: {
      name,
      labels: {
        [LABEL_LIBRARY]: library.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 63),
        [LABEL_BOARD]:   board.id,
      },
    },
    spec:     {
      app:              WORKSPACE_APP,
      namespace:        name,
      targets:          [{ clusterName: 'local' }],
      values:           { repo: board.repo, fork },
      provisionCluster: { enabled: false },
    },
  });

  // save(), not a POST. This is what runs apps-plus's reconcile and writes the Fleet Bundle;
  // without it the object exists and nothing is deployed.
  await instance.save();

  return name;
}

/**
 * Where a workspace's dev server is reached.
 *
 * Through the Kubernetes apiserver's service proxy, on Rancher's own origin - so there is no
 * Ingress, no hostname to pick and no certificate to wait for, and the browser's existing
 * Rancher session authenticates it. The old console deployed an nginx per branch behind a
 * sslip.io hostname and a Let's Encrypt certificate, and spent real time on previews that were
 * 502 because a network policy or an expiring certificate got in the way.
 */
export function workspaceUrl(name: string, port: number = WORKSPACE_PORT, scheme = 'https'): string {
  return `/k8s/clusters/local/api/v1/namespaces/${ name }/services/${ scheme }:${ name }:${ port }/proxy/`;
}

/** Where the workspace's own browser is framed. */
export function workspaceBrowserUrl(name: string): string {
  return workspaceUrl(name, BROWSER_PORT, 'http');
}

/** Whether the workspace's pod is up and its dev server is answering. */
export async function workspaceServing(name: string): Promise<boolean> {
  const resp = await fetch(workspaceUrl(name), { method: 'GET', redirect: 'manual' }).catch(() => null);

  if (!resp) {
    return false;
  }

  // 502/503/504 is the proxy saying the pod is not there yet, which is the ordinary state for
  // the first several minutes of a workspace's life - not a failure to report.
  return resp.status < 500;
}

export async function deleteWorkspace(store: Store, board: string, library: string): Promise<void> {
  const name = workspaceName(board, library);
  const instance = await store.dispatch('management/find', { type: APP_INSTANCE_TYPE, id: name })
    .catch(() => null);

  if (instance) {
    await instance.remove();
  }
}
