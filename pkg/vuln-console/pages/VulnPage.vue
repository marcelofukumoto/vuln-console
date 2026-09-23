<script setup lang="ts">
// The console: one board per repository, behind a tab each.
//
// Built to match the interrupt-duty reports console, deliberately and in detail: the same header
// with the title on the left and the actions on the right, the same `btn role-primary` /
// `role-secondary` buttons carrying an icon and a label, the same credentials modal, and the
// same drawer - opened the same way, through `slideInPanel`, with the same width and height. Two
// consoles by the same hand should not need to be learned twice.
//
// The tabs are two instances of ONE board component, not two code paths. `rancher-ai-ui` is
// fixed exactly the way `dashboard` is: the same prompts, the same kind of workspace, the same
// pills. What differs between them is the repository they point at, and that is a value.
//
// The header's actions act on the tab you are looking at, which is why the active board is
// tracked here rather than left to the tab strip.
import { computed, ref } from 'vue';
import { useStore } from 'vuex';
import { Banner } from '@components/Banner';
import Tabbed from '@shell/components/Tabbed/index.vue';
import Tab from '@shell/components/Tabbed/Tab.vue';
import BoardPanel from '../components/BoardPanel.vue';
import AgentSessionPanel from '../components/AgentSessionPanel.vue';
import CredentialsDialog from '../components/CredentialsDialog.vue';
import ShippedDrawer from '../components/ShippedDrawer.vue';
import { severityRank } from '../lib/ledger';
import { credentialsReady, isAdminUser, readCredentialStatus } from '../lib/credentials';
import type { CredentialStatus } from '../lib/credentials';
import { startAction, stopRun } from '../lib/run';
import { appsPlusInstalled, ensureWorkspaceApp } from '../lib/workspace';
import { agentsStatus, whenAgentsReady } from '../lib/agents';
import type { AgentsStatus } from '../lib/agents';
import { refreshSnapshot } from '../lib/gather';
import { ensureGatherCron } from '../lib/gather-cron';
import { ensureNamespace } from '../lib/store';
import HistoryPanel from '../components/HistoryPanel.vue';
import { BOARDS, boardById } from '../config/constants';
import type { Job, JobAction, VulnGroup } from '../types';

const store = useStore();

const agents = ref<AgentsStatus>({
  state: 'checking', version: null, pod: null, detail: '',
});
const credentials = ref<CredentialStatus>({ stored: false, unreadable: false });

/**
 * Only the `admin` user may change the credential.
 *
 * Asked once, of Rancher, and false until it answers - a gate that defaults open is not a gate.
 * It hides the dialog; it does not hide the Secret, which any cluster owner can read through
 * the API whatever this page draws. See lib/credentials.ts.
 */
const isAdmin = ref(false);

isAdminUser().then((yes) => {
  isAdmin.value = yes;
}).catch(() => undefined);

/**
 * Who is looking at this, as Rancher knows them.
 *
 * The token is stored per user, so this decides whose is read - and therefore whose fork a fix
 * pushes to and who its pull request is authored by.
 */
const principalId = computed<string>(() => store.getters['auth/principalId'] || '');
const error = ref('');
const refreshing = ref(false);
const askingForToken = ref(false);
const blockingCredentials = ref(false);
const activeBoard = ref(BOARDS[0].id);
/**
 * Which half of the console is showing.
 *
 * A toggle rather than a tab beside the boards: the boards are three views of one job - fix
 * what is actionable - and the history is a different question about the same estate. Sitting
 * it in the tab strip made it look like a fourth board.
 */
const showing = ref<'boards' | 'history'>('boards');

/** What each board last reported, so the header's actions can act on the visible one. */
const boardRows = ref<Record<string, VulnGroup[]>>({});
/** Which account each board's gather saw the token belonging to — that account owns the fork. */
const boardTokenLogin = ref<Record<string, string>>({});
const panels = ref<Record<string, any>>({});

const board = computed(() => boardById(activeBoard.value));

const ready = computed(() => agents.value.state === 'ready'
  && credentialsReady(credentials.value)
  && appsPlusInstalled(store));

function onLoaded(payload: { board: string; rows: VulnGroup[]; tokenLogin: string }): void {
  boardRows.value = { ...boardRows.value, [payload.board]: payload.rows };
  boardTokenLogin.value = { ...boardTokenLogin.value, [payload.board]: payload.tokenLogin };
}

/**
 * Show a run's conversation, in a drawer of our own.
 *
 * Opened exactly as the reports console opens its own, and as `Show Configuration` opens its:
 * no `title` (the drawer chrome draws its own bar), full height, wide, focus-trapped, and closed
 * through a listener rather than by the panel reaching for the store.
 */
function watchSession(job: Job | null): void {
  if (!job?.sessionId) {
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

function openShipped(rows: VulnGroup[]): void {
  store.commit('slideInPanel/open', {
    component:      ShippedDrawer,
    componentProps: {
      width:              'wide',
      height:             'full',
      triggerFocusTrap:   true,
      closeOnRouteChange: ['name', 'params', 'query'],
      onClose:            () => store.commit('slideInPanel/close'),
      rows,
      repo:               board.value.repo,
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

async function reload(): Promise<void> {
  await panels.value[activeBoard.value]?.load?.();
}

async function refresh(): Promise<void> {
  refreshing.value = true;
  error.value = '';

  try {
    await refreshSnapshot(board.value);
    await reload();
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
      board:       board.value,
      tokenLogin:  boardTokenLogin.value[activeBoard.value] || '',
      principalId: principalId.value,
      library:     row.library,
      action,
      group:       row,
      // `auth/principal` is undefined on 2.16; principalId is what is actually on the page, and
      // it is the same identity the token is stored under.
      by:          principalId.value,
    });

    await reload();
    watchSession(job);
  } catch (e: any) {
    error.value = e?.message || String(e);
  }
}

/**
 * Fix the worst thing on the board you are looking at.
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

  const candidate = (boardRows.value[activeBoard.value] || [])
    .filter((r: any) => !r.unfixable && r.fixableHere && !r.job?.branch && r.job?.phase !== 'Running')
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))[0];

  if (!candidate) {
    error.value = `Nothing on ${ board.value.repo } is waiting for a fix.`;

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
    await reload();
  } catch (e: any) {
    error.value = e?.message || String(e);
  }
}

// Keep the half-hourly gather in the cluster, and matching this bundle.
//
// Not inside whenAgentsReady: the schedule has nothing to do with the agents extension - it is
// the reason the board is current for somebody who has not opened it in a week, which is
// exactly the case where no agent has been anywhere near it. Quiet on failure for the same
// reason ensureWorkspaceApp is: a reader without the rights to write a CronJob should still
// see the board.
ensureNamespace()
  .then(() => ensureGatherCron(BOARDS))
  .catch(() => undefined);

whenAgentsReady().then(async() => {
  const [status, creds] = await Promise.all([
    agentsStatus(),
    readCredentialStatus().catch(() => ({ stored: false, unreadable: true })),
  ]);

  agents.value = status;
  credentials.value = creds;

  // Bring the workspace App up to date with this bundle. It describes what a fix workspace is,
  // and apps-plus redeploys the installations of an App when it changes - so a script fixed in
  // an extension upgrade reaches every running workspace simply by somebody opening the board.
  // Quiet on failure: a reader without the rights to write an App should still see the board.
  if (appsPlusInstalled(store)) {
    ensureWorkspaceApp(store).catch(() => undefined);
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
          Actionable Dependabot alerts — each with the lockfiles it touches, and a fix that runs
          in a workspace of its own. One board per repository; the actions here act on the one
          you are looking at.
        </p>
      </div>

      <div class="vuln__actions">
        <div class="vuln__switch" role="tablist" aria-label="What to show">
          <button
            type="button"
            role="tab"
            :aria-selected="showing === 'boards'"
            :class="['vuln__switch-btn', { 'is-on': showing === 'boards' }]"
            data-testid="vc-show-boards"
            @click="showing = 'boards'"
          >
            <i class="icon icon-list-flat" />
            <span>Act on it</span>
          </button>
          <button
            type="button"
            role="tab"
            :aria-selected="showing === 'history'"
            :class="['vuln__switch-btn', { 'is-on': showing === 'history' }]"
            data-testid="vc-show-history"
            title="Open Dependabot alerts over time, across every repository the team owns"
            @click="showing = 'history'"
          >
            <i class="icon icon-chart" />
            <span>Over time</span>
          </button>
        </div>

        <button
          v-if="showing === 'boards'"
          type="button"
          class="btn role-primary"
          :disabled="agents.state !== 'ready' || !appsPlusInstalled(store)"
          data-testid="vc-fix-worst"
          :title="ready ? `Fix the highest-severity vulnerability waiting for one on ${ board.repo }` : agents.detail || 'Not ready yet'"
          @click="fixWorst"
        >
          <i class="icon icon-play" />
          <span>Fix the worst one</span>
        </button>
        <button
          v-if="showing === 'boards'"
          type="button"
          class="btn role-secondary"
          :disabled="!ready || refreshing"
          data-testid="vc-refresh"
          :title="`Re-read ${ board.repo }'s Dependabot alerts and our pull requests`"
          @click="refresh"
        >
          <i class="icon icon-refresh" />
          <span>{{ refreshing ? 'Refreshing…' : 'Refresh' }}</span>
        </button>
        <!--
          Only the `admin` user sets the credential, so only they are shown the way in. Hidden
          rather than disabled: a disabled button invites everyone else to ask why, and the
          answer - "somebody else manages this" - is better said by its absence.
        -->
        <button
          v-if="isAdmin"
          type="button"
          class="btn role-secondary"
          data-testid="vc-credentials-open"
          title="The GitHub token every board is read and fixed with"
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
      <strong>You have not stored a GitHub token.</strong> Tokens are per person — a fix pushes
      to your fork and opens the pull request as you — so yours is needed before you can refresh
      a board or fix anything.
      <template v-if="credentials.others">
        {{ credentials.others }} other {{ credentials.others === 1 ? 'person has' : 'people have' }}
        stored one.
      </template>
    </Banner>

    <Banner v-if="error" color="error">
      {{ error }}
    </Banner>

    <HistoryPanel v-if="showing === 'history'" />

    <Tabbed
      v-else
      :default-tab="BOARDS[0].id"
      :use-hash="true"
      @changed="activeBoard = $event.selectedName"
    >
      <Tab
        v-for="entry in BOARDS"
        :key="entry.id"
        :name="entry.id"
        :label="entry.label"
        :weight="BOARDS.length - BOARDS.indexOf(entry)"
      >
        <BoardPanel
          :ref="(el) => (panels[entry.id] = el)"
          :board="entry"
          @act="act"
          @stop="stop"
          @session="watchSession"
          @shipped="openShipped"
          @loaded="onLoaded"
        />
      </Tab>

    </Tabbed>

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

.vuln__switch {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: 4px;
  overflow: hidden;
  margin-right: 4px;
}

.vuln__switch-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: none;
  background: none;
  padding: 0 12px;
  height: 40px;
  cursor: pointer;
  color: var(--body-text);
  font-size: 14px;

  &.is-on {
    background: var(--accent-btn);
    color: var(--link);
  }

  & + & {
    border-left: 1px solid var(--border);
  }
}
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
}
</style>
