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
import type { Board } from '../config/constants';
import type { Job, JobAction, Ledger, Snapshot, VulnGroup } from '../types';

const props = defineProps<{ board: Board }>();

const emit = defineEmits<{
  (e: 'act', row: VulnGroup, action: JobAction): void;
  (e: 'stop', job: Job | null): void;
  (e: 'session', job: Job | null): void;
  (e: 'shipped', rows: VulnGroup[]): void;
  (e: 'loaded', payload: { board: string; rows: VulnGroup[]; jobs: Job[]; hasSnapshot: boolean }): void;
}>();

const snapshot = ref<Snapshot | null>(null);
const jobs = ref<Job[]>([]);
const loading = ref(true);

let poll: ReturnType<typeof setInterval> | null = null;

const ledger = computed<Ledger | null>(() => (snapshot.value ? buildLedger({ snapshot: snapshot.value }) : null));

const activeRuns = computed(() => jobs.value
  .filter((job) => job.phase === 'Running' && !isStalled(job))
  .sort((a, b) => b.startedAt - a.startedAt));

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
const rows = computed(() => {
  const l = ledger.value;

  if (!l) {
    return [];
  }

  // The sortable columns need real fields to sort on: a header that names a key the row has not
  // got sorts by nothing, which is how this first rendered with a HIGH row below two MEDIUM ones.
  return [...l.lists.openPrOpen, ...l.lists.openNoPr].map((row) => ({
    ...row,
    id:           row.library,
    job:          jobs.value.find((j) => j.library === row.library) || null,
    stale:        mergedButStillOpen(row),
    severityRank: severityRank(row.severity),
    flightRank:   row.pr?.status === 'open' ? 0 : 1,
    manifests:    manifests(row),
  }));
});

const headers = [
  {
    name: 'severity', label: 'Severity', value: 'severity', width: 110,
    sort: ['flightRank', 'severityRank', 'library'],
  },
  { name: 'library', label: 'Library', value: 'library', sort: ['library'] },
  { name: 'files', label: 'Files', value: 'manifests' },
  { name: 'vulns', label: 'Vulnerability', value: 'vulns' },
  { name: 'dependabot', label: 'Dependabot', value: 'dependabotPr', width: 120 },
  { name: 'actions', label: 'Status / actions', value: 'actions' },
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
    board: props.board.id, rows: rows.value, jobs: allJobs, hasSnapshot: !!snap,
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
    <section
      v-for="run in activeRuns"
      :key="run.library"
      class="board__running"
      data-testid="vc-running"
    >
      <div class="board__running-head">
        <i class="icon icon-spinner icon-spin" />
        <strong>Fixing {{ run.library }}</strong>
        <button
          type="button"
          class="board__running-stop"
          title="Stop this run"
          @click="emit('stop', run)"
        >
          Stop
        </button>
        <span>{{ elapsedLabel(run) }}</span>
      </div>
      <RunProgress
        :phase="runPhase(run)"
        :elapsed="elapsedLabel(run)"
        :can-open-session="!!run.sessionId"
        @open-session="emit('session', run)"
      />
    </section>

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
        <div class="board__counts">
          <CountBox name="In flight" :count="ledger?.counts.openPrOpen || 0" primary-color-var="--info" />
          <CountBox name="To fix" :count="ledger?.counts.openNoPr || 0" primary-color-var="--error" />
          <CountBox
            name="Shipped"
            :count="ledger?.counts.prMerged || 0"
            primary-color-var="--success"
            clickable
            @click="emit('shipped', ledger?.lists.prMerged || [])"
          />
        </div>

        <span class="board__stamp">
          gathered {{ new Date(snapshot.gatheredAt).toLocaleString() }}
        </span>
      </div>

      <SortableTable
        :rows="rows"
        :headers="headers"
        key-field="id"
        :table-actions="false"
        :row-actions="false"
        :search="true"
        default-sort-by="severity"
        no-rows-key="No open vulnerabilities."
      >
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
            <StepPills
              :row="row"
              :job="row.job"
              :fork="board.fork"
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
      </SortableTable>
    </template>
  </div>
</template>

<style lang="scss" scoped>
// The same measurements as the reports console, on purpose.
.board {
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
