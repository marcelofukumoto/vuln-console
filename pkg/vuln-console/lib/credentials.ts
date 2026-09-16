// The one credential this extension needs, stored the way Extension Studio stores its GitHub token.
//
// Copied from that extension deliberately, down to the key name, because the interesting part is
// not where the Secret is but how it is handled - and getting that right from first principles is
// how a credential ends up in a page.
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
//     it is not touching, which pulls the credential into the page on every save. A patch says
//     what changed; `null` deletes a key.
//   - **An annotation says whether one is stored**, so a form can choose between "Set" and
//     "Replace" without going near `data`.
//
// The token itself is read by the agent pod, with its own ServiceAccount, at the moment a gather
// or a fix runs. It is never sent from here into the pod.
import { K8S_BASE, rancherFetch } from './rancher';
import {
  GH_TOKEN_KEY, NAMESPACE, SECRET_NAME, STUDIO_NAMESPACE, STUDIO_SECRET,
} from '../config/constants';

export { GH_TOKEN_KEY, NAMESPACE, SECRET_NAME, STUDIO_NAMESPACE, STUDIO_SECRET };

const GH_ANNOTATION = 'vuln-console.rancher.io/gh-token';
/** Studio's own marker, read so a token it stored is recognised without touching `data`. */
const STUDIO_GH_ANNOTATION = 'barn.rancher.io/gh-token';

/**
 * Ask for metadata and nothing else.
 *
 * `PartialObjectMetadata` is a content negotiation the apiserver does on any object: ask for it
 * and the answer carries `metadata` alone.
 */
const METADATA_ONLY = { Accept: 'application/json;as=PartialObjectMetadata;g=meta.k8s.io;v=v1' };

function secretPath(namespace: string, name: string): string {
  return `${ K8S_BASE }/namespaces/${ namespace }/secrets/${ name }`;
}

async function secretMetadata(namespace: string, name: string): Promise<any | null> {
  const object = await rancherFetch(secretPath(namespace, name), { headers: METADATA_ONLY }).catch(() => null);

  return object?.metadata || null;
}

/**
 * Which keys a Secret holds, without reading any of them.
 *
 * From `managedFields`, which records the field paths each writer owns - so `f:data` lists the
 * key names and none of the values. It is the fallback for a Secret written before the
 * annotation existed, which is every Extension Studio older than the change that added it.
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

/** Where a stored GitHub token came from, which is worth saying on the screen. */
export type GhSource = 'none' | 'ours' | 'studio';

export interface CredentialStatus {
  gh: GhSource;
  /** True when the namespace or Secret could not be read at all - a permissions problem, not an absence. */
  unreadable: boolean;
}

/**
 * What is stored, and nothing about what it is.
 *
 * Ours is preferred over Studio's: setting one here is somebody saying this extension should use
 * that one, and a borrowed credential should never quietly override a chosen one.
 */
export async function readCredentialStatus(): Promise<CredentialStatus> {
  const [ours, studio] = await Promise.all([
    secretMetadata(NAMESPACE, SECRET_NAME),
    secretMetadata(STUDIO_NAMESPACE, STUDIO_SECRET),
  ]);

  const ourKeys = managedDataKeys(ours);
  const studioKeys = managedDataKeys(studio);
  const ourAnnotations = ours?.annotations || {};
  const studioAnnotations = studio?.annotations || {};

  const ourGh = ourAnnotations[GH_ANNOTATION] === 'set' || ourKeys.includes(GH_TOKEN_KEY);
  const studioGh = studioAnnotations[STUDIO_GH_ANNOTATION] === 'set' || studioKeys.includes(GH_TOKEN_KEY);

  return {
    gh:         ourGh ? 'ours' : studioGh ? 'studio' : 'none',
    unreadable: false,
  };
}

/** The namespace and an empty Secret, made on the way past so the patch below has something to patch. */
async function ensureSecret(): Promise<void> {
  const existing = await secretMetadata(NAMESPACE, SECRET_NAME);

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

export interface CredentialChanges {
  /** Absent leaves it alone; `''` clears it, which is the only way to remove one. */
  ghToken?: string;
}

/**
 * Write only what was touched.
 *
 * A field the form left `undefined` is not in `changes` and is not written, which is what stops
 * opening the dialog and saving from blanking a credential nobody could see.
 */
export async function saveCredentials(changes: CredentialChanges): Promise<void> {
  const data: Record<string, string | null> = {};
  const annotations: Record<string, string | null> = {};

  if (changes.ghToken !== undefined) {
    data[GH_TOKEN_KEY] = changes.ghToken === '' ? null : encodeSecret(changes.ghToken);
    annotations[GH_ANNOTATION] = changes.ghToken === '' ? null : 'set';
  }

  if (!Object.keys(data).length) {
    return;
  }

  await ensureSecret();

  await rancherFetch(secretPath(NAMESPACE, SECRET_NAME), {
    method:  'PATCH',
    headers: { 'Content-Type': 'application/merge-patch+json', ...METADATA_ONLY },
    body:    JSON.stringify({ metadata: { annotations }, data }),
  });
}

/** Whether anything can run: a GitHub token resolvable from somewhere. */
export function credentialsReady(status: CredentialStatus): boolean {
  return status.gh !== 'none';
}
