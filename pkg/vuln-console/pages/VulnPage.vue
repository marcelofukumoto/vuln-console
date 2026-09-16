<script setup lang="ts">
// The board: what is actionable on rancher/dashboard, and what is being done about it.
//
// Built to match the interrupt-duty reports console, deliberately and in detail: the same header
// with the title on the left and the actions on the right, the same `btn role-primary` /
// `role-secondary` buttons carrying an icon and a label, the same running strip with the same
// RunProgress steps and the same "Watch the agent" link, and the same drawer - opened the same
// way, through `slideInPanel`, with the same width and height. Two consoles by the same hand
// should not need to be learned twice.
//
// What it keeps from the console it replaces: three counts, one table sorted by severity with
// the rows that have a pull request in flight above the ones that do not, and the shipped work
// behind a drawer.
//
// What is deliberately gone is the "one action at a time" lock that disabled every button on the
// board. It existed because every fix shared one checkout on one laptop; a workspace per library
// removes the reason.
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useStore } from 'vuex';
import { Banner } from '@components/Banner';
import { RcStatusBadge } from '@components/Pill';
import CountBox from '@shell/components/CountBox.vue';
import SortableTable from '@shell/components/SortableTable/index.vue';
import StepPills from '../components/StepPills.vue';
import VulnIds from '../components/VulnIds.vue';
import RunProgress from '../components/RunProgress.vue';
import AgentSessionPanel from '../components/AgentSessionPanel.vue';
import CredentialsDialog from '../components/CredentialsDialog.vue';
import ShippedDrawer from '../components/ShippedDrawer.vue';
import { buildLedger, mergedButStillOpen, severityRank, severityStatus } from '../lib/ledger';
import { credentialsReady, readCredentialStatus } from '../lib/credentials';
import type { CredentialStatus } from '../lib/credentials';
import { readJobs, readSnapshot } from '../lib/store';
import { isStalled, startAction, stopRun } from '../lib/run';
import { appsPlusInstalled } from '../lib/workspace';
import { agentsStatus, whenAgentsReady } from '../lib/agents';
import type { AgentsStatus } from '../lib/agents';
import { elapsedLabel, runPhase } from '../lib/format';
import { refreshSnapshot } from '../lib/gather';
import { UPSTREAM_REPO } from '../config/constants';
import type { Job, JobAction, Ledger, Snapshot, VulnGroup } from '../types';

const store = useStore();

const snapshot = ref<Snapshot | null>(null);
const jobs = ref<Job[]>([]);
const agents = ref<AgentsStatus>({
  state: 'checking', version: null, pod: null, detail: '',
});
const credentials = ref<CredentialStatus>({ gh: 'none', unreadable: false });
const error = ref('');
const loading = ref(true);
const refreshing = ref(false);
const askingForToken = ref(false);
const blockingCredentials = ref(false);

let poll: ReturnType<typeof setInterval> | null = null;

const ledger = computed<Ledger | null>(() => (snapshot.value ? buildLedger({ snapshot: snapshot.value }) : null));

/** Every run still going, newest first — the strip above the board shows one each. */
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
 * worse: the question the board answers is "what is open", and splitting it means counting two
 * lists to find out.
 */
const rows = computed(() => {
  const l = ledger.value;

  if (!l) {
    return [];
  }

  // The sortable columns need real fields to sort on: a header that names a key the row has not
  // got sorts by nothing, which is how the board first rendered with a HIGH row below two
  // MEDIUM ones.
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

const ready = computed(() => agents.value.state === 'ready'
  && credentialsReady(credentials.value)
  && appsPlusInstalled(store));

async function load(): Promise<void> {
  const [snap, allJobs] = await Promise.all([
    readSnapshot().catch(() => null),
    readJobs().catch(() => []),
  ]);

  snapshot.value = snap;
  jobs.value = allJobs;
  loading.value = false;
}

/**
 * Show a run's conversation, in a drawer of our own.
 *
 * Opened exactly as the reports console opens its own, and as `Show Configuration` opens its:
 * no `title` (the drawer chrome draws its own bar), full height, wide, focus-trapped, and closed
 * through a listener rather than by the panel reaching for the store.
 */
function watchSession(job: Job): void {
  if (!job.sessionId) {
    return;
  }

  store.commit('slideInPanel/open', {
    component:      AgentSessionPanel,
    componentProps: {
      width:              'wide',
      height:             'full',
      triggerFocusTrap:   true,
      closeOnRouteChange: ['name', 'params', 'query'],
      onClose:            () => store.commit('slideInPanel/close'),
      job,
    },
  });
}

function openShipped(): void {
  store.commit('slideInPanel/open', {
    component:      ShippedDrawer,
    componentProps: {
      width:              'wide',
      height:             'full',
      triggerFocusTrap:   true,
      closeOnRouteChange: ['name', 'params', 'query'],
      onClose:            () => store.commit('slideInPanel/close'),
      rows:               ledger.value?.lists.prMerged || [],
      repo:               UPSTREAM_REPO,
    },
  });
}

/**
 * The credentials modal, opened the way the reports console opens its own: rendered inline
 * behind a flag, not pushed into the drawer. A short form asking for one value is a dialog, and
 * the other console already decided that.
 */
function manageCredentials(): void {
  blockingCredentials.value = false;
  askingForToken.value = true;
  readCredentialStatus().then((status) => {
    credentials.value = status;
  }).catch(() => undefined);
}

/** After the dialog saved: pick up the new state, and carry on if it was in the way of a run. */
async function credentialsSaved(): Promise<void> {
  credentials.value = await readCredentialStatus().catch(() => credentials.value);

  if (!blockingCredentials.value) {
    askingForToken.value = false;

    return;
  }

  if (credentialsReady(credentials.value)) {
    askingForToken.value = false;
    await fixWorst();
  }
}

async function refresh(): Promise<void> {
  refreshing.value = true;
  error.value = '';

  try {
    await refreshSnapshot();
    await load();
  } catch (e: any) {
    error.value = e?.message || String(e);
  } finally {
    refreshing.value = false;
  }
}

/**
 * Start an action, and show the agent doing it.
 *
 * The drawer opens on the way out, because "I pressed Fix" and "show me what that started" are
 * the same intention - the reports console works this way and having to hunt for a second
 * button to see your own run is a step nobody wants.
 */
async function act(row: VulnGroup, action: JobAction): Promise<void> {
  error.value = '';

  try {
    const job = await startAction({
      store,
      library: row.library,
      action,
      group:   row,
      by:      store.getters['auth/principal']?.loginName,
    });

    jobs.value = [...jobs.value.filter((j) => j.library !== row.library), job];
    watchSession(job);
  } catch (e: any) {
    error.value = e?.message || String(e);
  }
}

/**
 * Fix the worst thing on the board.
 *
 * Picked here rather than by the agent. The old console passed a sentinel meaning "you choose",
 * which put a judgement in the agent's hands that the board has already made: the list is sorted
 * by severity, so the top actionable row IS the highest-severity one.
 */
async function fixWorst(): Promise<void> {
  if (!credentialsReady(credentials.value)) {
    blockingCredentials.value = true;
    askingForToken.value = true;

    return;
  }

  const candidate = rows.value
    .filter((r) => !r.unfixable && !r.job?.branch && r.job?.phase !== 'Running')
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))[0];

  if (!candidate) {
    error.value = 'Nothing on the board is waiting for a fix.';

    return;
  }

  await act(candidate, 'fix');
}

async function stop(job: Job | null): Promise<void> {
  if (!job) {
    return;
  }

  try {
    await stopRun(job);
    await load();
  } catch (e: any) {
    error.value = e?.message || String(e);
  }
}

onMounted(async() => {
  await whenAgentsReady();

  const [status, creds] = await Promise.all([
    agentsStatus(),
    readCredentialStatus().catch(() => ({ gh: 'none' as const, unreadable: true })),
  ]);

  agents.value = status;
  credentials.value = creds;

  await load();

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
  <div class="vuln">
    <header class="vuln__head">
      <div class="vuln__titles">
        <h1 class="vuln__title">
          Vulnerabilities
        </h1>
        <p class="vuln__lede">
          Actionable Dependabot alerts on <code>{{ UPSTREAM_REPO }}</code> — each with the
          lockfiles it touches, and a fix that runs in a workspace of its own.
        </p>
      </div>

      <div class="vuln__actions">
        <button
          type="button"
          class="btn role-primary"
          :disabled="agents.state !== 'ready' || !appsPlusInstalled(store)"
          data-testid="vc-fix-worst"
          :title="ready ? 'Fix the highest-severity vulnerability waiting for one' : agents.detail || 'Not ready yet'"
          @click="fixWorst"
        >
          <i class="icon icon-play" />
          <span>Fix the worst one</span>
        </button>
        <button
          type="button"
          class="btn role-secondary"
          :disabled="!ready || refreshing"
          data-testid="vc-refresh"
          title="Re-read the Dependabot alerts and our pull requests"
          @click="refresh"
        >
          <i class="icon icon-refresh" />
          <span>{{ refreshing ? 'Refreshing…' : 'Refresh' }}</span>
        </button>
        <button
          type="button"
          class="btn role-secondary"
          data-testid="vc-credentials-open"
          title="The GitHub token the board is read and fixed with"
          @click="manageCredentials"
        >
          <i class="icon icon-key" />
          <span>Credentials</span>
        </button>
      </div>
    </header>

    <!--
      The agent's state is a banner only when it is not fine. A full-width green bar saying
      everything works is a bar that is on screen every second of every day to report an absence
      of news.
    -->
    <Banner
      v-if="agents.state !== 'ready' && agents.state !== 'checking'"
      :color="agents.state === 'no-pod' ? 'warning' : 'error'"
      data-testid="vc-agents-banner"
    >
      <strong>Agents is not ready.</strong> {{ agents.detail }}
    </Banner>

    <Banner v-else-if="!appsPlusInstalled(store)" color="warning">
      <strong>Apps Plus is not installed.</strong> A fix runs in a workspace, and a workspace is
      an Apps Plus installation — without it there is nowhere for the work to happen.
    </Banner>

    <Banner v-else-if="!credentialsReady(credentials)" color="warning">
      <strong>No GitHub token is stored.</strong> The board cannot be refreshed and nothing can be
      fixed until there is one.
    </Banner>

    <Banner v-if="error" color="error">
      {{ error }}
    </Banner>

    <section
      v-for="run in activeRuns"
      :key="run.library"
      class="vuln__running"
      data-testid="vc-running"
    >
      <div class="vuln__running-head">
        <i class="icon icon-spinner icon-spin" />
        <strong>Fixing {{ run.library }}</strong>
        <button
          type="button"
          class="vuln__running-stop"
          title="Stop this run"
          @click="stop(run)"
        >
          Stop
        </button>
        <span>{{ elapsedLabel(run) }}</span>
      </div>
      <RunProgress
        :phase="runPhase(run)"
        :elapsed="elapsedLabel(run)"
        :can-open-session="!!run.sessionId"
        @open-session="watchSession(run)"
      />
    </section>

    <div v-if="loading" class="vuln__loading">
      <i class="icon icon-spinner icon-spin" />
      <span>Loading the board…</span>
    </div>

    <template v-else-if="!snapshot">
      <section class="vuln__empty" data-testid="vc-empty">
        <h2>The board has not been gathered yet</h2>
        <p>
          Refreshing reads every Dependabot alert on <code>{{ UPSTREAM_REPO }}</code> and the pull
          requests that relate to them, and stores the result in the cluster. It takes a few
          seconds and happens in the agent pod, not in this page.
        </p>
      </section>
    </template>

    <template v-else>
      <div class="vuln__toolbar">
        <div class="vuln__counts">
          <CountBox name="In flight" :count="ledger?.counts.openPrOpen || 0" primary-color-var="--info" />
          <CountBox name="To fix" :count="ledger?.counts.openNoPr || 0" primary-color-var="--error" />
          <CountBox
            name="Shipped"
            :count="ledger?.counts.prMerged || 0"
            primary-color-var="--success"
            clickable
            @click="openShipped"
          />
        </div>

        <span class="vuln__stamp">
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
        class="vuln__table"
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
            <div class="vuln__lib">
              {{ row.library }}
            </div>
            <a
              v-if="row.stale"
              class="vuln__stale"
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
            <span v-for="file in row.manifests" :key="file" class="vuln__file">{{ file }}</span>
            <span v-if="!row.manifests.length" class="vuln__none">—</span>
          </td>
        </template>

        <template #col:vulns="{ row }">
          <td>
            <VulnIds :vulns="row.vulns" :repo="UPSTREAM_REPO" />
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
            <span v-else class="vuln__none">—</span>
          </td>
        </template>

        <template #col:actions="{ row }">
          <td>
            <StepPills
              :row="row"
              :job="row.job"
              :busy="false"
              @act="act(row, $event)"
              @stop="stop(row.job)"
              @session="watchSession(row.job)"
            />
            <div v-if="row.job?.message" class="vuln__message">
              {{ row.job.message }}
            </div>
          </td>
        </template>
      </SortableTable>
    </template>

    <CredentialsDialog
      v-if="askingForToken"
      :status="credentials"
      :blocking="blockingCredentials"
      @cancel="askingForToken = false"
      @saved="credentialsSaved"
    />
  </div>
</template>

<style lang="scss" scoped>
// The same measurements as the reports console, on purpose. Two consoles by the same hand
// should line up when you flip between them.
.vuln {
  padding: 20px;

  &__head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 24px;
    flex-wrap: wrap;
    margin-bottom: 16px;
  }

  &__titles {
    min-width: 0;
  }

  &__title {
    margin: 0 0 4px;
    font-size: 22px;
    font-weight: 600;
  }

  &__lede {
    margin: 0;
    max-width: 66ch;
    color: var(--muted);
    font-size: 13px;
    line-height: 19px;
  }

  &__actions {
    display: flex;
    gap: 8px;
    flex-shrink: 0;
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
