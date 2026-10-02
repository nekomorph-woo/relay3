import { defineConfig } from 'tsup';
export default defineConfig({entry:{main:'electron/main.ts',index:'server/index.ts'},format:['esm'],outDir:'dist-electron',target:'node24',clean:true,external:['electron','ws','fastify','@fastify/static','@fastify/cors','@fastify/websocket'],removeNodeProtocol:false,splitting:true,sourcemap:false});
