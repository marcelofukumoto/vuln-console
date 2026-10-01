<script setup lang="ts">
// The run's conversation, live, in a drawer of this extension's own.
//
// The pane inside it is the Agents extension's - its terminal component, the one thing it puts
// on `window` for others to place - so this is the real session: the same xterm, the same exec
// socket, the same tmux reattach, and interactive, so the conversation can be asked a question
// rather than only watched.
//
// What it is *not* is that extension's drawer. Driving somebody else's panel meant reaching for
// state and a keystroke it never published, and it put this extension's conversations in a tab
// strip meant for theirs. Borrowing the one component they do publish, and framing it in the
// same Rancher drawer the report opens in, keeps both sides to what they offer each other.
import {
  computed, onMounted, onUnmounted, ref,
} from 'vue';
import { Banner } from '@components/Banner';
import Drawer from '@shell/components/Drawer/Chrome.vue';
import RcButton from '@components/RcButton/RcButton.vue';
import AgentTerminal from './AgentTerminal.vue';
import RunProgress from './RunProgress.vue';
import { elapsedLabel, runPhase } from '../lib/format';
import { readJobs } from '../lib/store';
import type { Job } from '../types';

const props = defineProps<{
  job: Job;
  /**
   * Going back to the board.
   *
   * There is one drawer, so opening the session replaced whatever was in it - and closing then
   * leaves you wherever you happened to be rather than where you came from, which is a dead end
   * when the session was a detour.
   */
  onBack?: (job: Job) => void;
  /** The drawer's own configuration, declared so it is consumed rather than set as an attribute. */
  width?: string;
  height?: string;
  triggerFocusTrap?: boolean;
  closeOnRouteChange?: string[];
}>();

const emit = defineEmits<{ (e: 'close'): void }>();

/**
 * What the pane says about its socket: waiting, connecting, open, closed.
 *
 * Worth surfacing because a conversation that has ended looks, in a terminal, like a terminal
 * that printed a few lines and stopped - which reads as a broken pane rather than as a run that
 * finished while the drawer was being opened.
 */
const state = ref('');

/**
 * The job as it is NOW, not as it was when the drawer opened.
 *
 * The drawer is opened the moment a button is pressed, with the job as it stood then - before
 * the workspace is up and long before the pane exists. A frozen copy can never learn that the
 * pane has started, so it is followed here, the same way the board follows it.
 */
const live = ref<Job>(props.job);
let poll: ReturnType<typeof setInterval> | null = null;

async function refresh(): Promise<void> {
  const latest = (await readJobs(props.job.board).catch(() => [])).find((j) => j.library === props.job.library);

  // Only this run's record. A later run on the same library is a different conversation.
  if (latest && latest.sessionId === props.job.sessionId) {
    live.value = latest;
  }
}

onMounted(() => {
  poll = setInterval(() => refresh().catch(() => undefined), 4000);
});

onUnmounted(() => {
  if (poll) {
    clearInterval(poll);
  }
});

/**
 * Whether the pane may be attached to yet - which is NOT the same as whether it is likely to
 * exist, and the difference broke every run after the first.
 *
 * Attaching a terminal to a conversation whose pane does not exist yet CREATES it, through the
 * Agents extension's own `shell.sh` - without the shell prefix that routes the agent's commands
 * into the workspace. run-start.sh's own start then finds a pane already there and leaves it be.
 * This used to infer "started" from the run's phase, and the phase says `verifying` as soon as a
 * library has a branch - so Record, Create PR and the rest attached two seconds after the click
 * and every command those runs made landed in the agents pod. So it waits for the stage
 * run-start.sh writes only AFTER it has started the pane itself.
 */
const EARLY_STAGES = ['workspace', 'waiting', 'preparing', 'starting'];

const paneStarted = computed(() => !(live.value.phase === 'Running' && EARLY_STAGES.includes(live.value.stage || '')));
</script>

<template>
  <Drawer
    :aria-target="`the agent session for ${ job.library }`"
    @close="emit('close')"
  >
    <template #title>
      Agent session · {{ job.library }}
      <span class="session__id">{{ job.sessionId }}</span>
    </template>

    <template #body>
      <div class="session">
        <!--
          Before the pane exists there is nothing to attach to, and a blank terminal reads as a
          broken one. On a first fix this is most of the run - a Fleet Bundle, an image pull, a
          clone and a yarn install - so it says which of those it is waiting on rather than
          leaving somebody to guess.
        -->
        <div v-if="!job.sessionId || !paneStarted" class="session__waiting">
          <Banner color="info">
            <strong>Setting the workspace up.</strong>
            The first fix for a repository clones it and installs its dependencies, which takes
            several minutes. The agent starts as soon as that is done — you can close this and
            come back.
          </Banner>
          <RunProgress
            :phase="runPhase(live)"
            :elapsed="elapsedLabel(live)"
            :can-open-session="false"
          />
        </div>

        <!--
          Keyed on the session so that opening a different run's conversation builds a new pane
          rather than reusing one still attached to the previous session's socket.
        -->
        <AgentTerminal
          v-else
          :key="job.sessionId || 'none'"
          :session="job.sessionId || ''"
          class="session__terminal"
          @state="state = $event"
        />

        <p v-if="state === 'closed'" class="session__note session__note--ended">
          This conversation has ended — the run it belonged to is over, and the agent pod has
          released it.
        </p>
        <p v-else-if="job.sessionId" class="session__note">
          Closing this drawer leaves the conversation running — it is the pod that holds it, not
          this page.
        </p>
      </div>
    </template>

    <template #additional-actions>
      <RcButton
        v-if="onBack"
        variant="secondary"
        size="large"
        data-testid="vc-session-back"
        @click="props.onBack?.(job)"
      >
        Back to the board
      </RcButton>
    </template>
  </Drawer>
</template>

<style lang="scss" scoped>
.session {
  // Chrome's body is a scrolling box of a definite height; this fills it rather than scrolling
  // inside it, which is what gives the pane below a height to size itself against.
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;

  &__waiting {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  &__id {
    margin-left: 10px;
    font-family: var(--font-family-mono, monospace);
    font-size: 11px;
    font-weight: 400;
    color: var(--muted);
  }

  &__terminal {
    flex: 1 1 auto;
    min-height: 0;
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
    background: var(--body-bg);
  }

  &__note {
    margin: 10px 0 0;
    font-size: 11px;
    color: var(--muted);

    &--ended {
      color: var(--warning);
    }
  }
}
</style>
