<script setup lang="ts">
// A pane onto one of the agent pod's conversations, drawn by the Agents extension's own
// terminal.
//
// Modelled on dev-extension's StudioTerminal, which is the established way to place one of
// these: borrow the component that extension puts on `window`, say what it should run, and own
// none of the terminal itself - not the socket protocol, not the reconnect, not the image paste
// or the clickable paths. There is one terminal in this dashboard and one place it is fixed.
//
// Two things here are less obvious than they look and both come from that precedent:
//
//   - the API is *awaited*, not read. Extensions load in whatever order Rancher loaded them, so
//     a page of this one can render before the Agents bundle has installed anything. Reading
//     once at mount reports "not installed" for an extension that is merely slower.
//   - the argv is passed explicitly rather than left to the `session` prop's default. It is the
//     same argv either way today; saying it means this pane does not change meaning if that
//     default ever does.
import { computed, onMounted, ref } from 'vue';
import { Banner } from '@components/Banner';
import { whenAgentsReady } from '../lib/agents';
import type { AgentsApi } from '../lib/agents';

const props = withDefaults(defineProps<{
  session: string;
  mode?: 'claude' | 'shell';
}>(), { mode: 'claude' });

const emit = defineEmits<{ (e: 'state', value: string): void }>();

/** The API once its bundle has loaded; null while waiting, and `waited` once we have given up. */
const api = ref<AgentsApi | null>(null);
const waited = ref(false);

const terminal = computed(() => api.value?.terminal?.component || null);
const argv = computed(() => (api.value && props.session ? api.value.agent.command(props.session, props.mode) : null));
const missing = computed(() => waited.value && !terminal.value);

onMounted(async() => {
  api.value = await whenAgentsReady(15000);
  waited.value = true;

  if (!api.value) {
    emit('state', 'closed');
  }
});
</script>

<template>
  <div class="agent-terminal">
    <Banner v-if="missing" color="warning" class="agent-terminal__missing">
      Nothing here draws a terminal: install the <b>Agents</b> extension, which brings the agent
      pod and the terminal every extension borrows, then reload.
    </Banner>

    <component
      :is="terminal"
      v-else-if="terminal && argv"
      :session="session"
      :command="argv"
      :mode="mode"
      class="agent-terminal__pane"
      @state="emit('state', $event)"
    />

    <div v-else class="agent-terminal__waiting">
      <i class="icon icon-spinner icon-spin" />
      <span>Waiting for the Agents extension…</span>
    </div>
  </div>
</template>

<style lang="scss" scoped>
// The pane sizes itself to what contains it, so every box down to it has to be a flex column
// that is allowed to shrink. `min-height: 0` is the load-bearing part: without it a flex child
// refuses to go below its content's height and the terminal grows the page instead of scrolling.
.agent-terminal {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;

  &__pane {
    flex: 1 1 auto;
    min-height: 0;
  }

  &__waiting {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 16px;
    color: var(--muted);
    font-size: 13px;
  }
}
</style>
