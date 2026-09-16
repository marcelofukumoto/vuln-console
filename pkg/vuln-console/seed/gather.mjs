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

/**
 * The package this repository gets most of its tree from, if it has one.
 *
 * Empty for a repository that is its own tree. Set, it turns on the lockfile walk below.
 */
const OWNER_PACKAGE = process.env.OWNER_PACKAGE || '';
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

  // Trimmed, because this ends up in a ConfigMap and a ConfigMap holds a megabyte. The full
  // record for all 969 of rancher/dashboard's alerts is 521 KiB, which is half the ceiling on a
  // list that only grows - so the snapshot carries what the BOARD reads and nothing else:
  //
  //   * `url` is derived (`<repo>/security/dependabot/<id>`), not stored.
  //   * the vulnerable range, scope and relationship are not stored at all. They belong to
  //     fixing, and the fix prompt already enumerates them from the LIVE alerts rather than the
  //     snapshot - precisely because a snapshot can be hours old and a manifest list must not be.
  //   * a CLOSED alert keeps only what the shipped list shows. 959 of the 969 are closed, and
  //     what they are for is "we fixed this" - not the advisory text.
  return raw.map((a) => {
    const open = a.state === 'open';
    const alert = {
      id:       a.number,
      library:  a.security_vulnerability?.package?.name || a.dependency?.package?.name || '?',
      ghsa:     a.security_advisory?.ghsa_id || '',
      severity: severityOf(a.security_advisory?.severity),
      manifest: a.dependency?.manifest_path || '',
      state:    a.state,
      patched:  a.security_vulnerability?.first_patched_version?.identifier || null,
      fixedAt:  a.fixed_at || null,
    };

    if (!open) {
      return alert;
    }

    return {
      ...alert,
      ecosystem: a.security_vulnerability?.package?.ecosystem || 'npm',
      cve:       a.security_advisory?.cve_id || null,
      summary:   a.security_advisory?.summary || '',
      createdAt: a.created_at,
    };
  });
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
/**
 * Who the stored token belongs to.
 *
 * Everything "ours" is defined by this and not by a name written into the extension: our pull
 * requests are the ones this account authored, and our fork is this account's fork. A hard-coded
 * login makes an extension that works for exactly one person and fails at `git push` for
 * everybody else, three minutes into a run.
 */
async function tokenOwner() {
  const { body } = await request(`${ API }/user`, 'identifying the stored token');

  if (!body?.login) {
    throw new Error('identifying the stored token: the answer carried no login');
  }

  return body.login;
}

async function fetchOurPulls(owner) {
  const query = `repo:${ REPO } author:${ owner } is:pr`;
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

// ── Who owns a vulnerable library ──────────────────────────────────────────────────────────

/**
 * Parse a yarn v1 lockfile into `spec -> { version, deps }`.
 *
 * The keys are exactly the `name@range` specs a package asks for, which is what makes the walk
 * below simple: a dependency's declared range IS the key of the entry that satisfies it, so
 * nothing has to resolve semver.
 */
function parseLock(text) {
  const entries = new Map();
  let specs = null;
  let version = '';
  let deps = [];
  let inDeps = false;

  const flush = () => {
    if (specs) {
      for (const spec of specs) {
        entries.set(spec, { version, deps });
      }
    }

    specs = null;
    version = '';
    deps = [];
    inDeps = false;
  };

  for (const raw of text.split('\n')) {
    if (!raw.trim() || raw.startsWith('#')) {
      continue;
    }

    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();

    if (indent === 0) {
      flush();
      specs = line.replace(/:$/, '').split(',').map((part) => part.trim().replace(/^"|"$/g, ''));
      continue;
    }

    if (indent === 2) {
      inDeps = /^(dependencies|optionalDependencies):$/.test(line);

      const found = /^version "?([^"]+)"?$/.exec(line);

      if (found) {
        version = found[1];
      }
      continue;
    }

    if (indent >= 4 && inDeps) {
      const found = /^"?(@?[^"\s]+)"?\s+"?([^"]+)"?$/.exec(line);

      if (found) {
        deps.push(`${ found[1] }@${ found[2] }`);
      }
    }
  }

  flush();

  return entries;
}

function reachable(entries, roots) {
  const seen = new Set();
  const queue = [...roots];

  while (queue.length) {
    const spec = queue.pop();

    if (seen.has(spec)) {
      continue;
    }

    seen.add(spec);

    const entry = entries.get(spec);

    if (entry) {
      queue.push(...entry.deps);
    }
  }

  return seen;
}

/** Package names out of a set of `name@range` specs. */
function namesOf(specs) {
  const names = new Set();

  for (const spec of specs) {
    const at = spec.lastIndexOf('@');

    if (at > 0) {
      names.add(spec.slice(0, at));
    }
  }

  return names;
}

async function repoFile(path) {
  const resp = await fetch(`${ API }/repos/${ REPO }/contents/${ path }`, {
    headers: { ...HEADERS, Accept: 'application/vnd.github.raw' },
  });

  if (!resp.ok) {
    throw new Error(`reading ${ path }: HTTP ${ resp.status }`);
  }

  return resp.text();
}

/**
 * Which vulnerable libraries are in the tree ONLY because of the owner package.
 *
 * Walked from the lockfile rather than guessed from the alert's `relationship`, because every
 * alert on a repository like this one is `transitive` - that field says the library is not a
 * direct dependency, not who pulled it in. rancher-ai-ui's `extract-zip` and `tmp` are
 * transitive too, and they come from Cypress and Jest; calling them shell's would be wrong in a
 * way somebody would only discover by trying to fix one.
 */
async function ownedLibraries() {
  if (!OWNER_PACKAGE) {
    return { ownerOnly: [], ownerVersion: '' };
  }

  const [manifest, lock] = await Promise.all([repoFile('package.json'), repoFile('yarn.lock')]);
  const pkg = JSON.parse(manifest);
  const direct = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const entries = parseLock(lock);

  const ownerRoots = [];
  const otherRoots = [];

  for (const [name, range] of Object.entries(direct)) {
    (name === OWNER_PACKAGE ? ownerRoots : otherRoots).push(`${ name }@${ range }`);
  }

  if (!ownerRoots.length) {
    return { ownerOnly: [], ownerVersion: '' };
  }

  const viaOwner = namesOf(reachable(entries, ownerRoots));
  const viaOther = namesOf(reachable(entries, otherRoots));
  const ownerOnly = [...viaOwner].filter((name) => !viaOther.has(name)).sort();

  return { ownerOnly, ownerVersion: entries.get(ownerRoots[0])?.version || '' };
}

async function main() {
  // First, because everything "ours" is defined by it.
  const owner = await tokenOwner();
  const [alerts, dependabotPrs, ourPrs, owned] = await Promise.all([
    fetchAlerts(),
    fetchDependabotPulls(),
    fetchOurPulls(owner),
    // Never fatal: a board that cannot read its own lockfile is a board with no owner
    // information, which is the same board it was before this existed - not a failed gather.
    ownedLibraries().catch((e) => {
      process.stderr.write(`gather: could not work out what ${ OWNER_PACKAGE } owns (${ e?.message || e })\n`);

      return { ownerOnly: [], ownerVersion: '' };
    }),
  ]);

  // A transient failure must never be written as an empty snapshot. The console this replaces
  // piped `gh api | jq ... || echo "[]"`, so a rate-limited page produced a valid 0-alert file
  // that the watcher then reused for the rest of the day - the board simply went blank while
  // the repository had 156 open alerts. Any failure above has already thrown; an empty result
  // here is treated as one too.
  if (!alerts.length) {
    fail('no alerts came back at all. Refusing to write a snapshot that would blank the board.');
  }

  // Only the vulnerable libraries are worth storing, not the whole reachable set - the set is
  // thousands of names and the board only ever asks about the ones it draws.
  const vulnerable = new Set(alerts.map((a) => a.library));
  const snapshot = {
    gatheredAt: new Date().toISOString(),
    repo:       REPO,
    tokenLogin: owner,
    alerts,
    dependabotPrs,
    ourPrs,
    ...(OWNER_PACKAGE ? {
      ownerPackage: OWNER_PACKAGE,
      ownerVersion: owned.ownerVersion,
      ownerOnly:    owned.ownerOnly.filter((name) => vulnerable.has(name)),
    } : {}),
  };

  writeFileSync(OUT, JSON.stringify(snapshot));

  const open = alerts.filter((a) => a.state === 'open').length;

  const owns = snapshot.ownerOnly?.length
    ? `, ${ snapshot.ownerOnly.length } only via ${ OWNER_PACKAGE } ${ snapshot.ownerVersion }`
    : '';

  process.stderr.write(
    `gather: ${ alerts.length } alerts (${ open } open), ${ dependabotPrs.length } Dependabot pull requests, ${ ourPrs.length } by ${ owner }${ owns } -> ${ OUT }\n`,
  );
}

main().catch((e) => fail(e?.message || String(e)));
