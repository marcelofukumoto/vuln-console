// Talking to Rancher, which for this extension is one function and one header.
//
// Everything goes through Rancher's own API, same-origin: the page already has a session and the
// browser already sends it, so there is no client to construct and no token to keep. What is
// left is the two things fetch does not do by itself - a CSRF header on writes, and an error
// that says what went wrong rather than resolving to a 500 body.
//
// Two bases, and the difference matters. Steve (`/v1`) is what the rest of this extension reads
// its ConfigMaps through. The raw Kubernetes API (`/api/v1`) is what the credential store needs,
// because only the apiserver honours the content negotiation that lets a browser read a Secret's
// metadata without receiving the Secret.

const CLUSTER = 'local';

export const STEVE_BASE = `/k8s/clusters/${ CLUSTER }/v1`;
export const K8S_BASE = `/k8s/clusters/${ CLUSTER }/api/v1`;

export function csrfHeader(): Record<string, string> {
  const match = document.cookie.match(/(?:^|;\s*)CSRF=([^;]*)/);

  return { 'X-Api-Csrf': match ? decodeURIComponent(match[1]) : 'CSRF' };
}

/**
 * A Rancher API call, as JSON, that throws on failure.
 *
 * A 404 answers null rather than throwing: "there is no such object" is the ordinary state of
 * everything this extension stores before it is stored, and a caller that has to try/catch to
 * learn that is a caller that catches real failures by accident.
 */
export async function rancherFetch(path: string, init?: RequestInit): Promise<any> {
  const write = !!init?.method && init.method !== 'GET';
  const resp = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Accept:         'application/json',
      ...(write ? csrfHeader() : {}),
      ...(init?.headers || {}),
    },
  });

  if (resp.status === 404) {
    return null;
  }

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    throw new Error(data.message || data.error || `HTTP ${ resp.status }`);
  }

  return data;
}
