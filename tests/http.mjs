// This Mac's network proxy intercepts Node HTTP clients even for loopback.
// curl explicitly bypasses the proxy; production desktop downloads use Chromium net.fetch.
import { spawn } from 'node:child_process';
export function localFetch(url, options = {}) {
  if (process.platform !== 'darwin') return globalThis.fetch(url, options);
  return new Promise((resolve, reject) => {
    const args = [
      '--noproxy',
      '*',
      '--silent',
      '--show-error',
      '--include',
      '--max-time',
      '15',
      '--header',
      'Expect:',
      '--request',
      options.method ?? 'GET',
    ];
    for (const [key, value] of Object.entries(options.headers ?? {}))
      args.push('--header', `${key}: ${value}`);
    if (options.body !== undefined) args.push('--data-binary', '@-');
    args.push(url);
    const child = spawn('/usr/bin/curl', args);
    const chunks = [];
    let error = '';
    child.stdout.on('data', (b) => chunks.push(b));
    child.stderr.on('data', (b) => (error += b));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(error));
      const raw = Buffer.concat(chunks);
      const end = raw.indexOf('\r\n\r\n'),
        header = raw.subarray(0, end).toString();
      const status = Number(header.split(' ')[1]);
      const headers = new Headers();
      for (const line of header.split('\r\n').slice(1)) {
        const colon = line.indexOf(':');
        if (colon > 0) headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
      }
      headers.delete('transfer-encoding');
      headers.delete('content-length');
      resolve(
        new Response([204, 205, 304].includes(status) ? null : raw.subarray(end + 4), {
          status,
          headers,
        }),
      );
    });
    child.stdin.end(options.body ?? '');
  });
}
