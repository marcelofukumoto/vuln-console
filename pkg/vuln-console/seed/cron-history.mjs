#!/usr/bin/env node
// The scheduled rebuild of "alerts over time".
//
// Daily, not half-hourly like the boards. The series is bucketed by week, so a finer schedule
// would redraw the same picture while spending a full alert pull on every repository - about
// forty API calls - for a number that cannot have moved.
//
// Same shape as cron-gather.mjs: the pod's own ServiceAccount reads the shared token, the
// reconstruction runs as a child process so the scheduled path and a hand-run cannot drift,
// and the result is server-side applied. See that file for why SSA rather than apply.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const API = 'https://kubernetes.default.svc';
const SA = '/var/run/secrets/kubernetes.io/serviceaccount';
const TOKEN = readFileSync(`${ SA }/token`, 'utf8').trim();
const NS = process.env.VULN_NAMESPACE || 'vuln-console';
const SETTINGS_NS = process.env.SETTINGS_NAMESPACE || 'ui-internal-tools';
const SECRET = process.env.SETTINGS_SECRET || 'settings';
const REPOS = process.env.REPOS || '[]';

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

const secret = await api(`/api/v1/namespaces/${ SETTINGS_NS }/secrets/${ SECRET }`);
const gh = secret.data?.gh_token;

if (!gh) {
  throw new Error(`no gh_token in ${ SETTINGS_NS }/${ SECRET } - set it in the console's Credentials dialog`);
}

const creds = '/tmp/creds.json';
const out = '/tmp/history.json';

writeFileSync(creds, JSON.stringify({ GH_TOKEN: Buffer.from(gh, 'base64').toString('utf8') }), { mode: 0o600 });

execFileSync(process.execPath, ['/seed/history.mjs'], {
  stdio: ['ignore', 'inherit', 'inherit'],
  env:   {
    ...process.env, CREDS_FILE: creds, OUT: out, REPOS,
  },
  timeout: 20 * 60 * 1000,
});

const history = readFileSync(out, 'utf8');

// A ConfigMap holds a megabyte, and this one grows by a bucket a week. Failing loudly here
// beats an apiserver rejection nobody reads - and beats silently keeping a stale series.
if (history.length > 950000) {
  throw new Error(`the history is ${ Math.round(history.length / 1024) } KiB, over what a ConfigMap can hold`);
}

await api(
  `/api/v1/namespaces/${ NS }/configmaps/dependabot-history?fieldManager=vuln-console-history&force=true`,
  {
    method:      'PATCH',
    contentType: 'application/apply-patch+yaml',
    body:        JSON.stringify({
      apiVersion: 'v1',
      kind:       'ConfigMap',
      metadata:   {
        name:      'dependabot-history',
        namespace: NS,
        labels:    { 'vuln-console.rancher.io/owns': 'true', 'vuln-console.rancher.io/kind': 'history' },
      },
      data: { 'history.json': history },
    }),
  },
);

process.stdout.write(`cron-history: published ${ Math.round(history.length / 1024) } KiB\n`);
