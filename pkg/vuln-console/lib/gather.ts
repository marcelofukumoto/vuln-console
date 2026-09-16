// Refreshing the board.
//
// Deterministic from end to end: there is no agent in this path and nothing is judged, so it is
// a script run in a pod rather than a conversation. That is the whole of what the old console's
// hourly watcher timer was for.
//
// The token never comes near this file. gather.sh reads it out of a Secret with the pod's own
// ServiceAccount at the moment it needs it, writes the snapshot into a ConfigMap itself, and
// removes its copy on the way out - so the browser holds nothing worth leaking and the 229 KiB
// result never travels through it.
import { agentsApi } from './agents';
import { podRunScript, podWriteFile, shellQuote } from './exec';
import type { PodRef } from './exec';
import { SEED_FILES } from '../seed.generated';
import type { Board } from '../config/constants';

const ROOT = '/workspace/.vuln-console';
const POD_USER = '1000:1000';

/** How long a gather may take. Two GitHub endpoints and a thousand alerts, so not instant. */
const GATHER_TIMEOUT_MS = 180000;

export async function refreshSnapshot(board: Board): Promise<void> {
  const api = agentsApi();

  if (!api) {
    throw new Error('The Agents extension is not available on this page, so there is no pod to gather in.');
  }

  const pod = await api.agent.pod();

  if (!pod) {
    throw new Error('The agent pod is not running, so there is nowhere to gather.');
  }

  const target: PodRef = {
    pod,
    namespace: api.agent.namespace || 'extension-studio',
    container: api.agent.container || 'agent',
  };

  // Written every time rather than once: the pod belongs to the agents extension and is replaced
  // whenever that extension rolls it, so a gather against last month's copy is a gather whose
  // output does not match what this bundle expects to read.
  for (const name of ['gather.mjs', 'gather.sh']) {
    const content = SEED_FILES[name];

    if (!content) {
      throw new Error(`This build is missing its ${ name } - run "yarn gen-seed" and rebuild.`);
    }

    await podWriteFile(target, `${ ROOT }/${ name }`, content, { mode: '644', owner: POD_USER });
  }

  // A directory per board, so two refreshes running at once do not write each other's
  // snapshot.json out from under themselves.
  const dir = `${ ROOT }/gather-${ board.id }`;

  await podRunScript(
    target,
    `mkdir -p ${ shellQuote(dir) } && chown ${ POD_USER } ${ shellQuote(ROOT) } ${ shellQuote(dir) } 2>/dev/null || true`,
    'make the gather directory in the agent pod',
    20000,
  );

  await podRunScript(
    target,
    [
      `sh ${ shellQuote(`${ ROOT }/gather.sh`) }`,
      shellQuote(dir),
      shellQuote(board.id),
      shellQuote(board.repo),
      shellQuote(board.fork.split('/')[0]),
    ].join(' '),
    `gather the Dependabot alerts for ${ board.repo }`,
    GATHER_TIMEOUT_MS,
  );
}
