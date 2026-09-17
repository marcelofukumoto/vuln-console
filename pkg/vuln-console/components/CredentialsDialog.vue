<script setup lang="ts">
// The GitHub token this console needs, managed the way Extension Studio manages its own.
//
// The same modal as the reports console's, deliberately: same backdrop, same field, same peek
// button, same "Stored"/"Not set" marker, same pair of buttons at the foot. One of these two
// extensions asking for a token should look like the other one asking for a token.
//
// Stored once rather than typed per run, and stored write-only: a credential goes into a Secret
// and never comes back out to this page. What the page can know is whether one is there, which
// is what decides between "Set" and "Replace" - so the field says "leave blank to keep" instead
// of showing a value somebody could shoulder-read.
//
// It is NOT shared with Extension Studio, which was the first design here: that extension keeps
// one `gh_token` for the whole installation, so borrowing it would mean everybody acting as one
// anonymous account - the thing per-user credentials exist to avoid.
import { computed, onMounted, ref } from 'vue';
import { Banner } from '@components/Banner';
import { saveCredentials } from '../lib/credentials';
import type { CredentialStatus } from '../lib/credentials';
import { ensureGhBrowser, ghBrowserStatus } from '../lib/gh-browser';
import type { GhBrowserStatus } from '../lib/gh-browser';

const props = defineProps<{
  status: CredentialStatus;
  /** Whose token this is. Stored per person, so the dialog is about yours and nobody else's. */
  principalId: string;
  /** True when this opened because a run could not start without it. */
  blocking?: boolean;
  busy?: boolean;
}>();

const emit = defineEmits<{
  (e: 'cancel'): void;
  (e: 'saved'): void;
}>();

const github = ref('');
const showGithub = ref(false);

/**
 * The person's own GitHub browser, which is how a recording gets onto a pull request.
 *
 * Optional on purpose: without one everything works except the automatic attachment, and the
 * console says so rather than failing. Nothing about it is stored - the session lives in that
 * browser's profile - so setting it up is spawning it and signing in, and nothing else.
 */
const browser = ref<GhBrowserStatus>({ state: 'absent', url: '' });
const spawning = ref(false);

async function refreshBrowser() {
  browser.value = await ghBrowserStatus(props.principalId).catch(() => browser.value);
}

async function setUpBrowser() {
  spawning.value = true;
  error.value = '';

  try {
    browser.value = await ensureGhBrowser(props.principalId);

    // It takes a little while to answer; poll rather than making somebody reopen the dialog.
    for (let i = 0; i < 40 && browser.value.state !== 'ready'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await refreshBrowser();
    }
  } catch (e: any) {
    error.value = e?.message || String(e);
  } finally {
    spawning.value = false;
  }
}

onMounted(refreshBrowser);
const saving = ref(false);
const error = ref('');

const ghStored = computed(() => props.status.stored);

/** Nothing typed and nothing missing means there is nothing to do but carry on. */
const ready = computed(() => ghStored.value || !!github.value.trim());

async function save() {
  if (!ready.value || saving.value) {
    return;
  }

  saving.value = true;
  error.value = '';

  try {
    await saveCredentials(props.principalId, github.value.trim());
    github.value = '';
    emit('saved');
  } catch (e: any) {
    error.value = e?.message || String(e);
  } finally {
    saving.value = false;
  }
}

async function clear() {
  saving.value = true;
  error.value = '';

  try {
    await saveCredentials(props.principalId, '');
    emit('saved');
  } catch (e: any) {
    error.value = e?.message || String(e);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="creds-backdrop" @click.self="!saving && !busy && emit('cancel')">
    <div
      class="creds"
      role="dialog"
      aria-modal="true"
      aria-labelledby="vc-creds-title"
      data-testid="vc-credentials"
    >
      <h2 id="vc-creds-title" class="creds__title">
        Credentials
      </h2>

      <p class="creds__lede">
        <template v-if="blocking">
          A fix pushes a branch and opens a pull request, and both are done by <em>you</em> — so
          this needs your own GitHub token. It is stored once — you will not be asked again.
        </template>
        <template v-else>
          Yours, not the installation's: a fix pushes to your fork and the pull request is
          authored by you. Stored in a Secret and read by the pod that needs it — it never comes
          back out to this page, so a stored one can be replaced but not shown.
        </template>
      </p>

      <Banner v-if="error" color="error">
        {{ error }}
      </Banner>

      <label class="creds__field">
        <span class="creds__label">
          GitHub token
          <span class="creds__state" :class="{ 'is-set': ghStored }">
            {{ ghStored ? 'Stored' : 'Not set' }}
          </span>
        </span>
        <span class="creds__hint">
          It reads Dependabot alerts and pushes branches, so: a classic token with
          <code>repo</code> and <code>security_events</code>, or a fine-grained token with
          <em>Dependabot alerts (read)</em> plus <em>Contents</em> and <em>Pull requests</em>
          (read and write) on the fork.
          <template v-if="ghStored"> Leave blank to keep the stored one.</template>
        </span>
        <span class="creds__input">
          <input
            v-model="github"
            :type="showGithub ? 'text' : 'password'"
            autocomplete="off"
            spellcheck="false"
            data-testid="vc-gh-token"
            :placeholder="ghStored ? '••••••••  (stored)' : 'GH_TOKEN'"
            @keyup.enter="save"
          >
          <button type="button" class="creds__peek" :title="showGithub ? 'Hide' : 'Show'" @click="showGithub = !showGithub">
            <i class="icon" :class="showGithub ? 'icon-hide' : 'icon-show'" />
          </button>
        </span>
        <button v-if="ghStored" type="button" class="creds__clear" :disabled="saving" @click="clear()">
          Remove the stored token
        </button>
      </label>

      <label class="creds__field">
        <span class="creds__label">
          GitHub browser
          <span class="creds__state" :class="{ 'is-set': browser.state === 'ready' }">
            {{ browser.state === 'ready' ? 'Running' : browser.state === 'starting' ? 'Starting…' : 'Not set up' }}
          </span>
        </span>
        <span class="creds__hint">
          Only needed to put a verification recording <em>on</em> a pull request. GitHub has no
          API for that — it is a browser flow — so this spawns a browser of your own, you sign it
          in to GitHub once, and uploads go through it as you. Nothing is stored: the session
          lives in that browser.
          <template v-if="browser.state === 'absent'">
            Without one, recordings are still made — you attach them yourself.
          </template>
        </span>

        <span class="creds__browser">
          <button
            v-if="browser.state === 'absent'"
            type="button"
            class="btn role-secondary"
            :disabled="spawning"
            data-testid="vc-spawn-browser"
            @click.prevent="setUpBrowser"
          >
            {{ spawning ? 'Starting it…' : 'Set up my GitHub browser' }}
          </button>
          <template v-else>
            <a
              class="btn role-secondary"
              :href="browser.url"
              target="_blank"
              rel="noopener"
              data-testid="vc-open-browser"
            >Open it and sign in to GitHub</a>
            <span v-if="browser.state === 'starting'" class="creds__hint">
              still starting — the link works once it is up
            </span>
          </template>
        </span>
      </label>

      <Banner color="info" class="creds__note">
        Written straight into the Secret under a key of your own and never read back by this
        page — replacing it is possible, seeing it is not. Saving touches your key alone, so
        nobody else's token is read or rewritten. The pod reads it with its own ServiceAccount at
        the moment it is needed.
      </Banner>

      <div class="creds__actions">
        <button type="button" class="btn role-secondary" :disabled="saving || busy" @click="emit('cancel')">
          {{ blocking ? 'Cancel' : 'Close' }}
        </button>
        <button
          type="button"
          class="btn role-primary"
          :disabled="!ready || saving || busy"
          data-testid="vc-creds-confirm"
          @click="save"
        >
          {{ saving ? 'Saving…' : busy ? 'Starting…' : blocking ? 'Save and fix' : 'Save' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
// Rancher's global `code` style is built for blocks: its padding turns a token name used
// mid-sentence into a tall box that breaks the line it is on. Inline code here is a word.
:deep(code) {
  padding: 1px 5px;
  font-size: 0.92em;
  line-height: inherit;
  vertical-align: baseline;
  border-radius: 3px;
}

.creds-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.5);
}

.creds {
  width: 100%;
  max-width: 580px;
  max-height: 90vh;
  overflow-y: auto;
  padding: 24px;
  border-radius: 8px;
  background: var(--body-bg);
  border: 1px solid var(--border);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.35);

  &__title {
    margin: 0 0 8px;
    font-size: 20px;
  }

  &__lede {
    margin: 0 0 20px;
    color: var(--muted);
    font-size: 13px;
    line-height: 19px;
  }

  &__field {
    display: block;
    margin-bottom: 18px;
  }

  &__label {
    display: flex;
    align-items: center;
    gap: 10px;
    font-weight: 600;
    font-size: 13px;
    margin-bottom: 2px;
  }

  &__state {
    padding: 1px 8px;
    border-radius: 10px;
    border: 1px solid var(--border);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);

    &.is-set {
      color: var(--success);
      border-color: var(--success);
    }
  }

  &__hint {
    display: block;
    color: var(--muted);
    font-size: 12px;
    line-height: 17px;
    margin-bottom: 6px;

    em {
      font-style: normal;
      color: var(--body-text);
    }
  }

  &__input {
    display: flex;
    align-items: stretch;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--input-bg);
    overflow: hidden;

    &:focus-within {
      border-color: var(--link);
    }

    input {
      flex: 1;
      min-width: 0;
      padding: 8px 10px;
      border: none;
      outline: none;
      background: transparent;
      color: var(--input-text);
      font-family: var(--font-family-mono, monospace);
      font-size: 13px;
    }
  }

  &__peek {
    border: none;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    padding: 0 10px;

    &:hover {
      color: var(--body-text);
    }
  }

  &__clear {
    margin-top: 6px;
    border: none;
    background: transparent;
    padding: 0;
    color: var(--error);
    font-size: 11px;
    cursor: pointer;

    &:hover {
      text-decoration: underline;
    }
  }

  &__browser {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 8px;
    flex-wrap: wrap;
  }

  &__note {
    font-size: 12px;
    line-height: 18px;
  }

  &__actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-top: 20px;
  }
}
</style>
