import { spawn } from 'node:child_process';
import { createServer } from 'vite';
const server=await createServer();await server.listen();
const electron=spawn('node_modules/.bin/electron',['.'],{stdio:'inherit',env:{...process.env,RELAY3_DEV_URL:server.resolvedUrls.local[0]}});
electron.on('exit',async(code)=>{await server.close();process.exit(code??0);});
