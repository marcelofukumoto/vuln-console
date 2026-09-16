// One action on one library, from the button to the row.
//
// There is no watcher. The console this replaces had a 710-line shell loop on somebody's laptop
// that polled a file in a pod for new requests, spawned `claude -p`, and blocked inside that
// call for the whole run - which is why it needed a second thread for refreshes, a mkdir mutex
// between them, a cursor file so a pod restart did not replay every click ever made, and a
// heartbeat subshell that was the only thing left alive to handle a Stop. None of that exists
// here: the conversation runs in the agents pod, the extension asks for it, and the cluster
// holds the state.
//
// The shape of a run:
//
//   1. a job is written first, saying Running. A run that dies before the agent is asked still
//      leaves a row that says so, rather than a button that does nothing.
//   2. the workspace is made if it is not there - an apps-plus installation, one per library.
//   3. this extension's scripts and the prompt for the action go into the agents pod. That pod
//      belongs to the agents extension and is built from its seed, not ours, so every run puts
//      the current copy there.
//   4. a conversation is started with an opening prompt, and its pane is started detached with
//      CLAUDE_CODE_SHELL_PREFIX pointing at the workspace. claude runs in the agents pod; every
//      command it runs lands in the workspace pod, at the same path.
//   5. the agent works, and records what it did by writing the job back.
import { agentProject, agentsApi } from './agents';
import { podExec, podRunScript, podWriteFile, shellQuote } from './exec';
import type { PodRef } from './exec';
import { readJobs, writeJob } from './store';
import { ensureWorkspace, workspaceName } from './workspace';
import type { Store } from './workspace';
import { SEED_FILES } from '../seed.generated';
import { FORK_REPO, PR_TARGET_REPO, STALE_RUN_MS, UPSTREAM_REPO, WORKSPACES_ROOT } from '../config/constants';
import type { Job, JobAction, VulnGroup } from '../types';

/** Where this extension keeps its scripts inside the agents pod. */
const ROOT = '/workspace/.vuln-console';

/** The agents pod's own user. Everything the pane touches has to belong to it. */
const POD_USER = '1000:1000';

/** Where every conversation in the agents pod runs, and the home it runs with. */
const CONVERSATIONS = '/workspace/conversations';
const AGENT_HOME = '/workspace/.home';

/** The prompt file each action is driven by. */
const PROMPTS: Record<JobAction, string> = {
  fix:             'fix.prompt.md',
  pr:              'pr.prompt.md',
  record:          'record.prompt.md',
  publish:         'publish.prompt.md',
  addresscomment:  'address-comments.prompt.md',
  resolveconflict: 'resolve-conflict.prompt.md',
};

const VERBS: Record<JobAction, string> = {
  fix:             'Fix',
  pr:              'Open the pull request for',
  record:          'Record the verification for',
  publish:         'Attach the recording for',
  addresscomment:  'Address the review comments on',
  resolveconflict: 'Rebase',
};

function agentTarget(pod: string): PodRef {
  const api = agentsApi();

  return {
    pod,
    namespace: api?.agent.namespace || 'extension-studio',
    container: api?.agent.container || 'agent',
  };
}

/**
 * The wrapper that puts every command the agent runs into the workspace pod.
 *
 * This is the whole of how one claude in one pod does its work in another. claude runs each
 * command through `$CLAUDE_CODE_SHELL_PREFIX`, so pointing that at a `kubectl exec` into the
 * workspace means the agent's `yarn`, `git` and `node` all happen where the checkout is - and
 * the paths are identical on both sides, so nothing has to be translated.
 *
 * KUBECONFIG=/dev/null on purpose: act as the pod's ServiceAccount, not as the Rancher identity
 * of whoever last opened a terminal here, which expires.
 */
function shellWrapper(workspace: string): string {
  return [
    '#!/bin/sh',
    '# Written by the vulnerability console. Runs one command inside a fix workspace.',
    'set -e',
    `NS=${ shellQuote(workspace) }`,
    `WS=${ shellQuote(`${ WORKSPACES_ROOT }/${ workspace }`) }`,
    'DIR=${PWD}',
    'KUBECONFIG=/dev/null exec kubectl exec -i -n "$NS" "deploy/$NS" -c workspace -- \\',
    '  setpriv --reuid=1000 --regid=1000 --init-groups \\',
    '  /usr/bin/env HOME="$WS/.home" WSD="$WS" DIR="$DIR" \\',
    '  /bin/bash -lc \'cd "$DIR" 2>/dev/null || cd "$WSD/dashboard"; PATH="$WSD/bin:$PATH"; eval "$1"\' bash "$1"',
    '',
  ].join('\n');
}

/**
 * What the conversation opens with.
 *
 * Deliberately short. Everything about how a fix is made lives in the prompt file, which is the
 * same document the team's own fix prompt is - so the work does not quietly drift from what the
 * engineer is used to reviewing because somebody edited a string in a Vue component. This says
 * where things are and what order to do them in, and nothing else.
 *
 * It carries no credentials. The workspace resolves its own.
 */
function openingPrompt(action: JobAction, library: string, group: VulnGroup | null, job: Job): string {
  const alerts = (group?.vulns || [])
    .filter((v) => v.state === 'open')
    .map((v) => `#${ v.id } (${ v.severity }${ v.patched ? `, needs ${ v.patched }` : ', no fix published' }) in ${ v.manifest }`);

  return [
    `${ VERBS[action] } the dependency **${ library }** in ${ UPSTREAM_REPO }.`,
    '',
    `Read ${ ROOT }/${ PROMPTS[action] } IN FULL before you do anything. It is the specification`,
    'for this action and it is authoritative.',
    '',
    'Facts for this run:',
    `  library        ${ library }`,
    `  workspace      ${ job.workspace } (your commands already run inside it)`,
    `  checkout       ${ WORKSPACES_ROOT }/${ job.workspace }/dashboard`,
    `  push to        ${ FORK_REPO } (remote "fork")`,
    `  pull requests  ${ PR_TARGET_REPO }`,
    job.branch ? `  branch         ${ job.branch }` : '',
    job.prNumber ? `  pull request   ${ job.prNumber }` : '',
    alerts.length ? `  open alerts    ${ alerts.join('; ') }` : '',
    '',
    'Enumerate the affected manifests from the LIVE alerts, not from the list above - this board',
    'can be hours old and a missed lockfile is the most common thing a reviewer catches.',
    '',
    `Record what you did by writing the job: ${ ROOT }/job.sh ${ shellQuote(library) } <field>=<value> ...`,
    'Call it when you finish and whenever something durable happens (a branch, a preview, a pull',
    'request). If you cannot finish, record why:',
    `  ${ ROOT }/job.sh ${ shellQuote(library) } phase=Failed message="one line saying what went wrong"`,
    '',
    'Then stop.',
  ].filter((line) => line !== '').join('\n');
}

/**
 * Put this extension's scripts and prompts in the agents pod.
 *
 * Every run, rather than once. The pod is replaced whenever the agents extension rolls it, and
 * a run against last month's copy of the prompt is a run whose output does not match the spec
 * this bundle carries.
 */
async function writeSeed(target: PodRef, workspace: string): Promise<void> {
  const wanted = ['job.sh', ...Object.values(PROMPTS)];

  for (const name of wanted) {
    const content = SEED_FILES[name];

    if (!content) {
      throw new Error(`This build is missing its ${ name } - run "yarn gen-seed" and rebuild.`);
    }

    await podWriteFile(target, `${ ROOT }/${ name }`, content, { mode: '644', owner: POD_USER });
  }

  await podWriteFile(target, `${ ROOT }/shell-${ workspace }.sh`, shellWrapper(workspace), {
    mode: '755', owner: POD_USER,
  });

  await podExec(target, ['/bin/sh', '-c', `chown ${ POD_USER } ${ ROOT } 2>/dev/null || true`], { timeoutMs: 15000 });
}

export interface StartOptions {
  store: Store;
  library: string;
  action: JobAction;
  group?: VulnGroup | null;
  by?: string;
}

/**
 * Start one action.
 *
 * Refuses to start a second run on a library that already has one going. The old console
 * enforced one action at a time GLOBALLY - a single `busy` flag disabling every button on the
 * board - because every fix shared one checkout on one laptop and two agents in it corrupted
 * each other's work. A workspace per library removes the reason for that, so two libraries can
 * be fixed at once; two runs on ONE library still cannot.
 */
export async function startAction(options: StartOptions): Promise<Job> {
  const { store, library, action, group = null, by } = options;
  const api = agentsApi();

  if (!api) {
    throw new Error('The Agents extension is not available on this page, so there is no agent to do the work.');
  }

  const running = (await readJobs()).find((j) => j.library === library && j.phase === 'Running');

  if (running && Date.now() - running.updatedAt < STALE_RUN_MS) {
    throw new Error(`${ library } already has a run going. Stop it first, or wait for it to finish.`);
  }

  const pod = await api.agent.pod();

  if (!pod) {
    throw new Error('The agent pod is not running, so there is nowhere to do the work.');
  }

  const previous = (await readJobs()).find((j) => j.library === library);
  const now = Date.now();
  const job: Job = {
    library,
    phase:      'Running',
    action,
    by:         by || 'unknown',
    startedAt:  now,
    updatedAt:  now,
    sessionId:  null,
    workspace:  workspaceName(library),
    // What an earlier run already achieved is carried forward: Create PR needs the branch the
    // fix made, and Address comments needs the pull request.
    branch:     previous?.branch || null,
    previewUrl: previous?.previewUrl || null,
    prUrl:      previous?.prUrl || null,
    prNumber:   previous?.prNumber || null,
    videoUrl:   previous?.videoUrl || null,
    infoUrl:    previous?.infoUrl || null,
    replyUrl:   previous?.replyUrl || null,
    message:    null,
    vulnIds:    previous?.vulnIds || [],
  };

  await writeJob(job);

  try {
    const workspace = await ensureWorkspace(store, library);
    const target = agentTarget(pod);

    await writeSeed(target, workspace);

    const session = await api.agent.startInProject(
      agentProject(`${ workspace }-${ action }-${ now }`),
      `${ VERBS[action] } ${ library }`,
      openingPrompt(action, library, group, { ...job, workspace }),
    );

    const started: Job = { ...job, workspace, sessionId: session, updatedAt: Date.now() };

    await writeJob(started);

    // Start the pane detached, with the shell prefix pointing into the workspace. Starting a
    // conversation only QUEUES the prompt - it is read the first time a pane attaches, and
    // without this nothing would attach until somebody opened the terminal by hand, which is
    // not what pressing a button means.
    await podRunScript(
      target,
      [
        `/bin/sh /seed/shell.sh`,
        shellQuote(session),
        shellQuote(CONVERSATIONS),
        shellQuote(AGENT_HOME),
        'start',
        shellQuote(`${ ROOT }/shell-${ workspace }.sh`),
      ].join(' '),
      'start the conversation in the agent pod',
      120000,
    );

    return started;
  } catch (e: any) {
    const why = e?.message || String(e);

    await writeJob({ ...job, phase: 'Failed', message: why, updatedAt: Date.now() }).catch(() => undefined);

    throw new Error(why, { cause: e });
  }
}

/**
 * Stop a run.
 *
 * The capability the old console did not have, and the reason it did not is instructive: its
 * watcher's main loop was blocked inside the agent call for the whole run, so it could not see
 * a Stop request at all. Cancellation had to be handled by the heartbeat subshell, through a
 * marker file, a dedupe on its timestamp, a maximum age so a stale marker could not kill a
 * later run, and a force-clear after 45 seconds.
 *
 * Here the run is a conversation in a pod, so stopping it is ending the conversation. The job
 * becomes Cancelled rather than Failed, because somebody chose this.
 */
export async function stopRun(job: Job): Promise<void> {
  const api = agentsApi();

  if (api && job.sessionId) {
    await api.agent.end(job.sessionId).catch(() => undefined);
  }

  await writeJob({
    ...job,
    phase:     'Cancelled',
    message:   'Stopped.',
    sessionId: null,
    updatedAt: Date.now(),
  });
}

/**
 * Whether a job that says Running still is.
 *
 * A browser tab can be closed halfway through a run, and the pod can be replaced under it, so
 * "Running" is a claim rather than a fact. The claim expires: a job whose last write was long
 * enough ago is shown as stalled and can be stopped, rather than leaving a row spinning for
 * ever with no way out - which is the state the old console's force-clear existed to escape.
 */
export function isStalled(job: Job, now = Date.now()): boolean {
  return job.phase === 'Running' && now - job.updatedAt > STALE_RUN_MS;
}
