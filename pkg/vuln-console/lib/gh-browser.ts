// The user's own GitHub browser.
//
// Uploading a video to a pull request is a browser flow - there is no API for `user-attachments`
// - so something has to hold a github.com session. The two obvious answers are both bad: a
// session cookie stored in a Secret is full account access sitting where every admin can read
// it, and one shared browser signed in by whoever got there first makes everybody's uploads that
// person's, with a logged-in account anyone on this Rancher can open and click around in.
//
// So: a browser per person, spawned by them, signed in by them. Nothing is stored - the session
// lives in that browser's own profile and never leaves the cluster - and it is theirs, so an
// upload is genuinely done by the person who pressed the button. It is Extension Studio's shared
// browser, made singular.
//
// Setting one up is optional. Without it everything still works except the automatic attachment,
// and the console says so rather than failing: the recording is made and staged, and it is put
// on the pull request by hand.
//
// These objects are built here rather than in `yaml/`, unlike the workspace's. That directory is
// apps-plus templates, rendered by Fleet; these are created directly through Steve, which is the
// same split the agents and Extension Studio extensions make for the same reason.
import { NAMESPACE, BROWSER_CDP_PORT, BROWSER_PORT } from '../config/constants';
import { STEVE_BASE, rancherFetch } from './rancher';
import { userDnsSlug } from './credentials';
import { SEED_FILES } from '../seed.generated';

const SERVICES_CONFIGMAP = 'gh-browser-services';
const OWNER_LABEL = 'vuln-console.rancher.io/gh-browser';

/** Where one person's browser lives. One object name, derived from their principal. */
export function ghBrowserName(principalId: string): string {
  return `gh-browser-${ userDnsSlug(principalId) }`.slice(0, 63).replace(/-+$/, '');
}

/**
 * Its web UI, framed through the apiserver's service proxy.
 *
 * On Rancher's own origin, so the person's existing Rancher session authenticates it and there
 * is no second hostname or certificate involved. This is the link they click to sign in.
 */
export function ghBrowserUrl(principalId: string): string {
  const name = ghBrowserName(principalId);

  return `/k8s/clusters/local/api/v1/namespaces/${ NAMESPACE }/services/http:${ name }:${ BROWSER_PORT }/proxy/`;
}

/** Its CDP endpoint, as reached from inside the cluster by whatever does the upload. */
export function ghBrowserCdp(principalId: string): string {
  const name = ghBrowserName(principalId);

  return `http://${ name }.${ NAMESPACE }.svc.cluster.local:${ BROWSER_CDP_PORT }`;
}

function steve(path: string, init?: RequestInit): Promise<any> {
  return rancherFetch(`${ STEVE_BASE }${ path }`, init);
}

async function createIfAbsent(type: string, name: string, body: () => Record<string, unknown>): Promise<void> {
  const existing = await steve(`/${ type }/${ NAMESPACE }/${ name }`).catch(() => null);

  if (existing) {
    return;
  }

  await steve(`/${ type }`, { method: 'POST', body: JSON.stringify(body()) })
    .catch((e: any) => {
      if (!/409|already exists|alreadyexists/i.test(e?.message || '')) {
        throw e;
      }
    });
}

function servicesBody(): Record<string, unknown> {
  const script = SEED_FILES['gh-browser/cdp-proxy'];

  if (!script) {
    throw new Error('This build is missing the cdp-proxy service - run "yarn gen-seed" and rebuild.');
  }

  return {
    apiVersion: 'v1',
    kind:       'ConfigMap',
    metadata:   { name: SERVICES_CONFIGMAP, namespace: NAMESPACE },
    data:       { 'cdp-proxy': script },
  };
}

function deploymentBody(principalId: string): Record<string, unknown> {
  const name = ghBrowserName(principalId);

  return {
    apiVersion: 'apps/v1',
    kind:       'Deployment',
    metadata:   {
      name, namespace: NAMESPACE, labels: { [OWNER_LABEL]: userDnsSlug(principalId) },
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { [OWNER_LABEL]: userDnsSlug(principalId) } },
      // Recreate, not RollingUpdate: two Chromiums sharing one profile directory is a browser
      // that will not start, and the second one wins the race often enough to look intermittent.
      strategy: { type: 'Recreate' },
      template: {
        metadata: { labels: { [OWNER_LABEL]: userDnsSlug(principalId) } },
        spec:     {
          containers: [{
            name:  'browser',
            image: 'lscr.io/linuxserver/chromium:latest',
            ports: [
              { name: 'http', containerPort: BROWSER_PORT },
              { name: 'cdp', containerPort: BROWSER_CDP_PORT },
            ],
            env: [
              // The image runs as this user and writes its profile as it. A root-owned profile
              // in a container that then drops privileges is a browser that cannot start twice.
              { name: 'PUID', value: '1000' },
              { name: 'PGID', value: '1000' },
              { name: 'CUSTOM_PORT', value: `${ BROWSER_PORT }` },
              { name: 'TITLE', value: 'GitHub (vulnerability console)' },
              {
                name: 'CHROME_CLI',
                // Opens on the sign-in page, because signing in is the only reason this exists.
                //
                // --remote-allow-origins is the flag that is easy to miss: recent Chromium
                // refuses a CDP websocket whose Origin it does not know, which reads as a driver
                // that connects and then hangs. The backgrounding flags are not cosmetic either
                // - Chromium throttles a renderer nobody is looking at, and a driven browser is
                // exactly that, so without them a screenshot answers slowly or not at all.
                value: 'https://github.com/login --no-first-run --start-maximized --disable-infobars'
                  + ' --disable-session-crashed-bubble --hide-crash-restore-bubble'
                  + ' --disable-backgrounding-occluded-windows --disable-renderer-backgrounding'
                  + ' --disable-background-timer-throttling --remote-debugging-port='
                  + `${ BROWSER_CDP_PORT } --remote-allow-origins=*`,
              },
            ],
            volumeMounts: [
              { name: 'dshm', mountPath: '/dev/shm' },
              // The profile, and the whole point of it: this is where the GitHub session lives.
              // Extension Studio's shared browser does NOT persist this, which is why its own
              // comments say replacing that pod throws the login away. A person signing in ought
              // to stay signed in across a node reboot.
              { name: 'profile', mountPath: '/config' },
              // One mount per file with subPath: /custom-services.d holds one executable per
              // service, not a directory.
              {
                name: 'services', mountPath: '/custom-services.d/cdp-proxy', subPath: 'cdp-proxy', readOnly: true,
              },
            ],
            // Ready when CDP answers, not when the container starts: the web UI comes up before
            // Chromium does, so probing the UI port would say ready to a driver that then gets
            // connection refused.
            readinessProbe: { httpGet: { path: '/json/version', port: BROWSER_CDP_PORT }, periodSeconds: 10 },
            resources:      {
              requests: { cpu: '50m', memory: '512Mi' },
              limits:   { cpu: '1', memory: '2Gi' },
            },
          }],
          volumes: [
            // A container gets 64 MiB of shared memory by default and Chromium's renderers pass
            // their surfaces through it; below about a gigabyte a page with a dashboard in it
            // dies as "Aw, Snap" rather than rendering slowly.
            { name: 'dshm', emptyDir: { medium: 'Memory', sizeLimit: '1Gi' } },
            {
              name:     'profile',
              hostPath: { path: `/var/lib/rancher/vuln-console-browsers/${ userDnsSlug(principalId) }`, type: 'DirectoryOrCreate' },
            },
            // 0555: the image execs these, so they have to arrive executable.
            { name: 'services', configMap: { name: SERVICES_CONFIGMAP, defaultMode: 0o555 } },
          ],
        },
      },
    },
  };
}

function serviceBody(principalId: string): Record<string, unknown> {
  const name = ghBrowserName(principalId);

  return {
    apiVersion: 'v1',
    kind:       'Service',
    metadata:   { name, namespace: NAMESPACE },
    spec:       {
      selector: { [OWNER_LABEL]: userDnsSlug(principalId) },
      ports:    [
        { name: 'http', port: BROWSER_PORT, targetPort: 'http' },
        { name: 'cdp', port: BROWSER_CDP_PORT, targetPort: 'cdp' },
      ],
    },
  };
}

export type GhBrowserState = 'absent' | 'starting' | 'ready';

export interface GhBrowserStatus {
  state: GhBrowserState;
  /** Where to click to sign in. */
  url: string;
}

export async function ghBrowserStatus(principalId: string): Promise<GhBrowserStatus> {
  const name = ghBrowserName(principalId);
  const url = ghBrowserUrl(principalId);
  const deployment = await steve(`/apps.deployments/${ NAMESPACE }/${ name }`).catch(() => null);

  if (!deployment) {
    return { state: 'absent', url };
  }

  // Ready means CDP answers, which is what the readiness probe checks - so this is the same
  // question the uploader will ask, rather than a proxy for it.
  const ready = Number(deployment.status?.readyReplicas || 0) > 0;

  return { state: ready ? 'ready' : 'starting', url };
}

/**
 * Spawn this person's browser.
 *
 * Create-if-absent throughout: pressing the button twice is one browser, and somebody else's
 * browser is never touched.
 */
export async function ensureGhBrowser(principalId: string): Promise<GhBrowserStatus> {
  await createIfAbsent('configmaps', SERVICES_CONFIGMAP, servicesBody);
  await createIfAbsent('apps.deployments', ghBrowserName(principalId), () => deploymentBody(principalId));
  await createIfAbsent('services', ghBrowserName(principalId), () => serviceBody(principalId));

  return ghBrowserStatus(principalId);
}

/** Remove it. The profile on the node goes with the pod's hostPath only if somebody clears it. */
export async function deleteGhBrowser(principalId: string): Promise<void> {
  const name = ghBrowserName(principalId);

  await steve(`/apps.deployments/${ NAMESPACE }/${ name }`, { method: 'DELETE' }).catch(() => null);
  await steve(`/services/${ NAMESPACE }/${ name }`, { method: 'DELETE' }).catch(() => null);
}
