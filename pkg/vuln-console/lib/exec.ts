// Running a command in the agent pod, and putting a file there.
//
// The Kubernetes exec subresource, same-origin, with the session cookie the browser already
// has - the same way the dashboard's own container shell works, and the same way the agents
// extension reaches its pod. There is no backend for this extension to talk to and none to
// install: the browser opens the socket itself.
//
// The protocol is `base64.channel.k8s.io`: every frame is a channel digit (0 stdin, 1 stdout,
// 2 stderr, 3 the apiserver's status) followed by base64.

const CLUSTER = 'local';
const BASE = `/k8s/clusters/${ CLUSTER }`;

export interface ExecResult {
  stdout: string;
  stderr: string;
  /** 0 when it succeeded, its own code when it failed, -1 when it never ran. */
  code: number;
  /** The apiserver's status line, '' when the command succeeded. */
  status: string;
}

export interface PodRef {
  pod: string;
  namespace: string;
  container: string;
}

function execUrl(target: PodRef, command: string[], stdin: boolean): string {
  const origin = window.location.origin.replace(/^http/, 'ws');
  const params = new URLSearchParams({
    container: target.container,
    stdin:     stdin ? '1' : '0',
    stdout:    '1',
    stderr:    '1',
    tty:       '0',
  });

  // Repeated, not comma-joined: this is argv.
  for (const arg of command) {
    params.append('command', arg);
  }

  return `${ origin }${ BASE }/api/v1/namespaces/${ target.namespace }/pods/${ target.pod }/exec?${ params }`;
}

function decodeFrame(frame: string): { channel: number; bytes: Uint8Array } | null {
  const channel = Number(frame.slice(0, 1));

  try {
    return { channel, bytes: Uint8Array.from(atob(frame.slice(1)), (c) => c.charCodeAt(0)) };
  } catch {
    return null;
  }
}

const DEFAULT_TIMEOUT_MS = 120000;

/**
 * Run one command in the pod and report everything about how it went.
 *
 * Resolves rather than rejects on a non-zero exit: an exit code is a fact, and a caller that
 * asks whether a file exists wants the answer either way.
 *
 * `onStdin` is handed the socket once it is open, for the one caller that has something to
 * send. Everything else opens without stdin at all, so there is no half-open socket waiting on
 * an EOF that is never coming.
 */
export function podExec(
  target: PodRef,
  command: string[],
  options: { timeoutMs?: number; onStdin?: (send: (text: string) => void) => void } = {},
): Promise<ExecResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    const out: ExecResult = {
      stdout: '', stderr: '', status: '', code: -1,
    };
    let settled = false;
    let socket: WebSocket | null = null;
    // Two streaming decoders, because a multibyte character can straddle two frames.
    const decoders: Record<number, TextDecoder> = { 1: new TextDecoder(), 2: new TextDecoder() };

    const finish = (status = '') => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (status) {
        out.status = out.status || status;
      }
      try {
        socket?.close();
      } catch {
        /* already gone */
      }
      resolve(out);
    };
    const timer = setTimeout(
      () => finish(`no answer from the pod in ${ Math.round(timeoutMs / 1000) }s`),
      timeoutMs,
    );

    try {
      socket = new WebSocket(execUrl(target, command, !!options.onStdin), 'base64.channel.k8s.io');
    } catch (e: any) {
      finish(e?.message || String(e));

      return;
    }

    if (options.onStdin) {
      socket.onopen = () => {
        options.onStdin?.((text: string) => {
          const bytes = new TextEncoder().encode(text);
          let binary = '';

          for (const byte of bytes) {
            binary += String.fromCharCode(byte);
          }

          socket?.send(`0${ btoa(binary) }`);
        });
      };
    }

    socket.onmessage = (event) => {
      const frame = decodeFrame(String(event.data || ''));

      if (!frame) {
        return;
      }

      if (frame.channel === 1 || frame.channel === 2) {
        const text = decoders[frame.channel].decode(frame.bytes, { stream: true });

        if (frame.channel === 1) {
          out.stdout += text;
        } else {
          out.stderr += text;
        }

        return;
      }

      if (frame.channel === 3) {
        const message = new TextDecoder().decode(frame.bytes);

        try {
          const status = JSON.parse(message);

          if (status.status === 'Success') {
            out.code = 0;
          } else {
            out.status = status.message || 'the command failed';
            const cause = (status.details?.causes || []).find((c: any) => c.reason === 'ExitCode');

            out.code = cause ? Number(cause.message) || 1 : 1;
          }
        } catch {
          out.status = message;
          out.code = out.code === -1 ? 1 : out.code;
        }
      }
    };

    socket.onclose = () => {
      out.stdout += decoders[1].decode();
      out.stderr += decoders[2].decode();
      // A socket that closed without the apiserver saying how the command went is one that was
      // refused or dropped - unless output arrived, in which case the command ran and the
      // status frame was the casualty.
      if (out.code === -1) {
        if (out.stdout || out.stderr) {
          out.code = 0;
        } else {
          finish(out.status || 'the exec was refused or dropped');

          return;
        }
      }
      finish();
    };
    socket.onerror = () => finish('could not open an exec to the pod');
  });
}

/**
 * Whether a command worked is answered by the command, not by the socket.
 *
 * The apiserver's proxy sometimes closes an exec before the status frame that carries the exit
 * code arrives. A command that also printed nothing is then indistinguishable from one that
 * never ran - which is exactly what `mkdir -p && chown` is, and it was reported as "the exec
 * was refused or dropped" every time while creating the directory perfectly.
 *
 * So every script run through here is made to say so itself, and the sentinel in its output is
 * the answer. `set -e` because a script that fails halfway must not reach the echo.
 */
const OK_SENTINEL = '__VC_OK__';

export async function podRunScript(target: PodRef, script: string, what: string, timeoutMs?: number): Promise<string> {
  const result = await podExec(
    target,
    ['/bin/sh', '-c', `set -e\n${ script }\necho ${ OK_SENTINEL }`],
    { timeoutMs },
  );

  if (!result.stdout.includes(OK_SENTINEL)) {
    const why = result.stderr.trim() || result.status || (result.code > 0 ? `exit ${ result.code }` : 'it reported nothing');

    throw new Error(`Could not ${ what }: ${ why }`);
  }

  return result.stdout.replace(OK_SENTINEL, '').trim();
}

export function shellQuote(value: string): string {
  return `'${ value.split("'").join(`'\\''`) }'`;
}

/** Base64 goes in this many characters at a time, one line per chunk. */
const CHUNK = 4096;
const END_MARKER = '__END_OF_FILE__';

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';

  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }

  return btoa(binary);
}

/**
 * Write a file into the pod, through stdin.
 *
 * Through stdin and not the command line, and that is the whole reason this is not three lines.
 * An exec's command is argv, and argv in a pod is readable by every process in it - so a token
 * passed that way is a token on display to every other conversation for as long as the write
 * takes. It is also capped: the seed files here are tens of kilobytes and a URL is not.
 *
 * The content arrives as base64 lines and a sentinel rather than as a stream closed by EOF,
 * because closing the browser's half of a Kubernetes exec socket is how you lose the status
 * frame that says whether the command worked. With the sentinel the pod decides when the file
 * is complete, exits normally, and says so.
 *
 * `mode` is applied before the bytes land, so a credentials file is never briefly world
 * readable.
 */
export async function podWriteFile(
  target: PodRef,
  path: string,
  content: string,
  options: { mode?: string; owner?: string } = {},
): Promise<void> {
  const mode = options.mode || '644';
  const owner = options.owner || '';
  const quoted = shellQuote(path);
  const script = [
    `mkdir -p "$(dirname ${ quoted })"`,
    `: > ${ quoted }.b64`,
    `: > ${ quoted } && chmod ${ mode } ${ quoted }`,
    owner ? `chown ${ owner } ${ quoted } 2>/dev/null || true` : '',
    `while IFS= read -r line; do [ "$line" = "${ END_MARKER }" ] && break; printf '%s' "$line" >> ${ quoted }.b64; done`,
    `base64 -d < ${ quoted }.b64 > ${ quoted }`,
    `rm -f ${ quoted }.b64`,
    `chmod ${ mode } ${ quoted }`,
    owner ? `chown ${ owner } ${ quoted } 2>/dev/null || true` : '',
    `echo WROTE $(wc -c < ${ quoted })`,
  ].filter(Boolean).join('\n');

  const encoded = base64(content);
  const result = await podExec(target, ['/bin/sh', '-c', script], {
    timeoutMs: 60000,
    onStdin:   (send) => {
      for (let i = 0; i < encoded.length; i += CHUNK) {
        send(`${ encoded.slice(i, i + CHUNK) }\n`);
      }
      send(`${ END_MARKER }\n`);
    },
  });

  const wrote = result.stdout.match(/WROTE\s+(\d+)/);

  if (!wrote || Number(wrote[1]) !== new TextEncoder().encode(content).length) {
    const why = result.stderr.trim() || result.status || `exit ${ result.code }`;

    throw new Error(`Could not write ${ path } into the agent pod: ${ why }`);
  }
}
