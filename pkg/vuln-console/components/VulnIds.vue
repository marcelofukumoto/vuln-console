<script setup lang="ts">
// The alert numbers behind one row.
//
// The board groups by LIBRARY because that is what a fix acts on - you bump a package, not an
// advisory - but the alert is still the thing GitHub tracks and closes, so every one of them is
// here and links to itself. A closed one is drawn as `success` rather than removed: a row in the
// shipped list is precisely a set of alerts that closed.
import { computed } from 'vue';
import { RcStatusBadge } from '@components/Pill';
import { severityStatus } from '../lib/ledger';
import { alertUrl } from '../types';
import type { Alert } from '../types';

const props = defineProps<{ vulns: Alert[]; repo: string }>();

const chips = computed(() => props.vulns.map((v) => ({
  id:     v.id,
  url:    alertUrl(props.repo, v.id),
  status: v.state === 'open' ? severityStatus(v.severity) : 'success' as const,
  title:  [
    v.ghsa,
    v.manifest,
    v.patched ? `needs ${ v.patched }` : 'no fix published',
    v.state === 'open' ? 'open' : 'closed',
  ].filter(Boolean).join(' · '),
})));
</script>

<template>
  <div class="vuln-ids">
    <a
      v-for="chip in chips"
      :key="chip.id"
      class="vuln-ids__link"
      :href="chip.url"
      target="_blank"
      rel="noopener"
      :title="chip.title"
    >
      <RcStatusBadge :status="chip.status">{{ chip.id }}</RcStatusBadge>
    </a>
  </div>
</template>

<style lang="scss" scoped>
.vuln-ids {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;

  // The badge carries the colour and the shape; the anchor only makes it clickable, so it must
  // not add an underline or a link colour of its own on top.
  &__link {
    text-decoration: none;
  }
}
</style>
