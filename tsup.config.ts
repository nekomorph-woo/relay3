import { defineConfig } from 'tsup';
export default defineConfig({
  entry: {
    main: 'electron/main.ts',
    index: 'server/index.ts',
    chatCrypto: 'src/chat/crypto.ts',
    devicePlatform: 'src/devicePlatform.ts',
    diagnosticData: 'src/diagnosticData.ts',
    discovery: 'electron/discovery.ts',
  },
  format: ['esm'],
  outDir: 'dist-electron',
  target: 'node24',
  clean: true,
  external: [
    'electron-log/main',
    'electron',
    'ws',
    'fastify',
    '@fastify/static',
    '@fastify/cors',
    '@fastify/websocket',
    'bonjour-service',
  ],
  removeNodeProtocol: false,
  splitting: true,
  sourcemap: false,
});
