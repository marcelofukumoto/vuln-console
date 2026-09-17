#!/usr/bin/env node
// The scheduled gather: keep every board current without anybody opening the page.
//
// The board used to refresh only when somebody looked at it, so it was as stale as the last
// visit - a week away meant a week-old list, and a Fix offered for something already fixed.
// The console this replaces re-gathered hourly for exactly that reason, and lost the clock in
// the rewrite rather than on purpose.
//
// WHY THIS IS NOT gather.sh. That one runs inside the agents pod, which has kubectl and a
// cluster-admin ServiceAccount; a CronJob has neither and should not borrow them. So this
// talks to the apiserver directly with its own ServiceAccount and a token from the projected
// volume every pod already has - no kubectl in the image, nothing to install, and a stock
// `node` is enough.
//
// It reuses gather.mjs unchanged, as a child process. The gather is the part that must not
// drift between the scheduled run and the one a person triggers; running a copy of it here
// would be two implementations of the only thing that matters.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const API = 'https://kubernetes.default.svc';
const SA = '/var/run/secrets/kubernetes.io/serviceaccount';
const TOKEN = readFileSync(`${ SA }/token`, 'utf8').trim();
const NS = process.env.VULN_NAMESPACE || 'vuln-console';
const SETTINGS_NS = process.env.SETTINGS_NAMESPACE || 'ui-internal-tools';
const SECRET = process.env.SETTINGS_SECRET || 'settings';
const BOARDS = JSON.parse(process.env.BOARDS || '[]');

async function api(path, init = {}) {
  const resp = await fetch(`${ API }${ path }`, {
    ...init,
    headers: {
      Authorization:  `Bearer ${ TOKEN }`,
      'Content-Type': init.contentType || 'application/json',
      Accept:         'application/json',
      ...(init.headers || {}),
    },
  });

  if (!resp.ok) {
    throw new Error(`${ init.method || 'GET' } ${ path }: ${ resp.status } ${ (await resp.text()).slice(0, 200) }`);
  }

  return resp.json();
}

/** The shared GitHub token, read the same place every other part of this reads it. */
async function ghToken() {
  const secret = await api(`/api/v1/namespaces/${ SETTINGS_NS }/secrets/${ SECRET }`);
  const value = secret.data?.gh_token;

  if (!value) {
    throw new Error(`no gh_token in ${ SETTINGS_NS }/${ SECRET } - set it in the console's Credentials dialog`);
  }

  return Buffer.from(value, 'base64').toString('utf8');
}

/**
 * Server-side apply, for the reason gather.sh gives: a client-side apply records the whole
 * object in an annotation, annotations are capped at 256 KiB, and a snapshot worth having is
 * bigger than that.
 */
async function publish(board, snapshot) {
  const body = {
    apiVersion: 'v1',
    kind:       'ConfigMap',
    metadata:   {
      name:      `snapshot-${ board.id }`,
      namespace: NS,
      labels:    {
        'vuln-console.rancher.io/owns':  'true',
        'vuln-console.rancher.io/board': board.id,
      },
    },
    data: { 'snapshot.json': snapshot },
  };

  await api(
    `/api/v1/namespaces/${ NS }/configmaps/snapshot-${ board.id }?fieldManager=vuln-console-cron&force=true`,
    { method: 'PATCH', contentType: 'application/apply-patch+yaml', body: JSON.stringify(body) },
  );
}

const creds = '/tmp/creds.json';

writeFileSync(creds, JSON.stringify({ GH_TOKEN: await ghToken() }), { mode: 0o600 });

let failed = 0;

for (const board of BOARDS) {
  const out = `/tmp/${ board.id }.json`;

  try {
    // Straight through gather.mjs, the same script a person's Refresh runs.
    execFileSync(process.execPath, ['/seed/gather.mjs'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env:   {
        ...process.env,
        CREDS_FILE:       creds,
        OUT:              out,
        VULN_REPO:        board.repo,
        RANCHER_PACKAGES: JSON.stringify(board.rancherPackages || []),
      },
      timeout: 10 * 60 * 1000,
    });

    const snapshot = readFileSync(out, 'utf8');

    // The same ceiling gather.sh enforces: a ConfigMap holds a megabyte, and a snapshot that
    // does not fit has to fail as something legible in the job's log rather than as an
    // apiserver rejection nobody reads.
    if (snapshot.length > 950000) {
      throw new Error(`the snapshot is ${ Math.round(snapshot.length / 1024) } KiB, over what a ConfigMap can hold`);
    }

    await publish(board, snapshot);
    process.stdout.write(`cron-gather: ${ board.id } published ${ Math.round(snapshot.length / 1024) } KiB\n`);
  } catch (e) {
    // One board failing is one board stale, not a failed run. gather.mjs already refuses to
    // write an empty snapshot, so the worst case here is the previous one staying up - which
    // is the behaviour that was wanted when a transient GitHub failure once blanked the board.
    failed++;
    process.stderr.write(`cron-gather: ${ board.id } FAILED - ${ String(e.message || e).slice(0, 300) }\n`);
  }
}

process.stdout.write(`cron-gather: ${ BOARDS.length - failed }/${ BOARDS.length } boards refreshed\n`);
process.exit(failed === BOARDS.length && BOARDS.length ? 1 : 0);
