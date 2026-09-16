<script setup lang="ts">
// The board: what is actionable on rancher/dashboard, and what is being done about it.
//
// The same information architecture as the console it replaces - three counts, one table sorted
// by severity with the in-flight rows first, and the shipped work behind a drawer - built out of
// Rancher's own components so it is the same kind of page as the rest of the dashboard rather
// than a dark-themed island.
//
// What is deliberately gone: the "one action at a time" lock that disabled every button on the
// board. It existed because every fix shared one checkout on one laptop. A workspace per library
// removes the reason, so two libraries can be worked on at once and only a second run on the
// SAME library is refused.
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useStore } from 'vuex';
import { Banner } from '@components/Banner';
import RcButton from '@components/RcButton/RcButton.vue';
import CountBox from '@shell/components/CountBox.vue';
import SortableTable from '@shell/components/SortableTable/index.vue';
import SeverityBadge from '../components/SeverityBadge.vue';
import StepPills from '../components/StepPills.vue';
import VulnIds from '../components/VulnIds.vue';
import AgentSessionPanel from '../components/AgentSessionPanel.vue';
import CredentialsDialog from '../components/CredentialsDialog.vue';
import ShippedDrawer from '../components/ShippedDrawer.vue';
import { buildLedger, mergedButStillOpen, severityRank } from '../lib/ledger';
import { readCredentialStatus, credentialsReady } from '../lib/credentials';
import type { CredentialStatus } from '../lib/credentials';
import { readJobs, readSnapshot } from '../lib/store';
import { isStalled, startAction, stopRun } from '../lib/run';
import { appsPlusInstalled } from '../lib/workspace';
import { agentsStatus, whenAgentsReady } from '../lib/agents';
import type { AgentsStatus } from '../lib/agents';
import { refreshSnapshot } from '../lib/gather';
import { UPSTREAM_REPO } from '../config/constants';
import type { Job, JobAction, Ledger, Snapshot, VulnGroup } from '../types';

const store = useStore();

const snapshot = ref<Snapshot | null>(null);
const jobs = ref<Job[]>([]);
const agents = ref<AgentsStatus>({ state: 'checking', version: null, pod: null, detail: '' });
const credentials = ref<CredentialStatus>({ gh: 'none', unreadable: false });
const error = ref('');
const refreshing = ref(false);
const showCredentials = ref(false);
const showShipped = ref(false);
const openSession = ref<Job | null>(null);

let poll: ReturnType<typeof setInterval> | null = null;

const ledger = computed<Ledger | null>(() => (snapshot.value ? buildLedger({ snapshot: snapshot.value }) : null));

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

  return [...l.lists.openPrOpen, ...l.lists.openNoPr].map((row) => ({
    ...row,
    id:      row.library,
    job:     jobs.value.find((j) => j.library === row.library) || null,
    stale:   mergedButStillOpen(row),
  }));
});

const headers = [
  { name: 'severity', labelKey: '', label: 'Severity', value: 'severity', sort: ['severityRank', 'library'], width: 110 },
  { name: 'library', label: 'Library', value: 'library', sort: ['library'] },
  { name: 'files', label: 'Files', value: 'manifests' },
  { name: 'vulns', label: 'Vulnerability', value: 'vulns' },
  { name: 'dependabot', label: 'Dependabot', value: 'dependabotPr', width: 120 },
  { name: 'actions', label: 'Status / actions', value: 'actions' },
];

/** The lockfiles one row's alerts are raised against - one entry per distinct file. */
function manifests(row: VulnGroup): string[] {
  return [...new Set(row.vulns.map((v) => v.manifest).filter(Boolean))].sort();
}

/** Dependabot's own open pull request for this library, if it has one. */
function dependabotPr(library: string) {
  return (snapshot.value?.dependabotPrs || []).find((p) => p.title.startsWith(`Bump ${ library } `)) || null;
}

const anyRunning = computed(() => jobs.value.some((j) => j.phase === 'Running' && !isStalled(j)));

const ready = computed(() => agents.value.state === 'ready' && credentialsReady(credentials.value) && appsPlusInstalled(store));

async function load(): Promise<void> {
  const [snap, allJobs] = await Promise.all([
    readSnapshot().catch(() => null),
    readJobs().catch(() => []),
  ]);

  snapshot.value = snap;
  jobs.value = allJobs;
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

async function act(row: VulnGroup, action: JobAction): Promise<void> {
  error.value = '';

  try {
    const job = await startAction({
      store, library: row.library, action, group: row, by: store.getters['auth/principal']?.loginName,
    });

    jobs.value = [...jobs.value.filter((j) => j.library !== row.library), job];
  } catch (e: any) {
    error.value = e?.message || String(e);
  }
}

/**
 * Fix the worst thing on the board.
 *
 * Picked here rather than by the agent. The old console passed a sentinel meaning "you choose",
 * which put a judgement in the agent's hands that the board has already made: the list is sorted
 * by severity, and the top actionable row IS the highest-severity one.
 */
async function fixHighest(): Promise<void> {
  const candidate = rows.value
    .filter((r) => !r.unfixable && !r.job?.branch && r.job?.phase !== 'Running')
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))[0];

  if (!candidate) {
    error.value = 'Nothing on the board is waiting for a fix.';

    return;
  }

  await act(candidate, 'fix');
}

async function stop(row: { job: Job | null }): Promise<void> {
  if (!row.job) {
    return;
  }

  try {
    await stopRun(row.job);
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
      <h1>Vulnerabilities</h1>
      <p class="vuln__sub">
        Actionable Dependabot alerts on <code>{{ UPSTREAM_REPO }}</code>.
        <strong>Fix</strong> bumps the library in a workspace of its own, serves the branch, and
        verifies it. Opening the pull request is a separate step.
      </p>
    </header>

    <Banner v-if="agents.state !== 'ready' && agents.state !== 'checking'" color="warning">
      {{ agents.detail }}
    </Banner>
    <Banner v-else-if="!appsPlusInstalled(store)" color="warning">
      The Apps Plus extension is not installed. A fix runs in a workspace, and a workspace is an
      Apps Plus installation — without it there is nowhere for the work to happen.
    </Banner>
    <Banner v-else-if="!credentialsReady(credentials)" color="warning">
      No GitHub token is stored, so the board cannot be refreshed and nothing can be fixed.
      <a href="#" @click.prevent="showCredentials = true">Set one</a>.
    </Banner>
    <Banner v-if="error" color="error">
      {{ error }}
    </Banner>

    <div v-if="ledger" class="vuln__counts">
      <CountBox name="In flight" :count="ledger.counts.openPrOpen" primary-color-var="--info" />
      <CountBox name="To fix" :count="ledger.counts.openNoPr" primary-color-var="--error" />
      <CountBox name="Shipped" :count="ledger.counts.prMerged" primary-color-var="--success" clickable @click="showShipped = true" />
    </div>

    <div class="vuln__toolbar">
      <RcButton variant="primary" :disabled="!ready" @click="fixHighest">
        <span>Fix the worst one</span>
      </RcButton>
      <RcButton variant="secondary" :disabled="!ready || refreshing" data-testid="vc-refresh" @click="refresh">
        <span>{{ refreshing ? 'Refreshing…' : 'Refresh' }}</span>
      </RcButton>
      <RcButton variant="secondary" @click="showCredentials = true">
        <span>Credentials</span>
      </RcButton>
      <span class="vuln__stamp">
        <template v-if="snapshot">gathered {{ new Date(snapshot.gatheredAt).toLocaleString() }}</template>
        <template v-else>no gather yet — press Refresh</template>
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
        <td><SeverityBadge :severity="row.severity" /></td>
      </template>

      <template #col:library="{ row }">
        <td>
          <div class="vuln__lib">{{ row.library }}</div>
          <a
            v-if="row.stale"
            class="vuln__stale"
            :href="row.pr?.url"
            target="_blank"
            rel="noopener"
            title="That pull request merged but this alert is still open — the merge did not resolve it. It needs a fresh fix."
          >merged, alert still open</a>
        </td>
      </template>

      <template #col:files="{ row }">
        <td>
          <code v-for="file in manifests(row)" :key="file" class="vuln__file">{{ file }}</code>
          <span v-if="!manifests(row).length" class="vuln__none">—</span>
        </td>
      </template>

      <template #col:vulns="{ row }">
        <td><VulnIds :vulns="row.vulns" :repo="UPSTREAM_REPO" /></td>
      </template>

      <template #col:dependabot="{ row }">
        <td>
          <a v-if="dependabotPr(row.library)" :href="dependabotPr(row.library)?.url" target="_blank" rel="noopener">
            {{ dependabotPr(row.library)?.number }}
          </a>
          <span v-else class="vuln__none">—</span>
        </td>
      </template>

      <template #col:actions="{ row }">
        <td>
          <StepPills
            :row="row"
            :job="row.job"
            :busy="anyRunning && row.job?.phase === 'Running'"
            @act="act(row, $event)"
            @stop="stop(row)"
            @session="openSession = row.job"
          />
          <div v-if="row.job?.message" class="vuln__message">{{ row.job.message }}</div>
        </td>
      </template>
    </SortableTable>

    <ShippedDrawer
      v-if="showShipped && ledger"
      :rows="ledger.lists.prMerged"
      :repo="UPSTREAM_REPO"
      @close="showShipped = false"
    />

    <AgentSessionPanel
      v-if="openSession"
      :job="openSession"
      :on-back="() => (openSession = null)"
      @close="openSession = null"
    />

    <CredentialsDialog
      v-if="showCredentials"
      :status="credentials"
      @saved="credentials = $event"
      @close="showCredentials = false"
    />
  </div>
</template>

<style lang="scss" scoped>
.vuln {
  padding: 0 0 40px;

  &__head {
    margin-bottom: 16px;

    h1 {
      margin: 0 0 4px;
    }
  }

  &__sub {
    margin: 0;
    max-width: 780px;
    color: var(--muted);
  }

  &__counts {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    margin-bottom: 16px;
  }

  &__toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
  }

  &__stamp {
    margin-left: auto;
    font-size: 11px;
    color: var(--muted);
  }

  &__lib {
    font-weight: 600;
  }

  &__stale {
    display: block;
    margin-top: 2px;
    font-size: 11px;
    color: var(--warning);
  }

  &__file {
    display: block;
    font-size: 11px;
    background: none;
    padding: 0;
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
