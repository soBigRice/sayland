import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
const tests=[];
async function scan(dir) { for(const entry of await readdir(dir,{withFileTypes:true})){ const path=`${dir}/${entry.name}`; if(entry.isDirectory())await scan(path); else if(entry.name.endsWith('.test.ts'))tests.push(path); } }
await scan('packages'); await scan('apps');
if(!tests.length)throw new Error('No tests found');
const child=spawn(process.execPath,['--import','tsx','--test',...tests],{stdio:'inherit'});
child.on('exit',code=>process.exit(code??1));
