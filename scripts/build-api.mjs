import { build } from 'esbuild';
await build({entryPoints:['apps/api/src/server.ts'],bundle:true,platform:'node',format:'esm',target:'node22',packages:'external',outfile:'dist/api/server.mjs'});
