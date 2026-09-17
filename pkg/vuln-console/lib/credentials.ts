// The GitHub token, stored once for the installation and set by the `admin` user alone.
//
// It used to be per Rancher user, so a fix pushed to the pusher's own fork and carried their
// authorship. This is the other trade: one credential, one place to manage it, and every fix
// the work of whichever account it belongs to. Whoever presses Fix, the run uses this token.
//
// WHO CAN CHANGE IT. The console offers the dialog only to the user whose Rancher username is
// `admin`. That is a UI gate and it is worth being exact about what it is not: a Secret is
// readable by anyone with RBAC `get` on secrets in its namespace, and a cluster owner has that
// implicitly and can grant it to themselves regardless. So this keeps other people from
// CHANGING the credential through the console; it does not hide it from another administrator.
// Keeping non-admins out altogether is RBAC's job, on the namespace.
//
// The handling is Extension Studio's, because that part was right:
//
//   - **Write-only from the browser.** A credential goes in and never comes back out. Nothing
//     here ever fetches a Secret's `data`.
//   - **`PartialObjectMetadata`.** Asking for that representation gets `metadata` with no `data`
//     and no `stringData` - the only way to learn anything about a Secret from a browser without
//     the browser receiving it. It goes on the writes as much as on the read: a PATCH answers
//     with the whole updated object by default, which is the same leak in the other direction.
//     It has to be the raw apiserver path, because Steve answers in its own shape and ignores
//     the header.
//   - **Merge patches.** A read-modify-PUT would have to fetch the object to preserve the keys
//     it is not touching, which means pulling the credential into a browser to write beside it.
//     A patch says what changed; `null` deletes a key.
//   - **An annotation says whether one is stored**, so the form can choose between "Set" and
//     "Replace" without going near `data`.
//
// The token is read by the pod that needs it, with its own ServiceAccount, at the moment it is
// needed. It is never sent from here into a pod.
import { K8S_BASE, STEVE_BASE, rancherFetch } from './rancher';
import {
  GH_TOKEN_KEY, RANCHER_TOKEN_KEY, RANCHER_TOKEN_TTL_MS, SECRET_NAME, SETTINGS_NAMESPACE,
} from '../config/constants';

export {
  GH_TOKEN_KEY, RANCHER_TOKEN_KEY, SECRET_NAME, SETTINGS_NAMESPACE,
};

/**
 * Is the person looking at this the `admin` user?
 *
 * By username, asked of Rancher, rather than by principal id - an id is per installation and
 * hard-coding one makes an extension that only works on the cluster it was written on. Norman's
 * `?me=true` answers for the caller, so there is nothing to pass in and nothing to spoof from
 * here: the session doing the asking is the session being described.
 *
 * Failure is NOT admin. A check that cannot be made is not a check that passed.
 */
export async function isAdminUser(): Promise<boolean> {
  const me = await rancherFetch(`${ STEVE_BASE.replace('/v1', '') }/v3/users?me=true`).catch(() => null);

  return (me?.data || []).some((u: any) => u?.username === 'admin');
}

/**
 * Mint a Rancher token for this user and store it beside their GitHub one.
 *
 * Minted from the browser, same-origin, so it is created BY the person looking at the board with
 * the session they already have - this asks Rancher for a token on their behalf rather than
 * needing any credential of its own. What the verification screenshots then show is what that
 * person can see, which is the only honest answer to "does the fix work".
 *
 * Fresh on every run rather than reused: a stored token can be revoked, expire, or belong to a
 * different Rancher than the one this tab is open on, and each of those is a browser that
 * silently photographs a login page. Minting costs one request and the TTL clears them up.
 */
export async function mintRancherToken(description: string): Promise<void> {
  const minted = await rancherFetch(`${ STEVE_BASE.replace('/v1', '') }/v3/tokens`, {
    method: 'POST',
    body:   JSON.stringify({
      type: 'token',
      description,
      ttl:  RANCHER_TOKEN_TTL_MS,
    }),
  }).catch(() => null);

  const token = minted?.token;

  if (!token) {
    throw new Error('Rancher would not issue a token for this session, so the browser cannot be signed in to verify a fix.');
  }

  await ensureSecret();

  await rancherFetch(secretPath(), {
    method:  'PATCH',
    headers: { 'Content-Type': 'application/merge-patch+json', ...METADATA_ONLY },
    body:    JSON.stringify({ data: { [RANCHER_TOKEN_KEY]: encodeSecret(token) } }),
  });
}

const GH_ANNOTATION = 'vuln-console.rancher.io/gh';

/**
 * Ask for metadata and nothing else.
 *
 * `PartialObjectMetadata` is a content negotiation the apiserver does on any object: ask for it
 * and the answer carries `metadata` alone.
 */
const METADATA_ONLY = { Accept: 'application/json;as=PartialObjectMetadata;g=meta.k8s.io;v=v1' };

function secretPath(): string {
  return `${ K8S_BASE }/namespaces/${ SETTINGS_NAMESPACE }/secrets/${ SECRET_NAME }`;
}

async function secretMetadata(): Promise<any | null> {
  const object = await rancherFetch(secretPath(), { headers: METADATA_ONLY }).catch(() => null);

  return object?.metadata || null;
}

/**
 * Which keys the Secret holds, without reading any of them.
 *
 * From `managedFields`, which records the field paths each writer owns - so `f:data` lists the
 * key names and none of the values. The fallback for a token stored before the annotation
 * existed.
 */
function managedDataKeys(metadata: any): string[] {
  const keys = new Set<string>();

  (metadata?.managedFields || []).forEach((entry: any) => {
    Object.keys(entry?.fieldsV1?.['f:data'] || {}).forEach((field) => {
      if (field.startsWith('f:')) {
        keys.add(field.slice(2));
      }
    });
  });

  return [...keys];
}

export interface CredentialStatus {
  /** Whether a token is stored for the installation. */
  stored: boolean;
  /** True when the namespace or Secret could not be read at all - permissions, not absence. */
  unreadable: boolean;
}

export async function readCredentialStatus(): Promise<CredentialStatus> {
  const metadata = await secretMetadata();

  if (!metadata) {
    return { stored: false, unreadable: false };
  }

  const keys = managedDataKeys(metadata);
  const annotations = metadata.annotations || {};

  return {
    stored:     annotations[GH_ANNOTATION] === 'set' || keys.includes(GH_TOKEN_KEY),
    unreadable: false,
  };
}

async function ensureSecret(): Promise<void> {
  const existing = await secretMetadata();

  if (existing) {
    return;
  }

  await rancherFetch(`${ K8S_BASE }/namespaces`, {
    method: 'POST',
    body:   JSON.stringify({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: SETTINGS_NAMESPACE } }),
  }).catch((e: any) => {
    if (!/409|already exists|alreadyexists/i.test(e?.message || '')) {
      throw e;
    }
  });

  await rancherFetch(`${ K8S_BASE }/namespaces/${ SETTINGS_NAMESPACE }/secrets`, {
    method:  'POST',
    headers: METADATA_ONLY,
    body:    JSON.stringify({
      apiVersion: 'v1',
      kind:       'Secret',
      type:       'Opaque',
      metadata:   { name: SECRET_NAME, namespace: SETTINGS_NAMESPACE },
    }),
  }).catch((e: any) => {
    if (!/409|already exists|alreadyexists/i.test(e?.message || '')) {
      throw e;
    }
  });
}

/** UTF-8 safe, because btoa alone throws on anything outside latin-1. */
function encodeSecret(value: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(value)));
}

/**
 * Write this user's token, and only this user's.
 *
 * A merge patch naming one key, so nobody else's is read, rewritten or lost. `''` clears it,
 * which is the only way to remove one.
 */
export interface CredentialChanges {
  /** Absent leaves it alone; `''` clears it, which is the only way to remove one. */
  ghToken?: string;
}

/**
 * Write the fields this change actually carries, and nothing else.
 *
 * Absent is not the same as empty. It used to take the token as a plain string, so a dialog
 * saved with the field left blank - which is what saving it after only reading it looks like -
 * sent the empty string, and the empty string means delete. Pressing Save threw the token away.
 * There is a Clear button for that, and it is the only thing that should be able to do it.
 *
 * Same shape as the report console's, which never had the bug, so the two dialogs behave the
 * same way for the same reason.
 */
export async function saveCredentials(changes: CredentialChanges): Promise<void> {
  if (changes.ghToken === undefined) {
    return;
  }

  const clearing = changes.ghToken === '';

  await ensureSecret();

  await rancherFetch(secretPath(), {
    method:  'PATCH',
    headers: { 'Content-Type': 'application/merge-patch+json', ...METADATA_ONLY },
    body:    JSON.stringify({
      metadata: { annotations: { [GH_ANNOTATION]: clearing ? null : 'set' } },
      data:     { [GH_TOKEN_KEY]: clearing ? null : encodeSecret(changes.ghToken) },
    }),
  });
}

/** Whether this user can run anything. */
export function credentialsReady(status: CredentialStatus): boolean {
  return status.stored;
}
