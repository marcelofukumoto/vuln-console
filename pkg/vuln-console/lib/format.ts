// Turning a run into the few words a row shows about it.
//
// Deliberately the same shape as the report console's `lib/format.ts` - the same `elapsedLabel`,
// the same `PHASE_LABEL` map read by the same `RunProgress` component - so the two extensions
// describe a run in progress in the same words, in the same places, and somebody who has used
// one already knows this one.
import type { Job } from '../types';

/** How long a run has been going, for the strip above the board. */
export function elapsedLabel(job: Job, now = Date.now()): string {
  const started = job.startedAt;

  if (!started) {
    return '';
  }

  const end = job.phase === 'Running' ? now : job.updatedAt || now;
  const seconds = Math.max(0, Math.round((end - started) / 1000));

  if (seconds < 60) {
    return `${ seconds }s`;
  }

  const minutes = Math.floor(seconds / 60);

  return minutes < 60 ? `${ minutes }m ${ seconds % 60 }s` : `${ Math.floor(minutes / 60) }h ${ minutes % 60 }m`;
}

/**
 * Where a run has got to, read off what it has recorded rather than off its terminal.
 *
 * The pane's last few lines are whatever claude happened to print - a tool call, a token count,
 * a half-drawn spinner - which is honest but says nothing about progress, and reading progress
 * out of prose is guessing. What the run has written down says it exactly: a branch exists or it
 * does not, a recording exists or it does not.
 */
export type RunPhase = 'starting' | 'fixing' | 'verifying' | 'recording';

export const RUN_PHASES: RunPhase[] = ['starting', 'fixing', 'verifying', 'recording'];

export const PHASE_LABEL: Record<string, string> = {
  starting:  'Starting the agent',
  fixing:    'Bumping and regenerating the lockfiles',
  verifying: 'Serving the branch and checking it',
  recording: 'Recording the verification',
};

export function runPhase(job: Job): RunPhase {
  if (!job.sessionId) {
    return 'starting';
  }

  if (!job.branch) {
    return 'fixing';
  }

  return job.videoUrl ? 'recording' : 'verifying';
}
