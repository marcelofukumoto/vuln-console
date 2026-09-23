#!/usr/bin/env node
// Rebuild "Dependabot alerts over time" from the alerts themselves.
//
// There are no daily snapshots to keep, and there never were: a Dependabot alert carries its
// own lifecycle - created_at, and whichever of fixed_at / dismissed_at / auto_dismissed_at
// closed it - so "how many were open in March 2021" is answerable from one pull per repository.
// That is why re-running this is idempotent and why a missed day costs nothing.
//
// Ported from the Python that built the same file for the standalone console. Same
// reconstruction, same output shape, so the seven years already gathered stay readable.
//
//   CREDS_FILE=/tmp/creds.json OUT=/tmp/history.json REPOS='[{"repo":"o/r","category":"X"}]' \
//     node history.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const API = process.env.GITHUB_API || 'https://api.github.com';
const OUT = process.env.OUT || './history.json';
const REPOS = JSON.parse(process.env.REPOS || '[]');
const BUCKET_DAYS = Number(process.env.BUCKET_DAYS || 7);
const DAY = 86400000;

function token() {
  const file = process.env.CREDS_FILE;

  if (!file) {
    return process.env.GH_TOKEN || '';
  }

  try {
    return JSON.parse(readFileSync(file, 'utf8')).GH_TOKEN || '';
  } catch {
    return '';
  }
}

const GH = token();

if (!GH) {
  process.stderr.write('history: no GitHub token\n');
  process.exit(2);
}

/**
 * Every alert in one repository, or why we cannot see them.
 *
 * NO `state` parameter, and cursor pagination rather than `?page=N`. Both are deliberate: this
 * endpoint paginates with `after=` from the Link header, and asking it for `state=all` has
 * returned an empty list here before - the reason the boards' own gather does not ask either.
 *
 * A 403 is not one thing. Dependabot switched off, an archived repository and a token without
 * rights all answer 403, and only the first two are facts about the repository rather than
 * about us - so the message decides, and any of them means "not charted" rather than "zero".
 */
async function alertsFor(repo) {
  const out = [];
  let url = `${ API }/repos/${ repo }/dependabot/alerts?per_page=100&sort=updated&direction=desc`;
  let pages = 0;

  while (url && pages < 40) {
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${ GH }`, Accept: 'application/vnd.github+json', 'User-Agent': 'vuln-console',
      },
    });

    if (!resp.ok) {
      const body = (await resp.text()).slice(0, 200);
      let why = `http ${ resp.status }`;

      if (resp.status === 403 && /disabled/i.test(body)) {
        why = 'alerts disabled';
      } else if (resp.status === 403 && /archived/i.test(body)) {
        why = 'archived';
      } else if (resp.status === 403 || resp.status === 404) {
        why = 'no access';
      }

      return { ok: false, why };
    }

    for (const a of await resp.json()) {
      const closed = [a.fixed_at, a.dismissed_at, a.auto_dismissed_at].filter(Boolean).sort()[0] || null;

      out.push({
        sev:     (a.security_advisory?.severity || a.security_vulnerability?.severity || 'low').toLowerCase(),
        created: Date.parse(a.created_at),
        closed:  closed ? Date.parse(closed) : null,
      });
    }

    // `after=` from the Link header. There is no page count to loop over.
    const next = /<([^>]+)>;\s*rel="next"/.exec(resp.headers.get('link') || '');

    url = next ? next[1] : null;
    pages++;
  }

  return { ok: true, alerts: out };
}

const charted = {};
const skipped = [];

for (const { repo, category } of REPOS) {
  const got = await alertsFor(repo).catch((e) => ({ ok: false, why: String(e.message || e).slice(0, 80) }));

  if (!got.ok) {
    skipped.push(repo);
    process.stderr.write(`history: ${ repo } not charted - ${ got.why }\n`);
    continue;
  }

  charted[repo] = { category, alerts: got.alerts };
  process.stderr.write(`history: ${ repo } ${ got.alerts.length } alerts\n`);
}

if (!Object.keys(charted).length) {
  process.stderr.write('history: nothing readable; refusing to write a history with no repositories\n');
  process.exit(1);
}

// The buckets: from the oldest alert anywhere to today, one every BUCKET_DAYS.
const oldest = Math.min(...Object.values(charted).flatMap((r) => r.alerts.map((a) => a.created)).concat(Date.now()));
const dates = [];

for (let t = oldest; t <= Date.now(); t += BUCKET_DAYS * DAY) {
  dates.push(new Date(t).toISOString().slice(0, 10));
}

if (dates[dates.length - 1] !== new Date().toISOString().slice(0, 10)) {
  dates.push(new Date().toISOString().slice(0, 10));
}

/**
 * A bucket is measured at the END of its day, not the start.
 *
 * It decides whether an alert raised on the bucket's own date counts as open in it, and it
 * makes a visible difference: rancher/dashboard had six medium alerts created on 2026-09-09
 * and closed within a fortnight, which this counts in that bucket and a start-of-day reading
 * does not. Every difference from the file this replaced is exactly that - the older builder
 * measured at the start of the day.
 *
 * End-of-day is the better reading of "open on date D", and it means the newest bucket
 * reflects everything up to now rather than lagging a day behind.
 */
const stamps = dates.map((d) => Date.parse(`${ d }T23:59:59Z`));
const repos = {};

for (const [repo, { category, alerts }] of Object.entries(charted)) {
  const series = {
    category, critical: [], high: [], medium: [], low: [], total: [],
  };

  for (const at of stamps) {
    const counts = {
      critical: 0, high: 0, medium: 0, low: 0,
    };

    for (const a of alerts) {
      // Open on this date: created by then, and not yet closed.
      if (a.created <= at && (a.closed === null || a.closed > at)) {
        counts[a.sev in counts ? a.sev : 'low']++;
      }
    }

    for (const sev of ['critical', 'high', 'medium', 'low']) {
      series[sev].push(counts[sev]);
    }

    series.total.push(counts.critical + counts.high + counts.medium + counts.low);
  }

  repos[repo] = series;
}

writeFileSync(OUT, JSON.stringify({
  generated_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  bucket_days:  BUCKET_DAYS,
  dates,
  repos,
  skipped,
}));

process.stderr.write(`history: ${ dates.length } buckets, ${ Object.keys(repos).length } repos charted, ${ skipped.length } skipped -> ${ OUT }\n`);
