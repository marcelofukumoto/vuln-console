<script setup lang="ts">
// One board: everything about one repository's Dependabot alerts.
//
// Split out of the page so that two repositories are two instances of the same thing rather
// than two code paths. `rancher-ai-ui` is fixed exactly the way `dashboard` is - same counts,
// same table, same pills, same prompts, same kind of workspace - and the only difference between
// the tabs is the board they are handed.
//
// Each holds its own state: its own snapshot, its own jobs, its own poll. Nothing is shared
// between boards except the token, because nothing should be - a library called `tmp` in one
// repository is not the `tmp` in the other.
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { RcStatusBadge } from '@components/Pill';
import CountBox from '@shell/components/CountBox.vue';
import SortableTable from '@shell/components/SortableTable/index.vue';
import StepPills from './StepPills.vue';
import VulnIds from './VulnIds.vue';
import RunProgress from './RunProgress.vue';
import { buildLedger, mergedButStillOpen, severityRank, severityStatus } from '../lib/ledger';
import { readJobs, readSnapshot } from '../lib/store';
import { isStalled } from '../lib/run';
import { elapsedLabel, runPhase } from '../lib/format';
import { forkFor } from '../config/constants';
import type { Board } from '../config/constants';
import { LOCAL_FIX_STATES } from '../types';
import type {
  Job, JobAction, Ledger, RancherPackageState, Snapshot, UpstreamState, VulnGroup,
} from '../types';

const props = defineProps<{ board: Board }>();

const emit = defineEmits<{
  (e: 'act', row: VulnGroup, action: JobAction): void;
  (e: 'stop', job: Job | null): void;
  (e: 'session', job: Job | null): void;
  (e: 'shipped', rows: VulnGroup[]): void;
  (e: 'loaded', payload: {
    board: string; rows: VulnGroup[]; jobs: Job[]; hasSnapshot: boolean; tokenLogin: string;
  }): void;
}>();

const snapshot = ref<Snapshot | null>(null);
const jobs = ref<Job[]>([]);
const loading = ref(true);

let poll: ReturnType<typeof setInterval> | null = null;

const ledger = computed<Ledger | null>(() => (snapshot.value ? buildLedger({ snapshot: snapshot.value }) : null));

const activeRuns = computed(() => jobs.value
  .filter((job) => job.phase === 'Running' && !isStalled(job))
  .sort((a, b) => b.startedAt - a.startedAt));

/**
 * The run going on for a row, if there is one.
 *
 * Runs are per library and several can be going at once - the board has never serialised them,
 * only the old console did - so this is a lookup rather than "the" current run.
 */
function runFor(library: string) {
  return activeRuns.value.find((job) => job.library === library);
}

/**
 * What a row's Status column says, as a sort key.
 *
 * The board is sorted by what you can DO with a row before it is sorted by how bad the row is,
 * because that is the order somebody works in: finish what is started, then start what can be
 * started, and leave what cannot be acted on here at the bottom. Severity orders within each
 * group, which is where it belongs - a critical row nobody can fix is still not the next thing
 * to look at.
 *
 *   0  started   a run of ours, or a pull request of ours, already exists
 *   1  fixable   nothing yet, and a fix here would clear it
 *   2  waiting   it arrives through a Rancher package, so the group's bump is the fix (or
 *                nothing here can fix it yet)
 *   3  no fix    no patched version exists at all
 *
 * The Rancher case is tested before `unfixable` so the row says where the fix belongs rather
 * than that there isn't one - and a library with no patch published anywhere can still be
 * cleared by a bump that stops pulling it, which is the honest order to read them in.
 */
function actionRank(row: VulnGroup, job: Job | null): number {
  if (job || row.pr?.status === 'open') {
    return 0;
  }

  if (!row.localFix && row.rancher.length) {
    return 2;
  }

  if (row.unfixable) {
    return 3;
  }

  return 1;
}

/** The lockfiles one row's alerts are raised against - one entry per distinct file. */
function manifests(row: VulnGroup): string[] {
  return [...new Set(row.vulns.map((v) => v.manifest).filter(Boolean))].sort();
}

/**
 * One table, with the rows that have a pull request in flight above the ones that do not.
 *
 * Two tables would separate "being dealt with" from "not yet", which sounds tidier and reads
 * worse: the question a board answers is "what is open", and splitting it means counting two
 * lists to find out.
 */
/**
 * The Rancher packages this board depends on, in the order their groups appear.
 */
const rancherPackages = computed(() => snapshot.value?.rancherPackages || []);

const NOT_RANCHER = 'Not related to a Rancher package';

/**
 * One row per (library, group) rather than one per library.
 *
 * A library is not in one group: `js-yaml` arrives through `@rancher/shell`, through
 * `@rancher/cypress` AND through jest, and all three are true at once. Filing it under the
 * first one found would hide two of the three answers - and it is the jest path that made the
 * local override we actually shipped the right fix. So it appears under each, and the key
 * carries the group so the table can tell the copies apart.
 */
const rows = computed(() => {
  const l = ledger.value;

  if (!l) {
    return [];
  }

  const order = new Map(rancherPackages.value.map((rp, i) => [rp.label, i]));

  order.set(NOT_RANCHER, -1);

  const out = [];

  for (const row of [...l.lists.openPrOpen, ...l.lists.openNoPr]) {
    const job = jobs.value.find((j) => j.library === row.library) || null;
    const base = {
      ...row,
      job,
      stale:        mergedButStillOpen(row),
      severityRank: severityRank(row.severity),
      actionRank:   actionRank(row, job),
      manifests:    manifests(row),
    };

    const groups = [
      ...(row.fixableHere ? [{ label: NOT_RANCHER, state: null }] : []),
      ...row.rancher.map((r) => ({ label: r.label, state: r.state, pin: r.pin })),
    ];

    for (const g of groups) {
      out.push({
        ...base,
        id:        `${ g.label }:${ row.library }`,
        group:     g.label,
        groupRank: order.get(g.label) ?? 99,
        // Null in the ungrouped group: the row keeps its own buttons there.
        upstream:  g.state,
        pin:       'pin' in g ? g.pin : undefined,
      });
    }
  }

  return out;
});

/**
 * The version a group's bump goes to.
 *
 * `target` is the gather's answer: the newer of the `latest` and pre-release tags that clears the
 * most. A snapshot written before pre-releases were considered has no `target`; for that one the
 * old reading - `latest`, when it is newer - still stands.
 */
function targetOf(rp: RancherPackageState): string {
  return rp.target ?? (rp.newerRelease ? rp.latest : '');
}

/**
 * What the group's button actually sends.
 *
 * A real row, not a stand-in: the run is started with `group.vulns`, and a synthetic object
 * without them produces a prompt that names the package and lists nothing for it to check. So
 * this carries the open alerts of every library the bump would clear - which is also the list
 * the agent should verify afterwards - and leaves out the ones it would not, because claiming
 * those would have the run chasing vulnerabilities this bump cannot touch.
 *
 * It names the exact version. A pre-release is never reached by "bump to the newest": the
 * registry's `latest` is still the stable one, and a run left to pick would bump nothing.
 */
function groupFixRow(label: string): VulnGroup {
  const rp = rancherPackages.value.find((r) => r.label === label);
  const target = rp ? targetOf(rp) : '';
  const cleared = rows.value.filter((r) => r.group === label && (r.upstream === 'fixed' || r.upstream === 'gone'));
  const vulns = cleared.flatMap((r) => r.vulns).filter((v) => v.state === 'open');

  return {
    library:     rp?.name || label,
    severity:    vulns.map((v) => v.severity).sort((a, b) => severityRank(a) - severityRank(b))[0] || 'low',
    pr:          null,
    vulns,
    unfixable:   false,
    rancher:     [],
    fixableHere: true,
    localFix:    true,
    bumpTo:      target,
    note:        [
      `Bump ${ rp?.name } from ${ rp?.version } to exactly ${ target }${ target && target === rp?.prerelease ? ' - a pre-release, which is where these fixes are published; the latest tag does not carry them' : '' }.`,
      `The board expects it to clear ${ [...new Set(cleared.map((r) => r.library))].join(', ') }.`,
      'Where a vulnerable copy is left after the bump but its range admits a patched version, refresh that lockfile entry too - that is counted as part of this bump.',
    ].join(' '),
  };
}

/**
 * What a group's heading says, and whether its single button is offered.
 *
 * One button for the whole group, because the bump is one act. It needs a version to go to and
 * at least one row that version clears - judged on what the bump installs HERE, which is not
 * what rancher/dashboard's own lockfile shows: most of its fixes are `resolutions` pins, and
 * those never reach a repository that depends on the package.
 */
function groupState(label: string) {
  const rp = rancherPackages.value.find((r) => r.label === label);

  if (!rp) {
    return null;
  }

  const mine = rows.value.filter((r) => r.group === label);
  const cleared = mine.filter((r) => r.upstream === 'fixed' || r.upstream === 'gone').length;
  const local = mine.filter((r) => LOCAL_FIX_STATES.includes(r.upstream as UpstreamState)).length;
  const target = targetOf(rp);
  const summary = [
    target ? `${ cleared } of ${ mine.length } cleared by ${ target }${ target === rp.prerelease ? ' (pre-release)' : '' }` : '',
    local ? `${ local } fixable here` : '',
  ].filter(Boolean).join(' · ');
  let why = '';

  if (rp.error) {
    why = `could not work out what a bump would do: ${ rp.error }`;
  } else if (!target) {
    why = `${ rp.latest || rp.version } is the newest release and this repository already has it`;
  } else if (!cleared) {
    why = `${ target } clears none of these`;
  }

  return {
    rp,
    target,
    summary,
    canFix: cleared > 0 && !!target && !rp.error,
    why,
  };
}

/**
 * What a row under a Rancher package says about itself.
 *
 * Each reason is different work. "Fixed on rancher" used to cover three of them - fixed by a
 * release, fixed on master and not released, and fixed on master only by a pin no release
 * carries - which is how eight rows read "Already fixed" while bumping cleared two.
 */
const UPSTREAM_BADGES: Record<UpstreamState, { status: 'success' | 'info' | 'warning'; label: string; why?: string }> = {
  fixed:      { status: 'success', label: 'Cleared by the bump' },
  gone:       { status: 'success', label: 'Cleared by the bump', why: 'no longer pulled in' },
  refresh:    { status: 'info', label: 'Fixable here', why: 'a lockfile refresh clears it' },
  pinned:     { status: 'warning', label: 'Pinned on rancher only', why: 'no release carries a pin - pin it here' },
  unreleased: { status: 'warning', label: 'Fixed on rancher, not released' },
  open:       { status: 'warning', label: 'Still not fixed on rancher' },
};

function upstreamBadge(state: UpstreamState) {
  return UPSTREAM_BADGES[state] || UPSTREAM_BADGES.open;
}

const headers = [
  {
    name: 'severity', label: 'Severity', value: 'severity', width: 110,
    sort: ['actionRank', 'severityRank', 'library'],
  },
  { name: 'library', label: 'Library', value: 'library', sort: ['library'] },
  { name: 'files', label: 'Files', value: 'manifests' },
  { name: 'vulns', label: 'Vulnerability', value: 'vulns' },
  { name: 'dependabot', label: 'Dependabot', value: 'dependabotPr', width: 120 },
  {
    name: 'actions', label: 'Status / actions', value: 'actions',
    sort: ['actionRank', 'severityRank', 'library'],
  },
];

/** Dependabot's own open pull request for this library, if it has one. */
function dependabotPr(library: string) {
  return (snapshot.value?.dependabotPrs || []).find((p) => p.title.startsWith(`Bump ${ library } `)) || null;
}

async function load(): Promise<void> {
  const [snap, allJobs] = await Promise.all([
    readSnapshot(props.board.id).catch(() => null),
    readJobs(props.board.id).catch(() => []),
  ]);

  snapshot.value = snap;
  jobs.value = allJobs;
  loading.value = false;

  emit('loaded', {
    board:      props.board.id,
    rows:       rows.value,
    jobs:       allJobs,
    hasSnapshot: !!snap,
    tokenLogin: snap?.tokenLogin || '',
  });
}

defineExpose({ load });

onMounted(() => {
  load().catch(() => undefined);

  // Jobs change underneath this page - a run records a branch, a pull request, a failure - and
  // they are written by a pod, not by this tab. Polling the two ConfigMaps is what keeps the
  // board honest without a socket.
  poll = setInterval(() => load().catch(() => undefined), 5000);
});

onUnmounted(() => {
  if (poll) {
    clearInterval(poll);
  }
});
</script>

<template>
  <div class="board">
    <div v-if="loading" class="board__loading">
      <i class="icon icon-spinner icon-spin" />
      <span>Loading the board…</span>
    </div>

    <section v-else-if="!snapshot" class="board__empty" data-testid="vc-empty">
      <h2>{{ board.repo }} has not been gathered yet</h2>
      <p>
        Refreshing reads every Dependabot alert on <code>{{ board.repo }}</code> and the pull
        requests that relate to them, and stores the result in the cluster. It takes a few seconds
        and happens in the agent pod, not in this page.
      </p>
    </section>

    <template v-else>
      <div class="board__toolbar">
        <!--
          The colour variables are the `--sizzle-*` ones, NOT `--info` / `--error` / `--success`.
          CountBox builds its accent with `rgba(var(<name>), <opacity>)`, so the variable has to
          hold an RGB TRIPLET - `0, 169, 217` - and the semantic colours hold a hex. Passing a
          hex makes the whole declaration invalid, which is silent: the 9px coloured edge and the
          tinted border both fall back to plain black, and three stat cards render as three empty
          boxes. That is exactly how they first shipped.
        -->
        <div class="board__counts">
          <CountBox
            name="In flight"
            :count="ledger?.counts.openPrOpen || 0"
            primary-color-var="--sizzle-info"
          />
          <CountBox
            name="To fix"
            :count="ledger?.counts.openNoPr || 0"
            primary-color-var="--sizzle-error"
          />
          <CountBox
            name="Shipped"
            :count="ledger?.counts.prMerged || 0"
            primary-color-var="--sizzle-success"
            clickable
            @click="emit('shipped', ledger?.lists.prMerged || [])"
          />
        </div>

        <span class="board__stamp">
          gathered {{ new Date(snapshot.gatheredAt).toLocaleString() }}
          <template v-if="snapshot.tokenLogin">
            · fixes push to
            <a
              :href="`https://github.com/${ forkFor(board, snapshot.tokenLogin) }`"
              target="_blank"
              rel="noopener"
            >{{ forkFor(board, snapshot.tokenLogin) }}</a>
          </template>
        </span>
      </div>

      <SortableTable
        :rows="rows"
        :headers="headers"
        key-field="id"
        :group-by="rancherPackages.length ? 'group' : null"
        group-sort="groupRank"
        :sub-rows="true"
        :sub-rows-description="false"
        :table-actions="false"
        :row-actions="false"
        :search="true"
        default-sort-by="actions"
        no-rows-key="No open vulnerabilities."
      >
        <!--
          One heading per group, and for a Rancher package one BUTTON - because the fix for
          everything under it is the same single act: bump that package. A Fix on each row
          would be the same run started several times over the same lockfile.
        -->
        <template #group-by="{ group }">
          <div class="board__group">
            <strong>{{ group.ref }}</strong>
            <template v-if="groupState(group.ref)">
              <span v-if="groupState(group.ref).summary" class="board__group-count">
                {{ groupState(group.ref).summary }}
              </span>
              <RcButton
                v-if="groupState(group.ref).canFix"
                variant="primary"
                size="small"
                @click="emit('act', groupFixRow(group.ref), 'fix')"
              >
                <span>Bump {{ groupState(group.ref).rp.name }} to {{ groupState(group.ref).target }}</span>
              </RcButton>
              <span v-else class="board__group-why">{{ groupState(group.ref).why }}</span>
            </template>
          </div>
        </template>

        <template #col:severity="{ row }">
          <td>
            <RcStatusBadge :status="severityStatus(row.severity)">
              {{ row.severity.toUpperCase() }}
            </RcStatusBadge>
          </td>
        </template>

        <template #col:library="{ row }">
          <td>
            <div class="board__lib">
              {{ row.library }}
            </div>
            <a
              v-if="row.stale"
              class="board__stale"
              :href="row.pr?.url"
              target="_blank"
              rel="noopener"
              title="That pull request merged but this alert is still open — the merge did not resolve it. It needs a fresh fix."
            >
              <RcStatusBadge status="warning">merged, alert still open</RcStatusBadge>
            </a>
          </td>
        </template>

        <template #col:files="{ row }">
          <td>
            <span v-for="file in row.manifests" :key="file" class="board__file">{{ file }}</span>
            <span v-if="!row.manifests.length" class="board__none">—</span>
          </td>
        </template>

        <template #col:vulns="{ row }">
          <td>
            <VulnIds :vulns="row.vulns" :repo="board.repo" />
          </td>
        </template>

        <template #col:dependabot="{ row }">
          <td>
            <a
              v-if="dependabotPr(row.library)"
              :href="dependabotPr(row.library)?.url"
              target="_blank"
              rel="noopener"
            >{{ dependabotPr(row.library)?.number }}</a>
            <span v-else class="board__none">—</span>
          </td>
        </template>

        <template #col:actions="{ row }">
          <td>
            <!--
              Under a Rancher package a row says how it can be cleared. Cleared by the bump:
              the group's single button does it. Fixable here or pinned on rancher only: the fix
              is in this repository, so the row keeps its own buttons. Otherwise there is
              nothing to do here yet. The same library under "not related" always keeps its
              buttons, because there the fix IS local.
            -->
            <div v-if="row.upstream" class="board__upstream">
              <RcStatusBadge :status="upstreamBadge(row.upstream).status">
                {{ upstreamBadge(row.upstream).label }}
              </RcStatusBadge>
              <span
                v-if="upstreamBadge(row.upstream).why"
                class="board__group-why"
                :title="row.pin ? `rancher pins it as ${ row.pin }` : undefined"
              >{{ upstreamBadge(row.upstream).why }}</span>
            </div>
            <StepPills
              v-if="!row.upstream || LOCAL_FIX_STATES.includes(row.upstream)"
              :row="row"
              :job="row.job"
              :fork="forkFor(board, snapshot?.tokenLogin || '')"
              :busy="false"
              @act="emit('act', row, $event)"
              @stop="emit('stop', row.job)"
              @session="emit('session', row.job)"
            />
            <div v-if="row.job?.message" class="board__message">
              {{ row.job.message }}
            </div>
          </td>
        </template>
        <!--
          The agent, under the library it is working on, rather than in a banner above a table
          that may be showing several runs at once. Which row is working is then not something
          to match up by name. SortableTable's own sub-row slot, so it is one table and the
          columns stay aligned.
        -->
        <template #sub-row="{ row, fullColspan }">
          <tr v-if="runFor(row.library)" class="board__run-row">
            <td :colspan="fullColspan">
              <div class="board__run">
                <i class="icon icon-spinner icon-spin" />
                <strong>{{ runFor(row.library).action === 'fix' ? 'Fixing' : runFor(row.library).action }}</strong>
                <RunProgress
                  :phase="runPhase(runFor(row.library))"
                  :elapsed="elapsedLabel(runFor(row.library))"
                  :can-open-session="!!runFor(row.library).sessionId"
                  @open-session="emit('session', runFor(row.library))"
                />
                <button
                  type="button"
                  class="board__running-stop"
                  title="Stop this run"
                  @click="emit('stop', runFor(row.library))"
                >
                  Stop
                </button>
              </div>
            </td>
          </tr>
        </template>
      </SortableTable>
    </template>
  </div>
</template>

<style lang="scss" scoped>
// The same measurements as the reports console, on purpose.
.board {
  &__group {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  &__group-count,
  &__group-why {
    color: var(--muted);
    font-size: 12px;
  }

  &__upstream {
    display: flex;
    align-items: center;
    gap: 8px;

    // A row fixable here shows its reason AND its buttons.
    &:not(:last-child) {
      margin-bottom: 6px;
    }
  }

  &__run-row td {
    border-top: none;
    padding: 0 12px 10px;
    background: var(--body-bg);
  }

  &__run {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    border-left: 3px solid var(--info);
    border-radius: 4px;
    background: var(--nav-bg);
    font-size: 13px;

    .icon {
      color: var(--info);
    }
  }

  &__running {
    margin-bottom: 18px;
    padding: 12px 16px;
    border: 1px solid var(--info);
    border-radius: 8px;
    background: var(--body-bg);
  }

  &__running-head {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;

    .icon {
      color: var(--info);
    }

    span {
      margin-left: auto;
      color: var(--muted);
      font-size: 11px;
      font-variant-numeric: tabular-nums;
    }
  }

  &__running-stop {
    border: none;
    background: transparent;
    color: var(--link);
    font-size: 11px;
    cursor: pointer;
    padding: 0;

    &:hover {
      text-decoration: underline;
    }
  }

  &__loading {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 40px 0;
    color: var(--muted);
  }

  &__empty {
    margin: 24px auto 0;
    max-width: 560px;
    padding: 28px 32px;
    border: 1px dashed var(--border);
    border-radius: 10px;
    text-align: center;

    h2 {
      margin: 0 0 8px;
      font-size: 16px;
    }

    p {
      margin: 0;
      color: var(--muted);
      font-size: 13px;
      line-height: 19px;
    }
  }

  &__toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
    margin-bottom: 12px;
  }

  &__counts {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;

    // A shared floor, so three cards holding 4, 6 and 281 are three cards of one size rather
    // than three boxes sized by how big their number happens to be today.
    :deep(.count-container) {
      min-width: 132px;
    }

    // The clickable one should say so before it is hovered - it is the only way into the
    // shipped list.
    :deep(.count-container.clickable .count) {
      transition: background-color 0.1s ease-in-out;

      &:hover {
        background: var(--accent-btn);
      }
    }
  }

  &__stamp {
    font-size: 11px;
    color: var(--muted);
  }

  &__lib {
    font-weight: 600;
    white-space: nowrap;
  }

  &__stale {
    display: inline-block;
    margin-top: 4px;
    text-decoration: none;
  }

  // A plain span, not a <code>: the dashboard gives <code> a border and a filled background,
  // which made a stack of lockfile paths look like a column of disabled text inputs.
  &__file {
    display: block;
    font-family: var(--font-family-mono, monospace);
    font-size: 11px;
    color: var(--muted);
    white-space: nowrap;
  }

  &__none {
    color: var(--muted);
  }

  &__message {
    margin-top: 4px;
    font-size: 11px;
    color: var(--muted);
  }
}
</style>
