export type DiagnosticLevel = 'info' | 'warn' | 'error';
export function scrub(value: unknown): string {
  return String(value ?? '')
    .replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer [已隐藏]')
    .replace(/([?#&](?:token|pair|pairingToken|pairingCode|code)=)[^\s&#"']*/gi, '$1[已隐藏]')
    .replace(
      /(["']?(?:privateKey|secretKey|adminToken|pairingToken|pairingCode|token|authorization)["']?\s*[=:]\s*["']?)[^\s"',;}]+/gi,
      '$1[已隐藏]',
    )
    .replace(/\b[\da-f]{64,}\b/gi, '[已隐藏]')
    .slice(0, 8000);
}
export function errorData(error: unknown) {
  if (error instanceof Error) {
    const e = error as NodeJS.ErrnoException;
    return {
      name: scrub(e.name),
      message: scrub(e.message),
      stack: scrub(e.stack),
      code: scrub(e.code),
      syscall: scrub(e.syscall),
      path: scrub(e.path),
    };
  }
  return { message: scrub(error) };
}
