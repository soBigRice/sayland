import { spawn } from 'node:child_process';
// Keep both processes owned by this launcher so Ctrl-C leaves no orphan servers.
const children = [['node_modules/tsx/dist/cli.mjs', 'apps/api/src/server.ts'], ['node_modules/vite/bin/vite.js', '--config', 'apps/web/vite.config.ts']].map(args => spawn(process.execPath, args, { stdio: 'inherit' }));
let stopping = false;
function stop(code = 0) { if(stopping)return; stopping = true; for(const child of children)child.kill('SIGTERM'); setTimeout(()=>{for(const child of children)child.kill('SIGKILL'); process.exit(code);}, 1500).unref(); }
for(const signal of ['SIGINT','SIGTERM'])process.on(signal, ()=>stop());
for(const child of children)child.on('exit', code=>{ if(!stopping)stop(code??1); });
