import { errorData, scrub, type DiagnosticLevel } from '../src/diagnosticData';
type Sink = (level: DiagnosticLevel, event: string, details: Record<string, unknown>) => void;
let sink: Sink = () => {};
export function setDiagnosticSink(next: Sink) {
  sink = next;
}
export function diagnostic(
  level: DiagnosticLevel,
  event: string,
  details: Record<string, unknown> = {},
) {
  // 不接收请求正文、认证信息、聊天内容或文件内容。
  const safe = Object.fromEntries(
    Object.entries(details).map(([key, value]) => [
      key,
      value instanceof Error
        ? errorData(value)
        : typeof value === 'object'
          ? '[省略对象]'
          : scrub(value),
    ]),
  );
  try {
    sink(level, scrub(event), safe);
  } catch {
    /* 日志失败不能影响业务 */
  }
}
