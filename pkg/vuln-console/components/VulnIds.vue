<script setup lang="ts">
// The alert numbers behind one row.
//
// The board groups by LIBRARY because that is what a fix acts on - you bump a package, not an
// advisory - but the alert is still the thing GitHub tracks and closes, so every one of them is
// here and links to itself. A closed one is struck through rather than removed: a row in the
// shipped list is precisely a set of alerts that closed.
import { computed } from 'vue';
import { alertUrl } from '../types';
import type { Alert } from '../types';

const props = defineProps<{ vulns: Alert[]; repo: string }>();

const chips = computed(() => props.vulns.map((v) => ({
  id:     v.id,
  url:    alertUrl(props.repo, v.id),
  fixed:  v.state !== 'open',
  class:  v.state !== 'open' ? 'vuln-id--fixed' : `vuln-id--${ v.severity }`,
  title:  [v.ghsa, v.manifest, v.patched ? `needs ${ v.patched }` : 'no fix published', v.state]
    .filter(Boolean).join(' · '),
})));
</script>

<template>
  <div class="vuln-ids">
    <a
      v-for="chip in chips"
      :key="chip.id"
      class="vuln-id"
      :class="chip.class"
      :href="chip.url"
      target="_blank"
      rel="noopener"
      :title="chip.title"
    >#{{ chip.id }}</a>
  </div>
</template>

<style lang="scss" scoped>
.vuln-ids {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.vuln-id {
  padding: 1px 6px;
  border: 1px solid var(--border);
  border-radius: 10px;
  font-family: var(--font-family-mono, monospace);
  font-size: 11px;
  line-height: 16px;
  text-decoration: none;
  color: var(--body-text);

  &--critical,
  &--high {
    border-color: var(--error);
    color: var(--error);
  }

  &--medium {
    border-color: var(--warning);
  }

  &--fixed {
    border-style: dashed;
    color: var(--muted);
    text-decoration: line-through;
  }
}
</style>
