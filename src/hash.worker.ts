import { sha256 } from '@noble/hashes/sha2.js';
self.onmessage = async (event: MessageEvent<File>) => {
  try {
    const file = event.data,
      hash = sha256.create(),
      reader = file.stream().getReader();
    let bytes = 0,
      last = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      hash.update(chunk.value);
      bytes += chunk.value.length;
      if (Date.now() - last > 100) {
        self.postMessage({ bytes });
        last = Date.now();
      }
    }
    self.postMessage({
      bytes,
      hash: Array.from(hash.digest(), (b) => b.toString(16).padStart(2, '0')).join(''),
    });
  } catch (e: any) {
    self.postMessage({ error: e.message || '文件读取失败' });
  }
};
