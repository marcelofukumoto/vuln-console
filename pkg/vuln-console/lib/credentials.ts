// The GitHub token, stored per Rancher user.
//
// Per user, not per installation, and that is the whole point of this file. A fix pushes a
// branch and opens a pull request, and both of those are done BY somebody: with one shared token
// every fix in the cluster is attributed to whoever pasted it, pushes to that person's fork, and
// asks for review as them. Each person brings their own, and their own fork and authorship
// follow from it.
//
// It is NOT shared with Extension Studio, which was the first design here. That extension keeps
// one `gh_token` for the whole installation - its own code calls it "a token written by
// anybody" - so borrowing it would mean everybody acting as one anonymous account, which is the
// thing this is avoiding. The two are different credentials with the same name.
//
// The handling is still Extension Studio's, because that part was right:
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
//     it is not touching - which with one key per user means pulling everybody's token into one
//     person's browser. A patch says what changed; `null` deletes a key.
//   - **An annotation says whether one is stored**, so the form can choose between "Set" and
//     "Replace" without going near `data`.
//
// The token is read by the pod that needs it, with its own ServiceAccount, at the moment it is
// needed. It is never sent from here into a pod.
import { K8S_BASE, STEVE_BASE, rancherFetch } from './rancher';
import {
  GH_TOKEN_KEY, NAMESPACE, RANCHER_TOKEN_KEY, RANCHER_TOKEN_TTL_MS, SECRET_NAME,
} from '../config/constants';

export { GH_TOKEN_KEY, NAMESPACE, RANCHER_TOKEN_KEY, SECRET_NAME };

/**
 * A Rancher principal as a Secret key.
 *
 * `local://user-qncms` becomes `local-user-qncms`. The principal id is what the dashboard
 * actually has - it is on every page, it is stable, and it distinguishes a local user from the
 * same login arriving through GitHub, which two people sharing a name would not.
 *
 * Secret data keys allow only `[-._a-zA-Z0-9]`, so everything else collapses to a hyphen.
 */
export function userSlug(principalId: string): string {
  return String(principalId || '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200) || 'unknown';
}

/**
 * The same principal as an object NAME.
 *
 * `userSlug` is shaped for Secret data keys, which allow `_`, `.` and capitals; a resource name
 * is DNS-1123 and allows none of them. `github_user://4140586` is a real principal on this
 * Rancher and its underscore is what the apiserver rejects, so a name gets its own narrower
 * spelling rather than the key one. For principals that contain neither - `local://user-qncms` -
 * the two agree, which is why the difference went unnoticed until a GitHub login pressed Setup.
 */
export function userDnsSlug(principalId: string): string {
  return String(principalId || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200) || 'unknown';
}

/** The Secret key holding one user's GitHub token. */
export function tokenKey(principalId: string): string {
  return `${ GH_TOKEN_KEY }-${ userSlug(principalId) }`;
}

/** The Secret key holding one user's Rancher token. */
export function rancherTokenKey(principalId: string): string {
  return `${ RANCHER_TOKEN_KEY }-${ userSlug(principalId) }`;
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
export async function mintRancherToken(principalId: string, description: string): Promise<void> {
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
    body:    JSON.stringify({ data: { [rancherTokenKey(principalId)]: encodeSecret(token) } }),
  });
}

function annotationKey(principalId: string): string {
  // Kubernetes allows 63 characters after the slash; a principal slug is well inside it.
  return `vuln-console.rancher.io/gh-${ userSlug(principalId) }`.slice(0, 253);
}

/**
 * Ask for metadata and nothing else.
 *
 * `PartialObjectMetadata` is a content negotiation the apiserver does on any object: ask for it
 * and the answer carries `metadata` alone.
 */
const METADATA_ONLY = { Accept: 'application/json;as=PartialObjectMetadata;g=meta.k8s.io;v=v1' };

function secretPath(): string {
  return `${ K8S_BASE }/namespaces/${ NAMESPACE }/secrets/${ SECRET_NAME }`;
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
  /** Whether THIS user has stored a token. Nobody else's presence helps them. */
  stored: boolean;
  /** How many people have stored one, which is worth saying on a shared board. */
  others: number;
  /** True when the namespace or Secret could not be read at all - permissions, not absence. */
  unreadable: boolean;
}

export async function readCredentialStatus(principalId: string): Promise<CredentialStatus> {
  const metadata = await secretMetadata();

  if (!metadata) {
    return { stored: false, others: 0, unreadable: false };
  }

  const keys = managedDataKeys(metadata);
  const annotations = metadata.annotations || {};
  const mine = annotations[annotationKey(principalId)] === 'set' || keys.includes(tokenKey(principalId));
  const everyone = new Set([
    ...keys.filter((key) => key.startsWith(`${ GH_TOKEN_KEY }-`)),
    ...Object.keys(annotations)
      .filter((key) => key.startsWith('vuln-console.rancher.io/gh-'))
      .map((key) => `${ GH_TOKEN_KEY }-${ key.split('/')[1].replace(/^gh-/, '') }`),
  ]);

  return {
    stored:     mine,
    others:     Math.max(0, everyone.size - (mine ? 1 : 0)),
    unreadable: false,
  };
}

/** The namespace and an empty Secret, made on the way past so the patch below has a target. */
async function ensureSecret(): Promise<void> {
  const existing = await secretMetadata();

  if (existing) {
    return;
  }

  await rancherFetch(`${ K8S_BASE }/namespaces`, {
    method: 'POST',
    body:   JSON.stringify({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: NAMESPACE } }),
  }).catch((e: any) => {
    if (!/409|already exists|alreadyexists/i.test(e?.message || '')) {
      throw e;
    }
  });

  await rancherFetch(`${ K8S_BASE }/namespaces/${ NAMESPACE }/secrets`, {
    method:  'POST',
    headers: METADATA_ONLY,
    body:    JSON.stringify({
      apiVersion: 'v1',
      kind:       'Secret',
      type:       'Opaque',
      metadata:   { name: SECRET_NAME, namespace: NAMESPACE },
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
export async function saveCredentials(principalId: string, ghToken: string): Promise<void> {
  await ensureSecret();

  const clearing = ghToken === '';

  await rancherFetch(secretPath(), {
    method:  'PATCH',
    headers: { 'Content-Type': 'application/merge-patch+json', ...METADATA_ONLY },
    body:    JSON.stringify({
      metadata: { annotations: { [annotationKey(principalId)]: clearing ? null : 'set' } },
      data:     { [tokenKey(principalId)]: clearing ? null : encodeSecret(ghToken) },
    }),
  });
}

/** Whether this user can run anything. */
export function credentialsReady(status: CredentialStatus): boolean {
  return status.stored;
}
