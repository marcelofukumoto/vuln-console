<script setup lang="ts">
// What can be done to one row, and what has already been done to it.
//
// This is the board's state machine and it is the part worth keeping exactly as it was: colour
// says state, and a step that has produced something stops being a button and becomes a link to
// the thing it produced. Blue is available, grey is blocked, green is done, and a run in flight
// shows what it is doing.
//
// The order is the order the work happens in - fix, pull request, recording - followed by what
// only exists once there is a pull request. A step is not offered before its prerequisite: you
// cannot open a pull request for a fix that does not exist, and the button says so by being
// absent rather than by failing when pressed.
import { computed } from 'vue';
import RcButton from '@components/RcButton/RcButton.vue';
import { RcStatusBadge } from '@components/Pill';
import { isStalled } from '../lib/run';
import type { Job, JobAction, VulnGroup } from '../types';

const props = defineProps<{
  row: VulnGroup;
  job: Job | null;
  /** Where this board's branches are pushed, so the branch pill links to the right fork. */
  fork: string;
  /** The package this repository gets most of its tree from, when it has one. */
  /** True while this row's own run is going. */
  busy: boolean;
}>();

const emit = defineEmits<{
  (e: 'act', action: JobAction): void;
  (e: 'stop'): void;
  (e: 'session'): void;
}>();

const job = computed(() => props.job);
const running = computed(() => job.value?.phase === 'Running' && !isStalled(job.value));
const stalled = computed(() => !!job.value && isStalled(job.value));

/**
 * What already exists for this row, from EITHER a run we recorded or the pull request the
 * ledger found.
 *
 * Both, deliberately. A job is what this extension remembers; the ledger is what GitHub says.
 * Reading only the job meant a library with an open pull request of ours - attributed, sitting
 * in the in-flight list, its number shown two columns to the left - still offered a Fix button,
 * because no job record happened to exist in this cluster. That is an invitation to open a
 * second pull request for something already in review, and the old console avoided it by
 * falling back to the same place.
 *
 * The job wins where both have an answer: it is this run's own record and it is newer.
 */
const pr = computed(() => {
  if (job.value?.prUrl) {
    return { url: job.value.prUrl, number: job.value.prNumber };
  }

  const found = props.row.pr;

  return found?.status === 'open' ? { url: found.url, number: found.number } : null;
});

const branch = computed(() => job.value?.branch || (props.row.pr?.status === 'open' ? props.row.pr.headRefName : null) || null);

/**
 * A recording already attached to the pull request counts as published.
 *
 * It survives losing our own record of the run - the pull request is the durable copy - so the
 * pill is a link to the recording rather than a stale offer to make one.
 */
const video = computed(() => job.value?.videoUrl || props.row.pr?.videoUrl || null);
/** On the pull request, where a reviewer sees it without leaving the diff. The end state. */
const attached = computed(() => /user-attachments/.test(video.value || ''));

/**
 * Watchable, but only from here: served by the workspace's dev server through the Rancher proxy.
 *
 * Worth distinguishing from attached, because it dies with the workspace - it is something to
 * look at before deciding to publish, not somewhere to leave it.
 */
const watchable = computed(() => !attached.value && /^https?:\/\//.test(video.value || ''));

/**
 * Nothing is offered for a row with no fix available.
 *
 * Every alert in it lacks a patched version, so there is no version to bump to - a Fix button
 * here would start a run that can only fail.
 */
const unfixable = computed(() => props.row.unfixable);

/**
 * A row here always belongs to something this repository can fix.
 *
 * Rows that arrive through a Rancher package are drawn by the board itself, under that
 * package's group, with one button for the whole group - so StepPills is never asked about
 * them. What used to be here was a "Comes from @rancher/shell" badge on a row filed under a
 * single owner; grouping says the same thing in a place where it is also actionable, and says
 * it for every package that reaches the library rather than just one.
 */
const branchUrl = computed(() => (branch.value ? `https://github.com/${ props.fork }/tree/${ branch.value }` : null));
</script>

<template>
  <div class="steps">
    <RcStatusBadge
      v-if="unfixable"
      status="unknown"
      title="No patched version is available — Dependabot has no fix for this advisory, so there is nothing to bump to."
    >
      No fix published
    </RcStatusBadge>

    <template v-else-if="!ownedElsewhere">
      <!-- A run in flight: what it is doing, and the way out of it. -->
      <template v-if="running">
        <RcButton variant="secondary" size="small" @click="emit('session')">
          <i class="icon icon-spinner icon-spin" />
          <span>{{ job?.action === 'fix' ? 'Fixing' : 'Working' }}…</span>
        </RcButton>
        <RcButton variant="secondary" size="small" data-testid="vc-stop" @click="emit('stop')">
          <span>Stop</span>
        </RcButton>
      </template>

      <!-- A run that stopped saying anything. Not spun forever: it can be stopped. -->
      <template v-else-if="stalled">
        <RcStatusBadge
          status="warning"
          title="This run has not reported for a while. The tab that started it may have been closed, or its pod replaced."
        >
          Stalled
        </RcStatusBadge>
        <RcButton variant="secondary" size="small" @click="emit('session')">
          <span>Session</span>
        </RcButton>
        <RcButton variant="secondary" size="small" @click="emit('stop')">
          <span>Stop</span>
        </RcButton>
      </template>

      <template v-else>
        <!-- Fix, or the branch it produced. -->
        <a v-if="branchUrl" class="steps__link" :href="branchUrl" target="_blank" rel="noopener" :title="`fork branch: ${ branch }`">
          <RcStatusBadge status="success">{{ branch }}</RcStatusBadge>
        </a>
        <RcButton v-else variant="primary" size="small" :disabled="busy" data-testid="vc-fix" @click="emit('act', 'fix')">
          <span>Fix</span>
        </RcButton>

        <!-- The pull request, once there is something to open one for. -->
        <a v-if="pr" class="steps__link" :href="pr.url" target="_blank" rel="noopener">
          <RcStatusBadge status="success">Pull request {{ pr.number }}</RcStatusBadge>
        </a>
        <RcButton v-else-if="branch" variant="secondary" size="small" :disabled="busy" @click="emit('act', 'pr')">
          <span>Create pull request</span>
        </RcButton>

        <!--
          The recording, in three states. A STAGED one is a file inside the workspace, not a
          URL - so it is shown as a fact, never as a link, because a `/workspaces/...` path in an
          href is a link that goes nowhere. It used to fall through to offering Record again,
          which hid a recording that had just taken ninety seconds to make.
        -->
        <a v-if="attached" class="steps__link" :href="video || '#'" target="_blank" rel="noopener">
          <RcStatusBadge status="success">Recording</RcStatusBadge>
        </a>
        <template v-else-if="watchable">
          <a
            class="steps__link"
            :href="video || '#'"
            target="_blank"
            rel="noopener"
            title="served by this fix's workspace — watch it before deciding to publish it"
          >
            <RcStatusBadge status="success">Watch recording</RcStatusBadge>
          </a>
          <RcButton variant="link" size="small" :disabled="busy" @click="emit('act', 'record')">
            <span>Re-record</span>
          </RcButton>
        </template>
        <template v-else-if="video">
          <RcStatusBadge status="warning" :title="`recorded at ${ video }, which is a path inside the workspace rather than a link`">
            Recorded, not served
          </RcStatusBadge>
          <RcButton variant="link" size="small" :disabled="busy" @click="emit('act', 'record')">
            <span>Re-record</span>
          </RcButton>
        </template>
        <RcButton v-else-if="branch || pr" variant="secondary" size="small" :disabled="busy" @click="emit('act', 'record')">
          <span>Record</span>
        </RcButton>

        <!-- Only once a pull request exists. -->
        <template v-if="pr">
          <RcButton variant="secondary" size="small" :disabled="busy" @click="emit('act', 'addresscomment')">
            <span>Address comments</span>
          </RcButton>
          <RcButton variant="secondary" size="small" :disabled="busy" @click="emit('act', 'resolveconflict')">
            <span>Rebase</span>
          </RcButton>
        </template>

        <a
          v-if="job?.replyUrl"
          class="steps__link"
          :href="job.replyUrl"
          target="_blank"
          rel="noopener"
          title="the per-point reply this run staged — read it here and post it yourself; the console never comments for you"
        >
          <RcStatusBadge status="info">Reply draft</RcStatusBadge>
        </a>

        <RcButton v-if="job?.sessionId" variant="link" size="small" @click="emit('session')">
          <span>Session</span>
        </RcButton>
      </template>
    </template>
  </div>
</template>

<style lang="scss" scoped>
.steps {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;

  // The badge carries the colour and the shape; the anchor only makes it clickable, so it must
  // not add an underline or a link colour of its own on top.
  &__link {
    text-decoration: none;
    max-width: 260px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}
</style>
