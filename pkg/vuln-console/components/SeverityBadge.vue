<script setup lang="ts">
// A severity, as Rancher draws a state.
//
// BadgeState rather than a hand-rolled span: it is the shape the dashboard already uses for
// every state it shows, so a severity here reads as the same kind of thing as a pod's state two
// pages over. The colours are Rancher's status variables, not picked ones - `critical` and
// `high` are the same red the dashboard uses for error, `medium` its warning amber.
import { computed } from 'vue';
import BadgeState from '@components/BadgeState/BadgeState.vue';
import type { Severity } from '../types';

const props = defineProps<{ severity: Severity }>();

const COLOURS: Record<Severity, string> = {
  critical: 'bg-error',
  high:     'bg-error',
  medium:   'bg-warning',
  low:      'bg-info',
};

const colour = computed(() => COLOURS[props.severity] || 'bg-info');
const label = computed(() => props.severity.toUpperCase());
</script>

<template>
  <BadgeState
    :color="colour"
    :label="label"
    class="severity"
    :class="`severity--${ severity }`"
  />
</template>

<style lang="scss" scoped>
.severity {
  // The four sit in one column and are read by shape as much as by colour, so they are one
  // width rather than as wide as their word.
  min-width: 74px;
  justify-content: center;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;

  // Critical and high share Rancher's error red, which would make them one thing at a glance on
  // a board whose whole job is to be triaged top-down. High is the same hue, stepped back.
  &--high {
    opacity: 0.72;
  }
}
</style>
