import { RelayService } from './service';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
export { RelayService } from './service';
export { Store } from './store';
const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) {
  const defaultDir =
    process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support', 'relay3')
      : process.platform === 'win32'
        ? path.join(process.env.APPDATA ?? os.homedir(), 'relay3')
        : path.join(os.homedir(), '.local', 'share', 'relay3');
  const service = new RelayService(process.env.RELAY3_DATA_DIR ?? defaultDir, path.resolve('dist'));
  await service.startControl();
  await service.startHub();
  console.log(
    `relay3 已启动：${service.addresses().join('、') || 'http://127.0.0.1:' + service.store.settings.port}`,
  );
  console.log(
    `配对链接：http://127.0.0.1:${service.store.settings.port}/#pair=${service.pairingToken}`,
  );
  for (const sig of ['SIGINT', 'SIGTERM'] as const)
    process.on(sig, async () => {
      await service.close();
      process.exit(0);
    });
}
