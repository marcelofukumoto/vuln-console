#!/usr/bin/env node
// Put a screenshot or a recording on a GitHub pull request, as a user-attachment.
//
// There is no API for this. `user-attachments` is a browser flow - a CSRF token that only the
// classic comment box renders, a policy call, a POST to the bucket it names, then a confirm -
// so a token cannot do it and neither can `gh`. A release asset is not a substitute: it renders
// as a link, and the whole point of a verification video is that a reviewer can press play
// without leaving the diff.
//
// The page-side half is the Dev extension's (dev-api/server.mjs, UPLOAD_IN_PAGE), which is in
// turn the same flow its my-pr-create skill runs. Keep the three in step.
//
// WHICH BROWSER. Not this workspace's sidecar - that one is signed in to Rancher, not GitHub.
// The one holding a github.com session is the SHARED browser in extension-studio, which a
// person signs in once and which every extension here borrows. So this connects across the
// cluster to that one.
//
//   node gh-attach.mjs <file> <pull-request-url>
//   node gh-attach.mjs --check                    # say whether the shared browser is signed in
//
// It prints the https://github.com/user-attachments/assets/... URL and nothing else, so a
// caller can use `$(node gh-attach.mjs …)` directly.
import { chromium } from 'playwright-core';
import { lookup } from 'node:dns/promises';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const SHARED = process.env.GITHUB_BROWSER_CDP
  || 'http://browser.extension-studio.svc.cluster.local:9222';

/** GitHub rejects the policy call when the extension and the content type disagree. */
const TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
};

function fail(message) {
  process.stderr.write(`gh-attach: ${ message }\n`);
  process.exit(1);
}

/**
 * Chromium's CDP refuses a Host header that is not localhost or an IP - its anti DNS-rebinding
 * guard - and the shared browser is reached by service name. Resolving first is the whole fix;
 * without it every call comes back "Host header is specified and is not an IP address".
 */
async function endpoint() {
  const url = new URL(SHARED);

  if (url.hostname !== 'localhost' && !/^[0-9.]+$/.test(url.hostname)) {
    url.hostname = (await lookup(url.hostname)).address;
  }

  return url.origin;
}

/** The page-side half. Runs inside the shared browser, on the pull request's own page. */
const uploadInPage = async({ b64, name, ct }) => {
  const token = document.querySelector('input.js-data-upload-policy-url-csrf')?.value;

  if (!token) {
    throw new Error('no upload token on the page - the shared browser is not signed in to GitHub');
  }

  const repoId = document.querySelector('file-attachment[data-upload-repository-id]')
    ?.getAttribute('data-upload-repository-id')
    || document.querySelector('meta[name="octolytics-dimension-repository_id"]')?.content;
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const policyForm = new FormData();

  policyForm.append('name', name);
  policyForm.append('size', String(bytes.length));
  policyForm.append('content_type', ct);
  policyForm.append('repository_id', String(repoId));
  policyForm.append('authenticity_token', token);

  const policyResp = await fetch('/upload/policies/assets', {
    method: 'POST', headers: { Accept: 'application/json' }, body: policyForm,
  });

  if (!policyResp.ok) {
    throw new Error(`policy ${ policyResp.status }: ${ (await policyResp.text()).slice(0, 300) }`);
  }

  const policy = await policyResp.json();
  const form = new FormData();

  for (const [key, value] of Object.entries(policy.form)) {
    form.append(key, String(value));
  }

  form.append('file', new Blob([bytes], { type: ct }), name);

  const upload = await fetch(policy.upload_url, { method: 'POST', body: form, mode: 'cors' });

  if (!upload.ok) {
    throw new Error(`upload ${ upload.status }: ${ (await upload.text()).slice(0, 200) }`);
  }

  // Without the confirm the asset stays unconfirmed and its href 404s later - once the comment
  // carrying it is already public, which is the worst moment to find out.
  if (policy.asset_upload_url) {
    const body = new FormData();

    body.append('authenticity_token', policy.asset_upload_authenticity_token);

    const confirmed = await fetch(policy.asset_upload_url, {
      method: 'PUT', headers: { Accept: 'application/json' }, body,
    });

    if (!confirmed.ok) {
      throw new Error(`confirm ${ confirmed.status }`);
    }
  }

  return policy.asset.href;
};

async function main() {
  const args = process.argv.slice(2);
  const cdp = await endpoint().catch(() => fail(`cannot resolve ${ SHARED }`));
  const browser = await chromium.connectOverCDP(cdp)
    .catch(() => fail(`the shared browser is not reachable at ${ SHARED }`));
  const context = browser.contexts()[0];

  if (args[0] === '--check') {
    const page = await context.newPage();

    await page.goto('https://github.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });

    const who = await page.evaluate(() => document.querySelector('meta[name=user-login]')?.content || '');

    await page.close();
    await browser.close();

    if (!who) {
      process.stdout.write('not signed in\n');
      process.exit(3);
    }

    process.stdout.write(`signed in as ${ who }\n`);

    return;
  }

  const [file, prUrl] = args;

  if (!file || !prUrl) {
    fail('usage: gh-attach.mjs <file> <pull-request-url>   (or --check)');
  }

  const name = path.basename(file);
  const ct = TYPES[path.extname(name).toLowerCase()];

  if (!ct) {
    fail(`${ name } is not a type GitHub accepts as an attachment (${ Object.keys(TYPES).join(' ') })`);
  }

  const size = (await stat(file).catch(() => fail(`no such file: ${ file }`))).size;

  // 25 MB is GitHub's limit for a video; a longer recording has to be trimmed rather than
  // discovered to be too big after the upload has run.
  if (size > 25 * 1024 * 1024) {
    fail(`${ name } is ${ Math.round(size / 1024 / 1024) } MB; GitHub's limit is 25 MB. Trim or re-encode it.`);
  }

  const b64 = (await readFile(file)).toString('base64');
  const page = await context.newPage();

  try {
    await page.goto(prUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // The token only exists once the comment box has rendered, which is not at DOMContentLoaded
    // on a heavy pull request page.
    await page.waitForSelector('input.js-data-upload-policy-url-csrf', { timeout: 60000 })
      .catch(() => {
        throw new Error('the pull request page never rendered a comment box - the shared browser is probably not signed in to GitHub');
      });

    const href = await page.evaluate(uploadInPage, { b64, name, ct });

    process.stdout.write(`${ href }\n`);
  } finally {
    await page.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

main().catch((e) => fail(e?.message || String(e)));
