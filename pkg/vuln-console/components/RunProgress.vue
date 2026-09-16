<script setup lang="ts">
// What a run is doing, while it does it.
//
// The four steps are read off what the run has recorded, not off the terminal, so this says
// where the run actually is rather than what claude last printed.
//
// For the times when the steps are not enough - a run that has stalled, or curiosity about how
// it reached a recommendation - there is the session itself, live and interactive. That replaced
// a disclosure showing the last few lines of scrollback: six lines of terminal was the least
// readable thing on the page, and the whole conversation is better than a tail of it.
import { computed } from 'vue';
import { PHASE_LABEL, RUN_PHASES } from '../lib/format';
import type { RunPhase } from '../lib/format';

const props = defineProps<{
  phase: RunPhase;
  elapsed: string;
  /** Absent when the run has no conversation to open yet. */
  canOpenSession?: boolean;
}>();

defineEmits<{ (e: 'open-session'): void }>();

const steps = computed(() => {
  const at = RUN_PHASES.indexOf(props.phase);

  return RUN_PHASES.map((phase, i) => ({
    phase,
    label: PHASE_LABEL[phase] || phase,
    state: i < at ? 'done' : i === at ? 'active' : 'todo',
  }));
});
</script>

<template>
  <div class="progress" data-testid="vc-progress">
    <ol class="progress__steps">
      <li
        v-for="step in steps"
        :key="step.phase"
        class="progress__step"
        :class="`is-${ step.state }`"
      >
        <span class="progress__marker">
          <i v-if="step.state === 'done'" class="icon icon-checkmark" />
          <i v-else-if="step.state === 'active'" class="icon icon-spinner icon-spin" />
        </span>
        <span class="progress__label">{{ step.label }}</span>
      </li>
    </ol>

    <div class="progress__foot">
      <span class="progress__elapsed">{{ elapsed }}</span>
      <button
        v-if="canOpenSession"
        type="button"
        class="progress__toggle"
        data-testid="vc-open-session"
        @click.stop="$emit('open-session')"
      >
        <i class="icon icon-terminal" />
        Watch the agent
      </button>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.progress {
  margin-top: 10px;

  &__steps {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 4px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  &__step {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px 3px 6px;
    border-radius: 12px;
    font-size: 11px;
    color: var(--muted);
    background: var(--nav-bg);

    // A chevron between steps rather than a connecting rail, which would have to survive the
    // steps wrapping onto a second line at narrow widths.
    & + & {
      position: relative;
      margin-left: 8px;

      &::before {
        content: '›';
        position: absolute;
        left: -10px;
        color: var(--muted);
        opacity: 0.6;
      }
    }

    &.is-done {
      color: var(--success);
    }

    &.is-active {
      color: var(--body-text);
      background: var(--accent-btn);
      font-weight: 600;
    }

    &.is-todo {
      opacity: 0.55;
    }
  }

  &__marker {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 13px;
    height: 13px;

    .icon {
      font-size: 11px;
    }
  }

  // A step not yet reached still needs its marker's width, or the labels jump left as each one
  // completes.
  &__step.is-todo &__marker::before {
    content: '';
    width: 5px;
    height: 5px;
    border-radius: 50%;
    border: 1px solid currentColor;
  }

  &__foot {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 8px;
    font-size: 11px;
    color: var(--muted);
  }

  &__elapsed {
    font-variant-numeric: tabular-nums;
  }

  &__toggle {
    border: none;
    background: transparent;
    color: var(--link);
    font-size: 11px;
    cursor: pointer;
    padding: 0;
    display: inline-flex;
    align-items: center;
    gap: 4px;

    &:hover {
      text-decoration: underline;
    }
  }
}
</style>
