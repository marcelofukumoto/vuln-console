#!/usr/bin/env node
// Log the browser in to the Rancher this workspace talks to, without typing a password.
//
// Taken from the Dev extension's agent seed. The only change is where the .env lives: this
// extension's workspaces are at /workspaces/<name>, not /workspace, so the path comes from $WSD
// (which the shell wrapper exports for every command) instead of being fixed.
//
// There is no local admin account to type here: the Rancher is a shared one that people sign
// in to with GitHub, and what this workspace has is a token for the person who made it
// (RANCHER_TOKEN in /workspace/.env). Rancher's session is a cookie carrying that token, so
// setting the cookie is the login. Set for the Rancher's own origin and for the dev server on
// localhost:8005, which proxies the API to it and expects the same cookie.
//
//   node /workspace/bin/rancher-login.mjs            # both origins
//   node /workspace/bin/rancher-login.mjs --check    # say who the token is
import { chromium } from 'playwright-core';

import fs from 'node:fs';

// The secrets live in /workspace/.env rather than in the process environment (see
// the workspace's .env); read them from there when the shell did not.
const env = { ...process.env };

try {
  for (const line of fs.readFileSync(`${ process.env.WSD || '/workspace' }/.env`, 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line);

    if (m && !env[m[1]]) {
      env[m[1]] = m[2];
    }
  }
} catch { /* no .env: the variables have to be in the environment then */ }

const token = env.RANCHER_TOKEN || '';
const rancher = env.RANCHER_URL || env.API || '';
const cdp = env.CLAUDE_BROWSER_CDP || 'http://localhost:9222';

if (!token || !rancher) {
  console.error('rancher-login: RANCHER_TOKEN and RANCHER_URL are needed; source /workspace/.env first (set -a; . /workspace/.env; set +a)');
  process.exit(2);
}

if (process.argv.includes('--check')) {
  const r = await fetch(`${ rancher }/v3/users?me=true`, { headers: { Authorization: `Bearer ${ token }` } }).catch(() => null);
  const body = r && r.ok ? await r.json() : null;

  console.log(body?.data?.[0]?.username || body?.data?.[0]?.name ? `token is ${ body.data[0].username || body.data[0].name }` : `token did not answer (${ r ? r.status : 'no response' })`);
  process.exit(0);
}

const browser = await chromium.connectOverCDP(cdp);
const context = browser.contexts()[0] || await browser.newContext();
const host = new URL(rancher).host;
const cookies = [];

for (const [domain, secure] of [[host.split(':')[0], true], ['localhost', true], ['localhost', false]]) {
  cookies.push({ name: 'R_SESS', value: token, domain, path: '/', httpOnly: false, secure, sameSite: 'Lax' });
}
await context.addCookies(cookies);
console.log(`R_SESS set for ${ host } and localhost - the browser is signed in as the token's user`);
await browser.close();
