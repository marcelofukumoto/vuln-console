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
import { credentialsReady, readCredentialStatus } from '../lib/credentials';
import type { CredentialStatus } from '../lib/credentials';
import { startAction, stopRun } from '../lib/run';
import { appsPlusInstalled, ensureWorkspaceApp } from '../lib/workspace';
import { agentsStatus, whenAgentsReady } from '../lib/agents';
import type { AgentsStatus } from '../lib/agents';
import { refreshSnapshot } from '../lib/gather';
import { BOARDS, boardById } from '../config/constants';
import type { Job, JobAction, VulnGroup } from '../types';

const store = useStore();

const agents = ref<AgentsStatus>({
  state: 'checking', version: null, pod: null, detail: '',
});
const credentials = ref<CredentialStatus>({ stored: false, others: 0, unreadable: false });

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
  readCredentialStatus(principalId.value).then((status) => {
    credentials.value = status;
  }).catch(() => undefined);
}

/** After the dialog saved: pick up the new state, and carry on if it was in the way of a run. */
async function credentialsSaved(): Promise<void> {
  credentials.value = await readCredentialStatus(principalId.value).catch(() => credentials.value);

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
    await refreshSnapshot(board.value, principalId.value);
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

whenAgentsReady().then(async() => {
  const [status, creds] = await Promise.all([
    agentsStatus(),
    readCredentialStatus(principalId.value).catch(() => ({ stored: false, others: 0, unreadable: true })),
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
        <button
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
        <button
          type="button"
          class="btn role-secondary"
          data-testid="vc-credentials-open"
          title="The GitHub token the boards are read and fixed with"
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

    <Tabbed
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
      :principal-id="principalId"
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
}
</style>
