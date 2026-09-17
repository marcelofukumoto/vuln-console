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
import { GH_TOKEN_KEY, RANCHER_TOKEN_KEY, mintRancherToken } from './credentials';
import { ensureWorkspace, workspaceName, workspaceUrl } from './workspace';
import type { Store } from './workspace';
import { SEED_FILES } from '../seed.generated';
import { STALE_RUN_MS, WORKSPACE_PORT, WORKSPACES_ROOT, devSchemeFor, forkFor, prTargetFor } from '../config/constants';
import type { Board } from '../config/constants';
import type { Job, JobAction, VulnGroup } from '../types';

/** Where this extension keeps its scripts inside the agents pod. */
const ROOT = '/workspace/.vuln-console';

/** The agents pod's own user. Everything the pane touches has to belong to it. */
const POD_USER = '1000:1000';

/** Where every conversation in the agents pod runs, and the home it runs with. */
const CONVERSATIONS = '/workspace/conversations';
const AGENT_HOME = '/workspace/.home';

/** The prompt file each action is driven by. */
/** Written into the agents pod and run there once the workspace is up. */
const SETUP_SCRIPT = 'workspace-setup.sh';

/**
 * How long the workspace is given to become usable.
 *
 * A first start is a Bundle render, an image pull, a clone and a yarn install, so minutes rather
 * than seconds. The script waits in the pod; this is the ceiling on that wait.
 */
const WORKSPACE_READY_MS = 22 * 60 * 1000;

const PROMPTS: Record<JobAction, string> = {
  fix:             'fix.prompt.md',
  pr:              'pr.prompt.md',
  record:          'record.prompt.md',
  addresscomment:  'address-comments.prompt.md',
  resolveconflict: 'resolve-conflict.prompt.md',
};

const VERBS: Record<JobAction, string> = {
  fix:             'Fix',
  pr:              'Open the pull request for',
  record:          'Record the verification for',
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
    '',
    "# The pane's own hooks stay in THIS pod. claude runs its hooks through this wrapper too -",
    '# they are shell commands and CLAUDE_CODE_SHELL_PREFIX applies to every one - but a hook is',
    '# about the pane, not about the work: what claude is doing, and the login it refreshed. Sent',
    '# down the tunnel they look for files that exist here and not in the workspace, and the run',
    '# reports "UserPromptSubmit hook error" on every turn while the drawer learns nothing.',
    '',
    "# job.sh stays here too, and for the same reason. It is how a run records what it did, and",
    '# it writes a ConfigMap with this pod\'s ServiceAccount - it belongs to the run, not to the',
    '# checkout. Sent down the tunnel it is a script that does not exist in the workspace calling',
    '# a kubectl that is not installed there, so every run ended unable to report its own result',
    '# and the board only ever showed what something else had written on its behalf.',
    'case "$1" in',
    `  *"/seed/chat-hook.mjs"*|*"/seed/claude-credentials.mjs"*|*${ JSON.stringify(`${ ROOT }/job.sh`) }*) exec /bin/sh -c "$1" ;;`,
    'esac',
    '',

    // `$WS/bin` first so the gh installed by workspace-setup.sh wins, and `.env` sourced so
    // every command the agent runs has GH_TOKEN - which is what makes `gh` and `git push` work
    // at all. `set -a` exports what the file sets; the file is 0600 and holds the token.
    'KUBECONFIG=/dev/null exec kubectl exec -i -n "$NS" "deploy/$NS" -c workspace -- \\',
    '  setpriv --reuid=1000 --regid=1000 --init-groups \\',
    '  /usr/bin/env HOME="$WS/.home" WSD="$WS" DIR="$DIR" \\',
    '  /bin/bash -lc \'cd "$DIR" 2>/dev/null || cd "$WSD/src"; PATH="$WSD/bin:$PATH"; if [ -f "$WSD/.env" ]; then set -a; . "$WSD/.env"; set +a; fi; eval "$1"\' bash "$1"',
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
function openingPrompt(
  action: JobAction,
  board: Board,
  fork: string,
  prTarget: string,
  library: string,
  group: VulnGroup | null,
  job: Job,
): string {
  const alerts = (group?.vulns || [])
    .filter((v) => v.state === 'open')
    .map((v) => `#${ v.id } (${ v.severity }${ v.patched ? `, needs ${ v.patched }` : ', no fix published' }) in ${ v.manifest }`);

  return [
    `${ VERBS[action] } the dependency **${ library }** in ${ board.repo }.`,
    '',
    `Read ${ ROOT }/${ PROMPTS[action] } IN FULL before you do anything. It is the specification`,
    'for this action and it is authoritative.',
    '',
    'Facts for this run:',
    `  library        ${ library }`,
    `  workspace      ${ job.workspace } (your commands already run inside it)`,
    `  checkout       ${ WORKSPACES_ROOT }/${ job.workspace }/src`,
    `  repository     ${ board.repo }`,
    `  push to        ${ fork } (remote "fork") — your branch goes here`,
    `  pull requests  ${ prTarget } — the pull request is opened against this, from ${ fork.split('/')[0] }:<branch>`,
    job.branch ? `  branch         ${ job.branch }` : '',
    job.prNumber ? `  pull request   ${ job.prNumber }` : '',
    alerts.length ? `  open alerts    ${ alerts.join('; ') }` : '',
    '',
    'Enumerate the affected manifests from the LIVE alerts, not from the list above - this board',
    'can be hours old and a missed lockfile is the most common thing a reviewer catches.',
    '',
    `Record what you did by writing the job: ${ ROOT }/job.sh ${ board.id } ${ shellQuote(library) } <field>=<value> ...`,
    'Call it when you finish and whenever something durable happens (a branch, a preview, a pull',
    'request). If you cannot finish, record why:',
    `  ${ ROOT }/job.sh ${ board.id } ${ shellQuote(library) } phase=Failed message="one line saying what went wrong"`,
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
  // verifying.md is not an action's prompt - it is the shared half that several of them point
  // at, so it goes in alongside them rather than being repeated in each.
  const wanted = ['job.sh', SETUP_SCRIPT, 'verifying.md', ...Object.values(PROMPTS)];

  for (const name of wanted) {
    const content = SEED_FILES[name];

    if (!content) {
      throw new Error(`This build is missing its ${ name } - run "yarn gen-seed" and rebuild.`);
    }

    // job.sh is run, the prompts are read. The board tells an agent to invoke `$ROOT/job.sh`
    // directly, and at 644 that is "Permission denied" - it only worked when an agent happened
    // to write `sh job.sh` instead, which is not something the instruction says to do.
    const mode = name.endsWith('.sh') ? '755' : '644';

    await podWriteFile(target, `${ ROOT }/${ name }`, content, { mode, owner: POD_USER });
  }

  await podWriteFile(target, `${ ROOT }/shell-${ workspace }.sh`, shellWrapper(workspace), {
    mode: '755', owner: POD_USER,
  });

  // Nothing is written outside ROOT. A claude skill would have to live in this pod's shared
  // `~/.claude/skills`, where it loads for every conversation in the pod - the agents
  // extension's own agent and any other extension's runs, not only ours. This extension is a
  // guest here. The prompts already say to read verifying.md in full, so the gain was small
  // and the reach large; it is not ours to decide unasked.
  await podExec(target, ['/bin/sh', '-c', `chown ${ POD_USER } ${ ROOT } 2>/dev/null || true`], { timeoutMs: 15000 });
}

export interface StartOptions {
  store: Store;
  board: Board;
  /** The account the stored token belongs to, from the gather. Decides the fork. */
  tokenLogin: string;
  /**
   * Who pressed the button, as Rancher knows them - recorded on the job as `by`.
   *
   * It no longer decides WHICH token is used: there is one for the installation now. Kept
   * because "who started this" is still worth knowing on a shared board.
   */
  principalId?: string;
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
  const { store, board, tokenLogin, library, action, group = null, by } = options;
  const fork = forkFor(board, tokenLogin);
  const prTarget = prTargetFor(board);

  if (!fork) {
    throw new Error('There is no fork to push to: the board sets none and the stored token\'s account is not known yet. Refresh the board first.');
  }

  const api = agentsApi();

  if (!api) {
    throw new Error('The Agents extension is not available on this page, so there is no agent to do the work.');
  }

  const running = (await readJobs(board.id)).find((j) => j.library === library && j.phase === 'Running');

  if (running && Date.now() - running.updatedAt < STALE_RUN_MS) {
    throw new Error(`${ library } already has a run going. Stop it first, or wait for it to finish.`);
  }

  const pod = await api.agent.pod();

  if (!pod) {
    throw new Error('The agent pod is not running, so there is nowhere to do the work.');
  }

  const previous = (await readJobs(board.id)).find((j) => j.library === library);
  const now = Date.now();
  const job: Job = {
    board: board.id,
    library,
    phase:      'Running',
    action,
    by:         by || 'unknown',
    startedAt:  now,
    updatedAt:  now,
    stage:      'workspace',
    sessionId:  null,
    workspace:  workspaceName(board.id, library),
    // What an earlier run already achieved is carried forward: Create PR needs the branch the
    // fix made, and Address comments needs the pull request.
    branch:     previous?.branch || null,
    // Computed, not inherited. It is a formula - the namespace, the port and the scheme this
    // board's dev server speaks - so there is no reason for the board to wait for a run to
    // report it, and a first run used to carry null here and had nothing to link to. job.sh
    // also turns a recorded artefact path into a URL underneath it, which needs it present
    // from the start rather than after the first fix.
    previewUrl: `${ window.location.origin }${ workspaceUrl(workspaceName(board.id, library), WORKSPACE_PORT, devSchemeFor(board)) }`,
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
    const workspace = await ensureWorkspace(store, board, fork, library);
    const target = agentTarget(pod);

    await writeSeed(target, workspace);

    // The conversation first, and the workspace afterwards. Starting a conversation only QUEUES
    // the prompt into the agents pod, which is always up, so it succeeds immediately - and that
    // is what the button needs to return. The workspace behind it is minutes from usable: Fleet
    // has to render the Bundle, the kubelet has to pull an image, and the pod then clones the
    // repository and runs a yarn install. Waiting for all that before answering would be a
    // button that appears to hang for five minutes.
    const session = await api.agent.startInProject(
      // agentProject adds its own timestamp; spending characters on a second one only
      // eats the room the library name needs.
      agentProject(`${ workspace }-${ action }`),
      `${ VERBS[action] } ${ library }`,
      openingPrompt(action, board, fork, prTarget, library, group, { ...job, workspace }),
    );

    const started: Job = {
      ...job, workspace, sessionId: session, stage: 'waiting', updatedAt: Date.now(),
    };

    await writeJob(started);

    // The rest in the background: wait for the workspace, give it a credential and a fork, then
    // attach the pane so the queued prompt is read. A failure here is recorded on the job rather
    // than thrown, because the caller has already been answered.
    void (async() => {
      try {
        // A Rancher session for the workspace browser. Without it the verification drives a
        // browser with no session and photographs a login page, which looks like evidence and
        // is not. Not fatal - a fix that cannot be shown is still a fix - so a failure here is
        // swallowed and the setup reports which it got.
        //
        // Minted by whoever pressed the button, which is no longer the same account the fix is
        // pushed as: the GitHub token is the installation's. So the screenshots show what the
        // person looking can see, and the branch belongs to the shared account.
        await mintRancherToken(`vuln-console ${ board.id } ${ library }`).catch(() => undefined);

        await podRunScript(
          target,
          [
            `sh ${ shellQuote(`${ ROOT }/${ SETUP_SCRIPT }`) }`,
            shellQuote(workspace),
            shellQuote(board.repo),
            shellQuote(fork),
            shellQuote(GH_TOKEN_KEY),
            shellQuote(board.id),
            shellQuote(library),
            shellQuote(RANCHER_TOKEN_KEY),
            shellQuote(window.location.origin),
          ].join(' '),
          `prepare the workspace for ${ board.repo }`,
          WORKSPACE_READY_MS,
        );

        // Start the pane detached, with the shell prefix pointing into the workspace. Without
        // this nothing attaches until somebody opens the terminal by hand, and the queued prompt
        // is never read - which is not what pressing a button means.
        await writeJob({ ...started, stage: 'starting', updatedAt: Date.now() }).catch(() => undefined);

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
      } catch (e: any) {
        // Re-read before recording the failure. `started` is a snapshot from before the work
        // began, and the steps since have written their own stage onto the job - spreading the
        // snapshot would put the stage back to where it was and report the failure at the wrong
        // step.
        const latest = (await readJobs(board.id).catch(() => [])).find((j) => j.library === library);

        await writeJob({
          ...(latest || started),
          phase:     'Failed',
          message:   e?.message || String(e),
          updatedAt: Date.now(),
        }).catch(() => undefined);
      }
    })();

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
