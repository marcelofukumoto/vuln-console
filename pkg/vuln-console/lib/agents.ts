// The agents extension, as this one reaches it.
//
// All the AI in this extension runs through codyrancher/agents: it owns the one claude pod in
// the cluster, the login inside it, and the conversations. This extension starts a conversation
// there and reads the result out of the cluster - it has no model, no key and no agent of its
// own, which is the point.
//
// The bridge is `window.__agents`, which that extension installs on every page (see its
// public-api.ts). Nothing is imported from it: two extensions are two bundles, and `window` is
// the one thing they share.

/** What the agents extension offers. Structural, because it is reached through `window`. */
export interface AgentsApi {
  version: string;
  terminal: { component: unknown };
  agent: {
    namespace: string;
    container: string;
    pod(): Promise<string | null>;
    command(id: string, mode?: 'claude' | 'shell'): string[];
    sessions(): Promise<{ id: string; title: string }[]>;
    projectSessions(project: string): Promise<{ id: string; title: string }[]>;
    start(): Promise<string>;
    startInProject(project: string, title?: string, prompt?: string): Promise<string>;
    queue(id: string, prompt: string): Promise<void>;
    rename(id: string, title: string): Promise<void>;
    end(id: string): Promise<void>;
    pane(id: string, lines?: number): Promise<{ text: string; running: boolean }>;
  };
}

const AGENTS_GLOBAL = '__agents';
const AGENTS_READY_EVENT = 'agents:ready';

/**
 * The project one run's conversation belongs to: the run's own id.
 *
 * A project rather than a drawer conversation, so the agents drawer never lists it - and a
 * project *per run* rather than one for the whole extension, because the pod hands out the
 * lowest free ordinal within a project. With one shared project every run was `p-interrupt-duty-1`
 * again as soon as the previous conversation was ended, so a stored id pointed at whichever run
 * happened to hold it now: opening a run's session showed a different run's, or a fresh pane.
 *
 * A run id is already unique, already lowercase letters, digits and hyphens, and at 23
 * characters is well inside the 40 a project name may be.
 */
export const MAX_PROJECT_NAME = 40;

export function agentProject(runId: string): string {
  const stamp = Date.now().toString(36);
  const room = MAX_PROJECT_NAME - stamp.length - 1;
  const base = String(runId)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, room)
    .replace(/-+$/, '');

  return `${ base || 'vc' }-${ stamp }`;
}

/**
 * The version that first offered what this extension calls: `startInProject` with an opening
 * prompt, and `pane` to read a conversation back. An older agents is a working drawer and a
 * broken run, which is a thing to say up front rather than a call that fails halfway
 * through a run.
 */
export const MIN_AGENTS_VERSION = '0.1.40';

export function agentsApi(): AgentsApi | null {
  return (window as unknown as Record<string, AgentsApi | undefined>)[AGENTS_GLOBAL] || null;
}

/**
 * The agents extension's terminal, as a component to mount.
 *
 * This is the whole of what "show me the session" needs: the same xterm, the same exec socket,
 * the same tmux reattach and the same chat/terminal toggle the drawer uses, given a `session`
 * prop. Nothing is imported - two extensions are two bundles, and the component travels on
 * `window` - but both run on the dashboard's own Vue, which is what makes mounting another
 * bundle's component work at all.
 *
 * It is deliberately not the drawer. The drawer lists only `agent-<n>`; a project's
 * conversations - which is what every run here is - are excluded from it by design, so that a
 * workspace's chatter never fills the global strip. Placing the pane is the offered way in, and
 * the agents README says so outright.
 */
export function terminalComponent(): unknown | null {
  return agentsApi()?.terminal?.component || null;
}

/** Compare two dotted versions numerically - `0.1.9` is not later than `0.1.40`. */
function atLeast(version: string, minimum: string): boolean {
  const left = String(version || '').split('.').map((p) => parseInt(p, 10) || 0);
  const right = minimum.split('.').map((p) => parseInt(p, 10) || 0);

  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const a = left[i] || 0;
    const b = right[i] || 0;

    if (a !== b) {
      return a > b;
    }
  }

  return true;
}

export type AgentsState = 'ready' | 'missing' | 'outdated' | 'no-pod' | 'checking';

export interface AgentsStatus {
  state: AgentsState;
  version: string | null;
  pod: string | null;
  /** One sentence for the banner: what is wrong and what to do about it. */
  detail: string;
}

/**
 * Whether anything can actually be run right now.
 *
 * Three separate things can be missing and they need three different sentences, because the fix
 * is different for each: the extension is not installed, it is too old, or it is installed and
 * its pod has not come up yet (which is normal for the first minute or two after a restart -
 * the pod installs tmux and the claude CLI on boot).
 */
export async function agentsStatus(): Promise<AgentsStatus> {
  const api = agentsApi();

  if (!api) {
    return {
      state:   'missing',
      version: null,
      pod:     null,
      detail:  'The Agents extension is not installed in this Rancher. Install codyrancher/agents — this extension runs every gather and every fix through the agent pod it provides.',
    };
  }

  if (!atLeast(api.version, MIN_AGENTS_VERSION)) {
    return {
      state:   'outdated',
      version: api.version,
      pod:     null,
      detail:  `The Agents extension is ${ api.version }; this needs ${ MIN_AGENTS_VERSION } or later for conversations that can be started with an opening prompt.`,
    };
  }

  const pod = await api.agent.pod().catch(() => null);

  if (!pod) {
    return {
      state:   'no-pod',
      version: api.version,
      pod:     null,
      detail:  'The agent pod is not running yet. It comes up on its own — give it a minute after a Rancher restart, then refresh.',
    };
  }

  return {
    state:   'ready',
    version: api.version,
    pod,
    detail:  `Agents ${ api.version } · agent pod ${ pod }`,
  };
}

/** Resolve once the agents bundle has installed its API, for a page that loaded first. */
export function whenAgentsReady(timeoutMs = 8000): Promise<AgentsApi | null> {
  const present = agentsApi();

  if (present) {
    return Promise.resolve(present);
  }

  return new Promise((resolve) => {
    const done = (value: AgentsApi | null) => {
      window.removeEventListener(AGENTS_READY_EVENT, onReady);
      clearTimeout(timer);
      resolve(value);
    };
    const onReady = () => done(agentsApi());
    const timer = setTimeout(() => done(agentsApi()), timeoutMs);

    window.addEventListener(AGENTS_READY_EVENT, onReady);
  });
}
