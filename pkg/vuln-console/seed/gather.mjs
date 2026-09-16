#!/usr/bin/env node
// Gather the Dependabot picture for one repository: every alert, Dependabot's own pull
// requests, and ours.
//
// Dependency-free and shell-free on purpose. This runs inside the agents pod, a stock
// `node:24` with neither `jq` nor `gh` in it, so the laptop pipeline it replaces
// (scripts/gather-vulnerabilities.sh, which is `gh api | jq` from end to end) is re-expressed
// in the one runtime the pod is guaranteed to have.
//
// It writes ALL alert states, not just the open ones. The board needs the closed ones to show
// what we shipped, and - more importantly - closing is the ONLY thing that moves a row out of
// the actionable list. A gather that dropped them would leave the board unable to tell "fixed"
// from "never seen".

import { readFileSync, writeFileSync } from 'node:fs';

const REPO = process.env.VULN_REPO || 'rancher/dashboard';
const FORK_OWNER = process.env.FORK_OWNER || 'marcelofukumoto';
const OUT = process.env.OUT || './snapshot.json';
const API = process.env.GITHUB_API || 'https://api.github.com';

function fail(message) {
  process.stderr.write(`gather: ${ message }\n`);
  process.exit(1);
}

/**
 * The token, read from a file rather than the environment.
 *
 * A pod is a place where `ps` and `/proc/<pid>/environ` are readable, and this one is shared:
 * every conversation in it runs as the same user. A token on a command line or in an exported
 * variable is a token every pane can read for as long as the process lives. The file is written
 * 0600, read once here, and removed when the run ends.
 */
function token() {
  const file = process.env.CREDS_FILE;

  if (!file) {
    return process.env.GH_TOKEN || '';
  }

  try {
    return JSON.parse(readFileSync(file, 'utf8')).GH_TOKEN || '';
  } catch (e) {
    fail(`could not read the credentials at ${ file }: ${ e?.message || e }`);
  }
}

const GH_TOKEN = token();

if (!GH_TOKEN) {
  fail('GH_TOKEN is not set. Dependabot alerts cannot be read without it.');
}

const HEADERS = {
  Authorization: `Bearer ${ GH_TOKEN }`,
  Accept:        'application/vnd.github+json',
  'User-Agent':  'vuln-console',
};

async function request(url, what) {
  let resp;

  try {
    resp = await fetch(url, { headers: HEADERS });
  } catch (e) {
    throw new Error(`${ what }: ${ e?.message || e }`, { cause: e });
  }

  const text = await resp.text();

  if (!resp.ok) {
    const detail = text.slice(0, 300).replace(/\s+/g, ' ').trim();

    throw new Error(`${ what }: HTTP ${ resp.status }${ detail ? ` - ${ detail }` : '' }`);
  }

  try {
    return { body: JSON.parse(text), link: resp.headers.get('link') || '' };
  } catch {
    throw new Error(`${ what }: the answer was not JSON`);
  }
}

/** Follow `Link: rel="next"` rather than counting pages - GitHub decides where the end is. */
async function paginate(url, what) {
  const all = [];
  let next = url;

  while (next) {
    const { body, link } = await request(next, what);

    if (!Array.isArray(body)) {
      throw new Error(`${ what }: expected a list, got ${ typeof body }`);
    }

    all.push(...body);

    const more = /<([^>]+)>;\s*rel="next"/.exec(link);

    next = more ? more[1] : null;
  }

  return all;
}

function severityOf(value) {
  const known = ['critical', 'high', 'medium', 'low'];

  return known.includes(value) ? value : 'low';
}

async function fetchAlerts() {
  // No `state` filter, deliberately. The parameter takes a comma-separated list of the four
  // real states and has no "all" - and an unrecognised value is not an error, it is an empty
  // list. Asking for `state=all` returns zero alerts with HTTP 200, which is indistinguishable
  // from a repository that has none.
  const raw = await paginate(
    `${ API }/repos/${ REPO }/dependabot/alerts?per_page=100`,
    'reading the Dependabot alerts',
  );

  return raw.map((a) => ({
    id:              a.number,
    library:         a.security_vulnerability?.package?.name || a.dependency?.package?.name || '?',
    ecosystem:       a.security_vulnerability?.package?.ecosystem || 'npm',
    ghsa:            a.security_advisory?.ghsa_id || '',
    cve:             a.security_advisory?.cve_id || null,
    severity:        severityOf(a.security_advisory?.severity),
    summary:         a.security_advisory?.summary || '',
    manifest:        a.dependency?.manifest_path || '',
    scope:           a.dependency?.scope || '',
    relationship:    a.dependency?.relationship || '',
    state:           a.state,
    vulnerableRange: a.security_vulnerability?.vulnerable_version_range || '',
    patched:         a.security_vulnerability?.first_patched_version?.identifier || null,
    url:             a.html_url,
    createdAt:       a.created_at,
    fixedAt:         a.fixed_at || null,
  }));
}

function normalisePr(pr) {
  return {
    number:      pr.number,
    url:         pr.html_url,
    title:       pr.title || '',
    headRefName: pr.head?.ref || '',
    status:      pr.merged_at ? 'merged' : (pr.state === 'closed' ? 'closed' : 'open'),
    author:      pr.user?.login || '',
    createdAt:   pr.created_at,
    mergedAt:    pr.merged_at || null,
    videoUrl:    videoIn(pr.body || ''),
  };
}

/**
 * A verification video already attached to a pull request body.
 *
 * Detecting it means the board's recording pill survives losing our own record of the run -
 * the pull request is the durable copy, and a GitHub-hosted URL is the published one.
 */
function videoIn(body) {
  const found = /https:\/\/github\.com\/user-attachments\/assets\/[0-9a-f-]+/i.exec(body);

  return found ? found[0] : null;
}

/**
 * Our pull requests, in one GraphQL search.
 *
 * Not by paging `/pulls?state=closed`: rancher/dashboard has tens of thousands and the ones
 * that matter are a few hundred by one author. Not by the REST search either - that returns
 * issue records carrying neither the head branch nor a body, so every hit needed a second
 * call and a few hundred of those take longer than the whole rest of the gather. GraphQL
 * answers the question and returns the fields in the same request.
 *
 * Both fields it adds are load-bearing: a closed alert is attributed to a merge by TIMING, and
 * the branch is the fallback when a title says nothing.
 */
async function fetchOurPulls() {
  const query = `repo:${ REPO } author:${ FORK_OWNER } is:pr`;
  const found = [];
  let cursor = null;

  for (;;) {
    const page = await graphql(
      `query($q: String!, $after: String) {
         search(query: $q, type: ISSUE, first: 100, after: $after) {
           pageInfo { hasNextPage endCursor }
           nodes {
             ... on PullRequest {
               number url title headRefName state createdAt mergedAt body
               author { login }
             }
           }
         }
       }`,
      { q: query, after: cursor },
    );
    const { nodes = [], pageInfo = {} } = page.search || {};

    found.push(...nodes.filter((n) => n && n.number));

    if (!pageInfo.hasNextPage) {
      break;
    }

    cursor = pageInfo.endCursor;
  }

  return found
    .map((n) => ({
      number:      n.number,
      url:         n.url,
      title:       n.title || '',
      headRefName: n.headRefName || '',
      status:      n.mergedAt ? 'merged' : (n.state === 'CLOSED' ? 'closed' : 'open'),
      author:      n.author?.login || '',
      createdAt:   n.createdAt,
      mergedAt:    n.mergedAt || null,
      videoUrl:    videoIn(n.body || ''),
    }))
    .filter((p) => p.status !== 'closed');
}

async function graphql(query, variables) {
  let resp;

  try {
    resp = await fetch(`${ API }/graphql`, {
      method:  'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ query, variables }),
    });
  } catch (e) {
    throw new Error(`searching for our pull requests: ${ e?.message || e }`, { cause: e });
  }

  const text = await resp.text();

  if (!resp.ok) {
    throw new Error(`searching for our pull requests: HTTP ${ resp.status } - ${ text.slice(0, 300) }`);
  }

  const body = JSON.parse(text);

  // GraphQL answers 200 with an `errors` array, so a failure here looks like a success to
  // anything that only checks the status.
  if (body.errors?.length) {
    throw new Error(`searching for our pull requests: ${ body.errors.map((e) => e.message).join('; ') }`);
  }

  return body.data;
}

/** Dependabot's own open pull requests - the "there is already one upstream" signal. */
async function fetchDependabotPulls() {
  const open = await paginate(
    `${ API }/repos/${ REPO }/pulls?state=open&per_page=100`,
    'reading the open pull requests',
  );

  return open.map(normalisePr).filter((p) => p.author === 'dependabot[bot]');
}

async function main() {
  const [alerts, dependabotPrs, ourPrs] = await Promise.all([
    fetchAlerts(), fetchDependabotPulls(), fetchOurPulls(),
  ]);

  // A transient failure must never be written as an empty snapshot. The console this replaces
  // piped `gh api | jq ... || echo "[]"`, so a rate-limited page produced a valid 0-alert file
  // that the watcher then reused for the rest of the day - the board simply went blank while
  // the repository had 156 open alerts. Any failure above has already thrown; an empty result
  // here is treated as one too.
  if (!alerts.length) {
    fail('no alerts came back at all. Refusing to write a snapshot that would blank the board.');
  }

  const snapshot = {
    gatheredAt: new Date().toISOString(),
    repo:       REPO,
    alerts,
    dependabotPrs,
    ourPrs,
  };

  writeFileSync(OUT, JSON.stringify(snapshot));

  const open = alerts.filter((a) => a.state === 'open').length;

  process.stderr.write(
    `gather: ${ alerts.length } alerts (${ open } open), ${ dependabotPrs.length } Dependabot pull requests, ${ ourPrs.length } of ours -> ${ OUT }\n`,
  );
}

main().catch((e) => fail(e?.message || String(e)));
