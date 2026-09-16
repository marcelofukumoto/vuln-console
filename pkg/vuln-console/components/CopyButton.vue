<script setup lang="ts">
// Copy one suggested comment.
//
// The whole point of the suggested comments is that they are pasted into Jira or GitHub
// unedited, so the button is beside every one of them and says when it has worked - a copy that
// looks like nothing happened is a copy somebody does twice and then checks by hand.
import { onBeforeUnmount, ref } from 'vue';

const props = withDefaults(defineProps<{
  text: string;
  label?: string;
}>(), { label: 'Copy' });

const state = ref<'idle' | 'copied' | 'failed'>('idle');
let reset: ReturnType<typeof setTimeout> | null = null;

function flash(next: 'copied' | 'failed') {
  state.value = next;

  if (reset) {
    clearTimeout(reset);
  }

  reset = setTimeout(() => {
    state.value = 'idle';
    reset = null;
  }, 1800);
}

/**
 * The clipboard API needs a secure context, and a Rancher reached over plain http on an IP is
 * not one - so there is a fallback rather than a button that silently does nothing there.
 */
async function copy() {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(props.text);
      flash('copied');

      return;
    }
  } catch {
    /* fall through to the textarea */
  }

  try {
    const scratch = document.createElement('textarea');

    scratch.value = props.text;
    scratch.setAttribute('readonly', '');
    scratch.style.position = 'fixed';
    scratch.style.opacity = '0';
    document.body.appendChild(scratch);
    scratch.select();
    const ok = document.execCommand('copy');

    document.body.removeChild(scratch);
    flash(ok ? 'copied' : 'failed');
  } catch {
    flash('failed');
  }
}

onBeforeUnmount(() => {
  if (reset) {
    clearTimeout(reset);
  }
});
</script>

<template>
  <button
    type="button"
    class="copy-button"
    :class="state"
    :data-testid="'idr-copy'"
    :title="state === 'failed' ? 'Could not reach the clipboard — select the text and copy it' : 'Copy to the clipboard'"
    @click="copy"
  >
    <i
      class="icon"
      :class="state === 'copied' ? 'icon-checkmark' : state === 'failed' ? 'icon-warning' : 'icon-copy'"
    />
    <span>{{ state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label }}</span>
  </button>
</template>

<style lang="scss" scoped>
.copy-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: var(--body-bg);
  color: var(--body-text);
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
  transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease;

  &:hover {
    background: var(--accent-btn);
    border-color: var(--link);
    color: var(--link);
  }

  &.copied {
    border-color: var(--success);
    color: var(--success);
    background: var(--body-bg);
  }

  &.failed {
    border-color: var(--error);
    color: var(--error);
  }

  .icon {
    font-size: 13px;
  }
}
</style>
