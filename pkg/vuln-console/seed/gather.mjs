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
 * The Rancher packages this repository gets most of its tree from, as JSON.
 *
 * Empty for a repository that is its own tree. Set, it turns on the lockfile walk below. Each
 * entry is `{ name, label, upstreamRepo, manifest }` - see RancherPackage in config/constants.
 */
const RANCHER_PACKAGES = JSON.parse(process.env.RANCHER_PACKAGES || '[]');
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
      // Which versions the advisory actually covers. Without it the walk can only match by
      // library NAME, and a name is not a vulnerability: rancher-ai-ui carries four copies of
      // js-yaml and only one of them - 4.3.0, pulled by @rancher/shell alone - is in range.
      // Matching by name put the row in the "fixable here" group because jest pulls a js-yaml
      // too, and jest's is 3.15.2, which no advisory here covers.
      range:     a.security_vulnerability?.vulnerable_version_range || '',
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



async function repoFile(path, repo = REPO) {
  const resp = await fetch(`${ API }/repos/${ repo }/contents/${ path }`, {
    headers: { ...HEADERS, Accept: 'application/vnd.github.raw' },
  });

  if (!resp.ok) {
    throw new Error(`reading ${ path } from ${ repo }: HTTP ${ resp.status }`);
  }

  return resp.text();
}

/**
 * Is this version inside one of GitHub's vulnerable ranges?
 *
 * They are spelled as comma-separated comparators - `>= 4.0.0, < 4.3.2`, `< 1.2.3`, `= 2.0.0` -
 * so each part is an operator and a version and all of them must hold. Numeric compare only;
 * a prerelease suffix is ignored, which errs towards calling something vulnerable and is the
 * safe direction for a security board.
 */
function inRange(version, range) {
  if (!version || !range) {
    return false;
  }

  return range.split(',').every((part) => {
    const m = part.trim().match(/^(>=|<=|>|<|=)?\s*(.+)$/);

    if (!m) {
      return false;
    }

    const cmp = compareVersions(version, m[2].trim());

    switch (m[1] || '=') {
    case '>=': return cmp >= 0;
    case '<=': return cmp <= 0;
    case '>': return cmp > 0;
    case '<': return cmp < 0;
    default: return cmp === 0;
    }
  });
}

/** -1, 0 or 1, on the numeric parts alone. */
function compareVersions(a, b) {
  const pa = (String(a).match(/\d+/g) || ['0']).slice(0, 3).map(Number);
  const pb = (String(b).match(/\d+/g) || ['0']).slice(0, 3).map(Number);

  while (pa.length < 3) { pa.push(0); }
  while (pb.length < 3) { pb.push(0); }

  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) { return pa[i] < pb[i] ? -1 : 1; }
  }

  return 0;
}

/**
 * Compare two versions by their numeric parts. Enough for "is this at least the patch".
 */
function atLeast(have, need) {
  const a = (String(have).match(/\d+/g) || ['0']).slice(0, 3).map(Number);
  const b = (String(need).match(/\d+/g) || ['0']).slice(0, 3).map(Number);

  while (a.length < 3) { a.push(0); }
  while (b.length < 3) { b.push(0); }

  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) { return a[i] > b[i]; }
  }

  return true;
}

// ── What a bump would actually install ────────────────────────────────────────────────────
//
// "Has rancher fixed it" used to be answered from rancher/dashboard MASTER's lockfile, and that
// is the wrong tree. Most of what dashboard fixes, it fixes with `resolutions` pins - in the root
// package.json and in shell/package.json itself - and yarn applies `resolutions` only from the
// project being installed, never from a dependency. So master's lockfile was clean while every
// consumer of `@rancher/shell` still installed the vulnerable copies: the board said "Already
// fixed on rancher" for postcss, webpack-dev-server, uuid and five more, and bumping ai-ui to
// the newest shell (3.0.14-rc.3) cleared exactly two libraries.
//
// So the question is now asked of what THIS repository would get: the published package at the
// version a bump would go to, resolved against this repository's own lockfile the way yarn v1
// does it - an existing `name@range` entry is kept, a new one takes the highest published
// version in range. Master is still read, but only to say WHY a row stays open: rancher has not
// fixed it, rancher fixed it and has not released it, or rancher pins it where a pin cannot
// reach anybody else.

/** [major, minor, patch, prerelease[]], or null for anything that is not a version. */
function parseVersion(text) {
  const m = /^\s*[v=]?\s*(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?\s*$/.exec(String(text));

  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? m[4].split('.') : []] : null;
}

function comparePre(a, b) {
  if (!a.length || !b.length) {
    // A release sorts above every prerelease of itself.
    return a.length === b.length ? 0 : (a.length ? -1 : 1);
  }

  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined || b[i] === undefined) {
      return a[i] === undefined ? -1 : 1;
    }

    const na = /^\d+$/.test(a[i]);
    const nb = /^\d+$/.test(b[i]);

    if (na && nb && Number(a[i]) !== Number(b[i])) {
      return Number(a[i]) < Number(b[i]) ? -1 : 1;
    }

    if (na !== nb) {
      return na ? -1 : 1;
    }

    if (!na && a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1;
    }
  }

  return 0;
}

function semverCompare(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1;
    }
  }

  return comparePre(a[3], b[3]);
}

/** Is `a` a strictly later version than `b`? Prereleases count: 3.0.14-rc.3 is after 3.0.13. */
function newer(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);

  return !!(pa && pb && semverCompare(pa, pb) > 0);
}

/** The lowest possible prerelease, so `<2.0.0-0` excludes 2.0.0's prereleases too. */
const ZERO = ['0'];

/**
 * One npm range token as plain comparators, or null when it is not a semver range at all (a git
 * URL, a tarball, a path). The desugaring is node-semver's: `^`, `~`, x-ranges and partials.
 */
function desugar(token) {
  const [, op = '', rest] = /^(\^|~>?|>=|<=|>|<|=)?(.*)$/.exec(token);
  const m = /^[v=]?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(rest);

  if (!m) {
    return rest === '' && op === '' ? [] : null;
  }

  const num = (s) => (s === undefined || /^[xX*]$/.test(s) ? null : Number(s));
  const M = num(m[1]);
  const mi = num(m[2]);
  const pa = num(m[3]);
  const pre = m[4] ? m[4].split('.') : [];

  if (M === null) {
    return op === '<' || op === '>' ? null : [];
  }

  const lo = [M, mi ?? 0, pa ?? 0, pre];

  switch (op) {
  case '^': {
    let hi;

    if (M > 0 || mi === null) {
      hi = [M + 1, 0, 0, ZERO];
    } else if (mi > 0 || pa === null) {
      hi = [0, mi + 1, 0, ZERO];
    } else {
      hi = [0, 0, pa + 1, ZERO];
    }

    return [{ op: '>=', v: lo }, { op: '<', v: hi }];
  }
  case '~':
  case '~>':
    return [{ op: '>=', v: lo }, { op: '<', v: mi === null ? [M + 1, 0, 0, ZERO] : [M, mi + 1, 0, ZERO] }];
  case '>':
    if (mi === null) {
      return [{ op: '>=', v: [M + 1, 0, 0, []] }];
    }

    return pa === null ? [{ op: '>=', v: [M, mi + 1, 0, []] }] : [{ op: '>', v: lo }];
  case '>=':
    return [{ op: '>=', v: lo }];
  case '<':
    return [{ op: '<', v: pa === null ? [M, mi ?? 0, 0, ZERO] : lo }];
  case '<=':
    if (mi === null) {
      return [{ op: '<', v: [M + 1, 0, 0, ZERO] }];
    }

    return pa === null ? [{ op: '<', v: [M, mi + 1, 0, ZERO] }] : [{ op: '<=', v: lo }];
  default:
    if (mi === null) {
      return [{ op: '>=', v: lo }, { op: '<', v: [M + 1, 0, 0, ZERO] }];
    }

    return pa === null ? [{ op: '>=', v: lo }, { op: '<', v: [M, mi + 1, 0, ZERO] }] : [{ op: '=', v: lo }];
  }
}

/** An npm range as a list of comparator sets (any one set must hold), or null if unparseable. */
function parseRange(range) {
  const sets = [];

  for (const part of String(range).trim().split('||')) {
    const text = part.trim();
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(text);
    const tokens = hyphen ? [`>=${ hyphen[1] }`, `<=${ hyphen[2] }`] : text.replace(/(\^|~>?|>=|<=|>|<|=)\s+/g, '$1').split(/\s+/).filter(Boolean);
    const set = [];

    for (const token of tokens) {
      const comparators = desugar(token);

      if (!comparators) {
        return null;
      }

      set.push(...comparators);
    }

    sets.push(set);
  }

  return sets;
}

function satisfies(version, sets) {
  return sets.some((set) => set.every(({ op, v }) => {
    const d = semverCompare(version, v);

    return op === '>=' ? d >= 0 : op === '>' ? d > 0 : op === '<' ? d < 0 : op === '<=' ? d <= 0 : d === 0;
  }) && (
    // A prerelease only satisfies a range that names a prerelease of the same version - so
    // `^3.0.0` never resolves to 3.0.14-rc.3, and pinning `3.0.14-rc.3` exactly does.
    !version[3].length || set.some(({ v }) => v[3].length && v[3] !== ZERO && v[0] === version[0] && v[1] === version[1] && v[2] === version[2])
  ));
}

function maxSatisfying(versions, range) {
  const sets = parseRange(range);

  if (!sets) {
    return null;
  }

  let best = null;

  for (const text of versions) {
    const v = parseVersion(text);

    if (v && satisfies(v, sets) && (!best || semverCompare(v, best.v) > 0)) {
      best = { text, v };
    }
  }

  return best?.text || null;
}

/** `name@range`, split at the first `@` that is not a scope's. */
function splitSpec(spec) {
  const at = spec.indexOf('@', 1);

  return at > 0 ? { name: spec.slice(0, at), range: spec.slice(at + 1) } : { name: spec, range: '' };
}

/**
 * The package that is actually installed for a spec, seeing through `npm:` aliases and yarn's
 * `patch:` protocol (rancher/dashboard's cypress workspace patches `got` that way).
 */
function realSpec(spec) {
  const { name, range } = splitSpec(spec);

  if (range.startsWith('patch:')) {
    return realSpec(decodeURIComponent(range.slice(6).split('#')[0]));
  }

  if (range.startsWith('npm:')) {
    const real = splitSpec(range.slice(4));

    return { name: real.name, range: real.range || '*' };
  }

  return { name, range };
}

const PACKUMENTS = new Map();

/** A package's registry document, fetched once per gather however often it is asked for. */
function packument(name) {
  if (!PACKUMENTS.has(name)) {
    PACKUMENTS.set(name, (async () => {
      const resp = await fetch(`https://registry.npmjs.org/${ name.replace('/', '%2f') }`, {
        headers: { Accept: 'application/vnd.npm.install-v1+json' },
      });

      if (!resp.ok) {
        throw new Error(`reading ${ name } from the npm registry: HTTP ${ resp.status }`);
      }

      return resp.json();
    })());
  }

  return PACKUMENTS.get(name);
}

/**
 * The versions a bump could go to: the `latest` release, and the `pre-release` one when it is
 * newer.
 *
 * Both, because rancher publishes the next shell as a pre-release for weeks before it is tagged
 * latest, and the fixes land in those first. Reading `latest` alone said "3.0.13 is the newest
 * release" the day after 3.0.14-rc.3 was published with two of these fixes in it.
 */
async function publishedCandidates(name) {
  const tags = (await packument(name))['dist-tags'] || {};
  const latest = tags.latest || '';
  const prerelease = Object.entries(tags)
    .filter(([tag, v]) => /pre-?release|next|rc/i.test(tag) && !/legacy/i.test(tag) && newer(v, latest))
    .map(([, v]) => v)
    .sort((a, b) => semverCompare(parseVersion(b), parseVersion(a)))[0] || '';

  return { latest, prerelease };
}

/**
 * Resolve one spec the way `yarn install` does for an entry the lockfile does not have: the
 * highest published version inside the range, with this repository's own `resolutions` applied.
 */
async function resolveFromRegistry(spec, resolutions) {
  const real = realSpec(spec);
  const range = resolutions[real.name] || real.range;
  const doc = await packument(real.name);
  const version = doc['dist-tags']?.[range] || maxSatisfying(Object.keys(doc.versions || {}), range);

  if (!version) {
    throw new Error(`nothing published for ${ real.name } satisfies "${ range }"`);
  }

  const meta = doc.versions[version] || {};
  const deps = Object.entries({ ...(meta.dependencies || {}), ...(meta.optionalDependencies || {}) })
    .map(([n, r]) => `${ n }@${ r }`);

  return { version, deps };
}

/**
 * Everything installed under some root specs, as `spec -> { lib, version }`, given a lockfile.
 *
 * An entry the lockfile already has is kept as it is - that is yarn v1's rule and it is why a
 * bump leaves most of the tree alone. A spec it does not have is resolved from the registry.
 * Breadth first and in parallel, because a bump that changes one range can pull a fresh subtree
 * of a few dozen packages.
 *
 * `entries` only has to answer `get(spec)`, so a filtered view of a lockfile works too.
 */
async function installedTree(entries, roots, resolutions, { lenient = false } = {}) {
  const tree = new Map();
  let frontier = [...roots];

  // Lenient drops a spec it cannot resolve (a git URL, a tarball) and carries on. Only for the
  // "what would master release" estimate - a bump's own tree must resolve completely, or a
  // subtree nobody looked at could be hiding the vulnerable copy it is about to call cleared.
  const resolve = (spec) => resolveFromRegistry(spec, resolutions)
    .catch((e) => (lenient ? { version: '', deps: [] } : Promise.reject(e)));

  while (frontier.length) {
    const todo = [...new Set(frontier)].filter((spec) => !tree.has(spec));
    const next = [];

    for (let i = 0; i < todo.length; i += 16) {
      const batch = todo.slice(i, i + 16);
      const resolved = await Promise.all(batch.map((spec) => entries.get(spec) || resolve(spec)));

      batch.forEach((spec, j) => {
        tree.set(spec, { lib: realSpec(spec).name, version: resolved[j].version });
        next.push(...resolved[j].deps);
      });
    }

    frontier = next;
  }

  return tree;
}

/** The copies of each library in a tree: `lib -> [{ spec, version }]`. */
function copiesIn(tree) {
  const out = {};

  for (const [spec, { lib, version }] of tree) {
    (out[lib] = out[lib] || []).push({ spec, version });
  }

  return out;
}

/** A `resolutions` key as `{ parent, lib }`: `a/b` pins b under a, `b` and `**\/b` pin b anywhere. */
function pinTarget(key) {
  const parts = key.replace(/^(\*\*\/)+/, '').split('/');
  const segments = [];

  for (let i = 0; i < parts.length; i++) {
    segments.push(parts[i].startsWith('@') ? `${ parts[i] }/${ parts[++i] }` : parts[i]);
  }

  const lib = segments.pop();
  const parent = segments.pop();

  return { lib, parent: parent && parent !== '**' ? parent : '' };
}

/** The key in a `resolutions` map that pins this library, if one does. `a/b/lib` counts. */
function pinFor(resolutions, lib) {
  const key = Object.keys(resolutions || {}).find((k) => pinTarget(k).lib === lib);

  return key ? `"${ key }": "${ resolutions[key] }"` : '';
}

/**
 * A lockfile as it would be without these pins: every entry a pin decided is left out, so the
 * resolver answers those specs from their own ranges, as a consumer of the package does.
 */
function withoutPins(entries, resolutions) {
  const dropped = new Set();

  for (const key of Object.keys(resolutions || {})) {
    const { lib, parent } = pinTarget(key);

    for (const [spec, entry] of entries) {
      if (!parent && realSpec(spec).name === lib) {
        dropped.add(spec);
      } else if (parent && realSpec(spec).name === parent) {
        entry.deps.filter((d) => realSpec(d).name === lib).forEach((d) => dropped.add(d));
      }
    }
  }

  return new Map([...entries].filter(([spec]) => !dropped.has(spec)));
}

/**
 * A monorepo's lockfile, answering a spec it has no key for with the highest entry of that
 * package that is in range.
 *
 * rancher/dashboard's lockfile has no key at all for fifteen of shell/package.json's own
 * dependencies - `cronstrue@3.9.0`, `@vue/cli-plugin-babel@~5.0.0` - because the root declares
 * the same packages with other ranges and the workspace is served from those. Looking up by the
 * exact key skipped them and everything under them, silently.
 */
function workspaceLookup(entries) {
  const byName = new Map();

  for (const [spec, entry] of entries) {
    const name = realSpec(spec).name;

    byName.set(name, [...(byName.get(name) || []), entry]);
  }

  return {
    get(spec) {
      const exact = entries.get(spec);

      if (exact) {
        return exact;
      }

      const { name, range } = realSpec(spec);
      const found = byName.get(name) || [];
      const version = maxSatisfying(found.map((e) => e.version), range);

      return version ? found.find((e) => e.version === version) : undefined;
    },
  };
}

/**
 * Which direct dependencies actually reach each vulnerable library, and - for each Rancher
 * package among them - what bumping it would do and why a row stays open if it would not.
 *
 * Walked from the lockfile, never guessed from the alert's `relationship`: every alert on a
 * repository like this one is `transitive`, which says the library is not a direct dependency,
 * not who pulled it in. Membership is not exclusive - the same library can come through shell
 * AND cypress AND jest - so the answer is the SET of direct dependencies that reach it.
 *
 * Per library, per Rancher package, one of:
 *
 *   fixed       bumping to `target` leaves no vulnerable copy on this package's path
 *   gone        bumping to `target` stops pulling the library at all - a fix even with no patch
 *   refresh     no bump needed: every range that pulls a vulnerable copy already admits a
 *               patched version, so refreshing this repository's lockfile clears it
 *   pinned      rancher clears it only with a `resolutions` pin, which no release can carry to
 *               this repository - the pin has to be made here
 *   unreleased  rancher fixed it on master and no published version carries it yet
 *   open        rancher has not fixed it either
 */
async function rancherAttribution(vulnerable, alerts) {
  if (!RANCHER_PACKAGES.length) {
    return { sources: {}, packages: [] };
  }

  const [manifest, lock] = await Promise.all([repoFile('package.json'), repoFile('yarn.lock')]);
  const pkg = JSON.parse(manifest);
  const direct = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const entries = parseLock(lock);

  // Only the unscoped pins apply everywhere, and those are the ones a fresh entry is checked
  // against. A path-scoped pin already shows in the lockfile entries it produced.
  const resolutions = Object.fromEntries(Object.entries(pkg.resolutions || {})
    .map(([k, v]) => [k.replace(/^\*\*\//, ''), v])
    .filter(([k]) => /^(@[^/]+\/)?[^/@]+$/.test(k)));

  // The ranges each library is actually vulnerable in, from its open alerts.
  const ranges = {};

  for (const alert of alerts) {
    if (alert.state === 'open' && alert.range) {
      (ranges[alert.library] = ranges[alert.library] || []).push(alert.range);
    }
  }

  // The copy, not the name. A tree carries the same library several times at several versions
  // and an advisory covers some of them: rancher-ai-ui has four js-yamls and the only one in
  // range is 4.3.0, which `@rancher/shell` alone pulls. No range recorded (a closed alert, or an
  // advisory without one) falls back to the name: better a coarse answer than none.
  const isVulnerable = (lib, version) => (ranges[lib] ? ranges[lib].some((r) => inRange(version, r)) : vulnerable.has(lib));

  const sources = {};

  for (const [name, range] of Object.entries(direct)) {
    const root = `${ name }@${ range }`;

    if (!entries.has(root)) {
      continue;
    }

    for (const spec of reachable(entries, [root])) {
      const lib = realSpec(spec).name;

      if (isVulnerable(lib, entries.get(spec)?.version)) {
        (sources[lib] = sources[lib] || []).push(name);
      }
    }
  }

  for (const lib of Object.keys(sources)) {
    sources[lib] = [...new Set(sources[lib])].sort();
  }

  // The highest patch any open alert asks for, per library - the fallback for a library whose
  // alerts carry no range.
  const needed = {};

  for (const alert of alerts) {
    if (alert.state === 'open' && alert.patched && (!needed[alert.library] || atLeast(alert.patched, needed[alert.library]))) {
      needed[alert.library] = alert.patched;
    }
  }

  const packages = [];

  for (const rp of RANCHER_PACKAGES) {
    const rootSpec = `${ rp.name }@${ direct[rp.name] }`;
    const version = entries.get(rootSpec)?.version || '';
    // Open libraries only. `sources` also places libraries whose alerts are all closed (the
    // name fallback above), and the board never draws those.
    const mine = Object.keys(sources).filter((lib) => ranges[lib] && sources[lib].includes(rp.name));
    const record = {
      name:         rp.name,
      label:        rp.label,
      version,
      latest:       '',
      prerelease:   '',
      target:       '',
      newerRelease: false,
      upstreamRepo: rp.upstreamRepo,
      upstream:     {},
      pins:         {},
    };

    try {
      if (!version) {
        throw new Error(`${ rp.name } is not in this repository's lockfile`);
      }

      // What is installed now, straight from the lockfile.
      const current = copiesIn(new Map([...reachable(entries, [rootSpec])]
        .filter((spec) => entries.has(spec))
        .map((spec) => [spec, { lib: realSpec(spec).name, version: entries.get(spec).version }])));

      // Whether re-resolving the lockfile entries clears a library in a tree: every spec holding
      // a vulnerable copy must admit a version outside every vulnerable range. No vulnerable
      // copy at all is trivially true.
      const refreshable = async (lib, copies) => {
        const stuck = (copies[lib] || []).filter((c) => isVulnerable(lib, c.version));

        if (!stuck.length) {
          return true;
        }

        const published = Object.keys((await packument(lib)).versions || {});

        return stuck.every((c) => {
          const top = maxSatisfying(published, realSpec(c.spec).range);

          return !!top && !isVulnerable(lib, top);
        });
      };

      // What each candidate release would install, and which of this package's libraries the
      // bump clears - counting a copy the new tree still holds in range of a patch, because the
      // run refreshes those after bumping. harvester needs both halves for js-yaml: the bump
      // replaces shell's exact 4.3.0, the refresh lifts the ^3.13.1 copy to 3.15.2.
      // The stable release wins a tie: a pre-release is only worth it for more.
      const { latest, prerelease } = await publishedCandidates(rp.name);
      let best = null;

      record.latest = latest;
      record.prerelease = prerelease;

      for (const candidate of [latest, prerelease].filter((v) => v && newer(v, version))) {
        const copies = copiesIn(await installedTree(entries, [`${ rp.name }@${ candidate }`], resolutions));
        const cleared = [];

        for (const lib of mine) {
          if (await refreshable(lib, copies)) {
            cleared.push(lib);
          }
        }

        if (!best || cleared.length > best.cleared.length) {
          best = { version: candidate, copies, cleared };
        }
      }

      record.newerRelease = !!best;
      record.target = best?.version || '';

      // Master, for the rows a bump does not clear, to say which of three reasons keeps them:
      //
      //  - a release cut from master would clear it: `unreleased`, it is on its way
      //  - it would not, yet master's own lockfile is clean: rancher gets there only through its
      //    root `resolutions`, directly or through a pinned parent (linkify-it is clean on master
      //    only because `markdown-it` is pinned). No release carries a pin: `pinned`
      //  - master's lockfile itself still has a vulnerable copy: `open`
      //
      // Only the ROOT pins count. rancher/dashboard is a yarn workspace, so the `resolutions` in
      // shell/package.json are ignored in the monorepo exactly as they are in every consumer.
      // "What a release would install" is master's declared `dependencies` (a consumer never
      // installs devDependencies) resolved through master's lockfile with those pins taken out.
      const [upManifest, upRoot, upLock] = await Promise.all([
        repoFile(rp.manifest, rp.upstreamRepo),
        repoFile('package.json', rp.upstreamRepo),
        repoFile('yarn.lock', rp.upstreamRepo),
      ]);
      const up = JSON.parse(upManifest);
      const upPins = JSON.parse(upRoot).resolutions || {};
      const upRoots = Object.entries(up.dependencies || {}).map(([n, r]) => `${ n }@${ r }`);
      const upEntries = parseLock(upLock);
      const everywhere = Object.fromEntries(Object.entries(upPins).filter(([k]) => !pinTarget(k).parent).map(([k, v]) => [pinTarget(k).lib, v]));
      const onMaster = copiesIn(await installedTree(workspaceLookup(upEntries), upRoots, everywhere, { lenient: true }));
      const fromMaster = copiesIn(await installedTree(workspaceLookup(withoutPins(upEntries, upPins)), upRoots, {}, { lenient: true }));

      record.upstreamVersion = up.version || '';

      for (const lib of mine) {
        // Fixable here without touching the package first: the cheapest honest answer, and it
        // does not wait on anybody's release.
        if (await refreshable(lib, current)) {
          record.upstream[lib] = 'refresh';
          continue;
        }

        if (best?.cleared.includes(lib)) {
          record.upstream[lib] = best.copies[lib]?.length ? 'fixed' : 'gone';
          continue;
        }

        const vulnerableIn = (copies) => (copies[lib] || []).some((c) => isVulnerable(lib, c.version));

        if (!vulnerableIn(fromMaster)) {
          record.upstream[lib] = 'unreleased';
        } else if (!vulnerableIn(onMaster)) {
          record.upstream[lib] = 'pinned';

          const pin = pinFor(upPins, lib);

          if (pin) {
            record.pins[lib] = pin;
          }
        } else {
          record.upstream[lib] = 'open';
        }
      }
    } catch (e) {
      // Not fatal, and not silently "fixed" either: with no answer every row reads `open`, the
      // group offers no bump, and the reason is on the record.
      record.error = String(e?.message || e);
    }

    packages.push(record);
  }

  return { sources, packages };
}

async function main() {
  // First, because everything "ours" is defined by it.
  const owner = await tokenOwner();
  const [alerts, dependabotPrs, ourPrs] = await Promise.all([
    fetchAlerts(),
    fetchDependabotPulls(),
    fetchOurPulls(owner),
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

  // Not fatal: a board that cannot read a lockfile is a board with no grouping, which is the
  // board it was before this existed - not a failed gather.
  const attribution = await rancherAttribution(vulnerable, alerts).catch((e) => {
    process.stderr.write(`gather: could not attribute the tree (${ e?.message || e })\n`);

    return { sources: {}, packages: [] };
  });

  const snapshot = {
    gatheredAt: new Date().toISOString(),
    repo:       REPO,
    tokenLogin: owner,
    alerts,
    dependabotPrs,
    ourPrs,
    ...(attribution.packages.length ? {
      rancherPackages: attribution.packages,
      sources:         attribution.sources,
    } : {}),
  };

  writeFileSync(OUT, JSON.stringify(snapshot));

  const open = alerts.filter((a) => a.state === 'open').length;

  const owns = (snapshot.rancherPackages || [])
    .map((rp) => {
      const states = Object.values(rp.upstream || {});
      const count = (...want) => states.filter((s) => want.includes(s)).length;
      const bump = rp.target ? `${ count('fixed', 'gone') } cleared by ${ rp.target }` : 'no newer release';

      return `, ${ states.length } via ${ rp.name } ${ rp.version } (${ bump }, ${ count('refresh', 'pinned') } fixable here${ rp.error ? `, ERROR: ${ rp.error }` : '' })`;
    })
    .join('');

  process.stderr.write(
    `gather: ${ alerts.length } alerts (${ open } open), ${ dependabotPrs.length } Dependabot pull requests, ${ ourPrs.length } by ${ owner }${ owns } -> ${ OUT }\n`,
  );
}

main().catch((e) => fail(e?.message || String(e)));
