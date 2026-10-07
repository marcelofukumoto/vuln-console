#!/usr/bin/env node
// Remove what finished runs leave behind: their workspaces, and node_modules templates nobody
// will use again.
//
// A workspace is a pod with a dev server and a browser - about 2.5 GiB of memory - plus its
// checkout on the node's disk, and nothing ever removed one. After a round of fixes six of them
// were idle on a single node; when k3s blipped they all restarted at once, each compiling the
// dashboard, and the load (33 on 8 cores) kept the Kubernetes API down until four were deleted.
// The disk ran out the same way twice.
//
// Run by the extension's own CronJob, so it works whether or not anybody has the board open.
// Deliberately narrow: it only ever touches workspaces this extension made (`vuln-…`), and only
// once their job has been finished for a while.
//
//   finished   the job is Done (pull request opened, or the fix stood down), Failed or Cancelled,
//              and has not been written to for GRACE minutes - time for its recording to be
//              attached and for somebody to carry on in the session. Not Fixed: Create pull
//              request follows that, in the same workspace.
//   orphaned   a checkout on disk whose workspace no longer exists.
//   stale      a node_modules template for a lockfile no workspace has any more - except the
//              newest, which is what the next fix will most likely want.
//
// A later action on a library (Address comments, Rebase, Re-record) builds a fresh workspace,
// exactly as a first Fix does.
import { readFileSync, readdirSync, rmSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const API = 'https://kubernetes.default.svc';
const SA = '/var/run/secrets/kubernetes.io/serviceaccount';
const TOKEN = readFileSync(`${ SA }/token`, 'utf8').trim();
const NS = process.env.VULN_NAMESPACE || 'vuln-console';
const ROOT = process.env.WORKSPACES_ROOT || '/workspaces';
const GRACE_MS = Number(process.env.GRACE_MINUTES || 30) * 60000;
const FINISHED = ['Done', 'Failed', 'Cancelled'];
const NAME_OK = /^vuln-[a-z0-9-]+$/;

// DRY_RUN=1 reports what would be removed and removes nothing.
const DRY = process.env.DRY_RUN === '1';
const remove = (path) => (DRY ? undefined : rmSync(path, { recursive: true, force: true }));

const log = (msg) => process.stdout.write(`janitor${ process.env.DRY_RUN === '1' ? ' (dry run)' : '' }: ${ msg }\n`);

async function api(path, init = {}) {
  const resp = await fetch(`${ API }${ path }`, {
    ...init,
    headers: { Authorization: `Bearer ${ TOKEN }`, Accept: 'application/json', ...(init.headers || {}) },
  });

  if (resp.status === 404) {
    return null;
  }
  if (!resp.ok) {
    throw new Error(`${ init.method || 'GET' } ${ path }: ${ resp.status } ${ (await resp.text()).slice(0, 200) }`);
  }

  return resp.json();
}

const now = Date.now();
const jobs = ((await api(`/api/v1/namespaces/${ NS }/configmaps?labelSelector=vuln-console.rancher.io%2Fowns%3Dtrue`))?.items || [])
  .filter((cm) => cm.metadata.name.startsWith('job-'))
  .map((cm) => {
    try {
      return JSON.parse(cm.data?.['job.json'] || '{}');
    } catch {
      return {};
    }
  });

const instances = new Set((((await api('/apis/appsplus.io/v1alpha1/appinstances'))?.items) || [])
  .map((i) => i.metadata.name)
  .filter((name) => NAME_OK.test(name)));

// Which workspaces some job still needs: anything not finished, or finished too recently.
const needed = new Set(jobs
  .filter((j) => j.workspace && !(FINISHED.includes(j.phase) && now - (j.updatedAt || now) > GRACE_MS))
  .map((j) => j.workspace));

// 1. Finished workspaces.
for (const job of jobs) {
  const ws = job.workspace;

  if (!ws || !NAME_OK.test(ws) || needed.has(ws) || !instances.has(ws)) {
    continue;
  }

  if (!DRY) {
    await api(`/apis/appsplus.io/v1alpha1/appinstances/${ ws }`, { method: 'DELETE' });
  }
  instances.delete(ws);
  log(`removed workspace ${ ws } (${ job.library }: ${ job.phase }, idle ${ Math.round((now - job.updatedAt) / 60000) } min)`);
}

// 2. Checkouts on disk with no workspace behind them - including the ones just removed. Their
// pods may still be terminating; the files go regardless, the directory is theirs alone.
for (const dir of existsSync(ROOT) ? readdirSync(ROOT) : []) {
  if (!NAME_OK.test(dir) || instances.has(dir) || needed.has(dir)) {
    continue;
  }

  remove(`${ ROOT }/${ dir }`);
  log(`removed checkout ${ dir }`);
}

// 3. Templates. Keep the ones a live workspace's lockfile maps to, and the newest of the rest.
const templates = `${ ROOT }/.shared/template`;

if (existsSync(templates)) {
  const live = new Set();

  for (const ws of instances) {
    try {
      live.add(createHash('sha1').update(readFileSync(`${ ROOT }/${ ws }/src/yarn.lock`)).digest('hex').slice(0, 12));
    } catch { /* no checkout yet */ }
  }

  const entries = readdirSync(templates).map((name) => ({ name, mtime: statSync(`${ templates }/${ name }`).mtimeMs }));
  const complete = entries.filter((e) => !e.name.startsWith('.')).sort((a, b) => b.mtime - a.mtime);
  const keep = new Set([...live, complete[0]?.name].filter(Boolean));

  for (const e of entries) {
    // A half-built template (".<hash>.<pid>") older than an hour belongs to an install that died.
    const abandoned = e.name.startsWith('.') && now - e.mtime > 3600000;

    if (abandoned || (!e.name.startsWith('.') && !keep.has(e.name))) {
      remove(`${ templates }/${ e.name }`);
      log(`removed template ${ e.name }`);
    }
  }
}

log(`done - ${ instances.size } workspace(s) left: ${ [...instances].join(', ') || 'none' }`);
