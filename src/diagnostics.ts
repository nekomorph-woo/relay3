import { errorData, scrub } from './diagnosticData';
let remote: { base: string; token: string } | undefined;
let count = 0,
  started = Date.now();
export function setDiagnosticTarget(base: string, token: string) {
  if (token) remote = { base, token };
}
export function reportException(event: string, error: unknown) {
  if (Date.now() - started > 60_000) {
    count = 0;
    started = Date.now();
  }
  if (count++ >= 20) return;
  const data = { event: scrub(event), ...errorData(error) };
  if (window.relay3) void window.relay3.reportException(data).catch(() => {});
  else if (remote)
    void fetch(remote.base + '/api/diagnostics', {
      method: 'POST',
      headers: { Authorization: `Bearer ${remote.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }).catch(() => {});
}
export function installExceptionReporting() {
  window.addEventListener(
    'error',
    (event) => {
      if (event instanceof ErrorEvent)
        reportException('renderer.window-error', event.error ?? new Error(event.message));
      else reportException('renderer.resource-error', new Error('页面资源加载失败'));
    },
    true,
  );
  window.addEventListener('unhandledrejection', (event) =>
    reportException('renderer.unhandled-rejection', event.reason),
  );
}
