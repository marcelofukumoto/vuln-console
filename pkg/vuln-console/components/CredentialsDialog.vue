<script setup lang="ts">
// The GitHub token, set the way Extension Studio sets its own.
//
// Write-only: a token goes in and never comes back out. Nothing here ever reads a Secret's
// `data` - what is on the screen comes from an annotation saying whether one is stored, which is
// why the button says "Replace" rather than showing you what is there.
//
// The token is never sent into a pod from here either. The scripts that need it read it out of
// the Secret with the pod's own ServiceAccount at the moment they need it.
import { computed, ref } from 'vue';
import { Banner } from '@components/Banner';
import Drawer from '@shell/components/Drawer/Chrome.vue';
import RcButton from '@components/RcButton/RcButton.vue';
import { readCredentialStatus, saveCredentials } from '../lib/credentials';
import type { CredentialStatus } from '../lib/credentials';

const props = defineProps<{ status: CredentialStatus }>();

const emit = defineEmits<{
  (e: 'saved', status: CredentialStatus): void;
  (e: 'close'): void;
}>();

const token = ref('');
const saving = ref(false);
const error = ref('');

const stored = computed(() => props.status.gh);

async function save(): Promise<void> {
  if (!token.value) {
    return;
  }

  saving.value = true;
  error.value = '';

  try {
    await saveCredentials({ ghToken: token.value });
    token.value = '';
    emit('saved', await readCredentialStatus());
    emit('close');
  } catch (e: any) {
    error.value = e?.message || String(e);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <Drawer aria-target="the GitHub token this extension uses" @close="emit('close')">
    <template #title>
      Credentials
    </template>

    <template #body>
      <Banner v-if="error" color="error">
        {{ error }}
      </Banner>

      <Banner v-if="stored === 'studio'" color="info">
        Using Extension Studio's GitHub token. Setting one here makes this extension use that one
        instead — worth doing only if it should differ.
      </Banner>
      <Banner v-else-if="stored === 'ours'" color="success">
        A GitHub token is stored for this extension.
      </Banner>
      <Banner v-else color="warning">
        No GitHub token is stored, so the board cannot be refreshed and nothing can be fixed.
      </Banner>

      <label class="creds__label" for="vc-gh-token">GitHub token</label>
      <input
        id="vc-gh-token"
        v-model="token"
        type="password"
        class="creds__input"
        autocomplete="off"
        data-testid="vc-gh-token"
        :placeholder="stored === 'none' ? 'ghp_…' : 'enter a new token to replace the stored one'"
      >

      <p class="creds__note">
        It needs to read Dependabot alerts and open pull requests on the fork: the
        <code>repo</code> and <code>security_events</code> scopes on a classic token, or
        read access to Dependabot alerts plus read and write to contents and pull requests on a
        fine-grained one.
      </p>
      <p class="creds__note">
        It is stored in a Secret and read by the pod that needs it. This page never reads it back.
      </p>
    </template>

    <template #additional-actions>
      <RcButton variant="primary" :disabled="!token || saving" data-testid="vc-save-token" @click="save">
        <span>{{ saving ? 'Saving…' : (stored === 'ours' ? 'Replace' : 'Save') }}</span>
      </RcButton>
    </template>
  </Drawer>
</template>

<style lang="scss" scoped>
.creds {
  &__label {
    display: block;
    margin: 16px 0 4px;
    font-weight: 600;
  }

  &__input {
    width: 100%;
  }

  &__note {
    margin: 12px 0 0;
    font-size: 12px;
    color: var(--muted);
  }
}
</style>
