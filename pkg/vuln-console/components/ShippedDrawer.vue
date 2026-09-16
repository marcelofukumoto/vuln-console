<script setup lang="ts">
// What we have already fixed.
//
// Kept rather than dropped, and behind a drawer rather than in the table, because it answers a
// different question: the table is "what is open", this is "what did we ship". An alert only
// arrives here when GitHub actually closed it - a merged pull request of ours is evidence, not
// proof, and the rule that treated it as proof once hid three of five open alerts.
import Drawer from '@shell/components/Drawer/Chrome.vue';
import { RcStatusBadge } from '@components/Pill';
import VulnIds from './VulnIds.vue';
import { severityStatus } from '../lib/ledger';
import type { VulnGroup } from '../types';

defineProps<{
  rows: VulnGroup[];
  repo: string;
  /**
   * The drawer's own configuration, declared so it is consumed rather than set as an attribute.
   *
   * SlideInPanelManager passes its config into the component it mounts. Anything not declared as
   * a prop falls through to the root element and becomes a real DOM attribute - which is how a
   * `width="wide"` once ended up on a div.
   */
  width?: string;
  height?: string;
  triggerFocusTrap?: boolean;
  closeOnRouteChange?: string[];
}>();

const emit = defineEmits<{ (e: 'close'): void }>();
</script>

<template>
  <Drawer aria-target="the vulnerabilities we have fixed" @close="emit('close')">
    <template #title>
      Shipped
    </template>

    <template #body>
      <p class="shipped__sub">
        Fixes of ours that merged and whose Dependabot alert has since closed. They age out of
        this list on their own as GitHub stops reporting them.
      </p>

      <p v-if="!rows.length" class="shipped__empty">
        Nothing shipped yet.
      </p>

      <div v-for="row in rows" :key="row.library" class="shipped__row">
        <RcStatusBadge :status="severityStatus(row.severity)">
          {{ row.severity }}
        </RcStatusBadge>
        <div class="shipped__body">
          <div class="shipped__lib">{{ row.library }}</div>
          <VulnIds :vulns="row.vulns" :repo="repo" />
        </div>
        <a v-if="row.pr" class="shipped__pr" :href="row.pr.url" target="_blank" rel="noopener">
          {{ row.pr.number }}
        </a>
      </div>
    </template>
  </Drawer>
</template>

<style lang="scss" scoped>
.shipped {
  &__sub {
    margin: 0 0 16px;
    color: var(--muted);
  }

  &__empty {
    color: var(--muted);
  }

  &__row {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 10px 0;
    border-bottom: 1px solid var(--border);
  }

  &__body {
    flex: 1 1 auto;
    min-width: 0;
  }

  &__lib {
    font-weight: 600;
    margin-bottom: 4px;
  }

  &__pr {
    white-space: nowrap;
  }
}
</style>
