// Where the board's state lives: ConfigMaps in the cluster.
//
// The console this replaces kept everything in one pod's `/data`, mounted as an emptyDir, so a
// pod rollout wiped the lot and the watcher had to re-gather to repopulate it. Worse, the
// manifest in git declared an emptyDir while the running Deployment had been hand-patched onto
// a PVC, so the file and the cluster had quietly disagreed for weeks. Everything here is a
// Kubernetes object: it survives the agent pod, the extension and a Rancher restart, and every
// admin sees the same board.
//
// Three kinds of object, found by LABEL rather than by name pattern, so nothing here guesses at
// what a ConfigMap is from what it is called:
//
//   snapshot-<board>       one per board, the last gather. Rewritten whole each time.
//   job-<board>-<library>  one per library worked on, per board. Small, and written by whoever
//                          is acting - separate objects so two runs never write the same object
//                          and lose each other's fields.
//   reviewers              one object, the logins to request on every pull request we open.
//
// Everything except the reviewers is keyed by BOARD as well as by name, and carries the board
// as a label. Two boards fixing a library with the same name - which is the normal case, since
// both repositories are npm projects - must never read as one.
import {
  BOARD_LABEL, JOB_PREFIX, NAMESPACE, OWNER_LABEL, REVIEWERS_CONFIGMAP, SNAPSHOT_PREFIX,
} from '../config/constants';
import { STEVE_BASE, rancherFetch } from './rancher';
import type { Job, Reviewers, Snapshot } from '../types';

function steve(path: string, init?: RequestInit): Promise<any> {
  return rancherFetch(`${ STEVE_BASE }${ path }`, init);
}

/**
 * The namespace, made on the way past.
 *
 * Every user of this extension is a Rancher admin - that is the premise the whole thing is
 * built on - so the first person to open the page is somebody who can make it. A 409 is two
 * tabs doing it at once, which is the outcome both wanted.
 */
export async function ensureNamespace(): Promise<void> {
  const existing = await steve(`/namespaces/${ NAMESPACE }`).catch(() => null);

  if (existing) {
    return;
  }

  await steve('/namespaces', {
    method: 'POST',
    body:   JSON.stringify({
      apiVersion: 'v1',
      kind:       'Namespace',
      metadata:   { name: NAMESPACE },
    }),
  }).catch((e: any) => {
    if (!/409|already exists|alreadyexists/i.test(e?.message || '')) {
      throw e;
    }
  });
}

function configMapPath(name: string): string {
  return `/configmaps/${ NAMESPACE }/${ name }`;
}

/**
 * Write a ConfigMap whether or not it is there.
 *
 * Steve has no upsert, and the two cases are a POST to the collection and a PUT to the object,
 * so this is the one place that difference is handled. A create that races another tab answers
 * 409 and is retried as an update, because both tabs wanted the object to exist with their
 * content and the later write is the one to keep.
 */
async function writeConfigMap(name: string, data: Record<string, string>, labels: Record<string, string>): Promise<void> {
  const body = {
    apiVersion: 'v1',
    kind:       'ConfigMap',
    metadata:   { name, namespace: NAMESPACE, labels: { [OWNER_LABEL]: 'true', ...labels } },
    data,
  };
  const existing = await steve(configMapPath(name)).catch(() => null);

  if (existing) {
    await steve(configMapPath(name), {
      method: 'PUT',
      body:   JSON.stringify({ ...body, metadata: { ...existing.metadata, labels: body.metadata.labels } }),
    });

    return;
  }

  await steve(`/configmaps`, { method: 'POST', body: JSON.stringify(body) })
    .catch(async(e: any) => {
      if (!/409|already exists|alreadyexists/i.test(e?.message || '')) {
        throw e;
      }

      const now = await steve(configMapPath(name));

      await steve(configMapPath(name), {
        method: 'PUT',
        body:   JSON.stringify({ ...body, metadata: { ...now.metadata, labels: body.metadata.labels } }),
      });
    });
}

async function readJson<T>(name: string, key: string): Promise<T | null> {
  const object = await steve(configMapPath(name)).catch(() => null);
  const raw = object?.data?.[key];

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// ── The gather ─────────────────────────────────────────────────────────────────────────────

export function snapshotName(board: string): string {
  return `${ SNAPSHOT_PREFIX }${ board }`;
}

export function readSnapshot(board: string): Promise<Snapshot | null> {
  return readJson<Snapshot>(snapshotName(board), 'snapshot.json');
}

/**
 * Store a gather, refusing one that would blank the board.
 *
 * This guard exists because the board went blank for a whole day once: a rate-limited page made
 * the gather write a valid, empty, zero-alert file, and the watcher reused it every hour until
 * the date rolled over. The gather script has its own version of this check; having it on both
 * sides of the wire means neither a broken script nor a broken caller can erase a good
 * snapshot.
 */
export async function writeSnapshot(board: string, snapshot: Snapshot): Promise<void> {
  if (!snapshot?.alerts?.length) {
    throw new Error('refusing to store a gather with no alerts in it - the previous one is kept');
  }

  await ensureNamespace();
  await writeConfigMap(
    snapshotName(board),
    { 'snapshot.json': JSON.stringify(snapshot) },
    { [BOARD_LABEL]: board },
  );
}

// ── Jobs ───────────────────────────────────────────────────────────────────────────────────

/**
 * A library name as a ConfigMap name.
 *
 * Package names carry characters an object name may not: `@scope/name` is the common one, and a
 * dot is legal in both but leads with a different meaning. The mapping has to be reversible
 * only in the sense that the job carries its own `library` field - the name is an address, not
 * the record.
 */
/**
 * A phase the board does not know means the run is still going.
 *
 * Jobs are written by an agent, and an agent can invent a value - one wrote `Recording` for
 * "still recording". Treating that as finished is the dangerous reading: the row shows its
 * buttons again and somebody starts a second run on top of the first. Treating it as in flight
 * is merely conservative, and `stage` carries the detail anyway. job.sh rejects them at the
 * source; this is the belt to that brace, for anything already written.
 */
const PHASES = ['Running', 'Fixed', 'Done', 'Failed', 'Cancelled'];

function normalisePhase(job: Job): Job {
  return PHASES.includes(job.phase) ? job : { ...job, phase: 'Running' };
}

export function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function jobName(board: string, library: string): string {
  return `${ JOB_PREFIX }${ board }-${ slug(library).slice(0, 40) || 'unnamed' }`;
}

export async function readJobs(board: string): Promise<Job[]> {
  const selector = `${ OWNER_LABEL }=true,${ BOARD_LABEL }=${ board }`;
  const list = await steve(`/configmaps?labelSelector=${ encodeURIComponent(selector) }`)
    .catch(() => null);

  return (list?.data || [])
    .filter((cm: any) => (cm?.metadata?.name || '').startsWith(JOB_PREFIX))
    .map((cm: any) => {
      try {
        return JSON.parse(cm.data?.['job.json'] || 'null');
      } catch {
        return null;
      }
    })
    .filter((job: Job | null): job is Job => !!job?.library)
    .map(normalisePhase);
}

export async function writeJob(job: Job): Promise<void> {
  await ensureNamespace();
  await writeConfigMap(
    jobName(job.board, job.library),
    { 'job.json': JSON.stringify(job) },
    { [BOARD_LABEL]: job.board },
  );
}

export async function deleteJob(board: string, library: string): Promise<void> {
  await steve(configMapPath(jobName(board, library)), { method: 'DELETE' }).catch(() => null);
}

// ── Reviewers ──────────────────────────────────────────────────────────────────────────────

export async function readReviewers(): Promise<Reviewers> {
  const stored = await readJson<Reviewers>(REVIEWERS_CONFIGMAP, 'reviewers.json');

  return { selected: stored?.selected || [], candidates: stored?.candidates || [] };
}

export async function writeReviewers(reviewers: Reviewers): Promise<void> {
  await ensureNamespace();
  await writeConfigMap(REVIEWERS_CONFIGMAP, { 'reviewers.json': JSON.stringify(reviewers) }, {});
}
