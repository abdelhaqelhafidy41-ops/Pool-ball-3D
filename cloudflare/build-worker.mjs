import esbuild from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const outDir = path.join(__dirname, 'dist');

mkdirSync(outDir, { recursive: true });

const rapierWasmSrc = path.join(
  rootDir,
  'node_modules/@dimforge/rapier3d-compat/dist/rapier_wasm3d_bg.wasm',
);
const rapierWasmDest = path.join(outDir, 'rapier_wasm3d_bg.wasm');
copyFileSync(rapierWasmSrc, rapierWasmDest);

const rapierWorkerShimPlugin = {
  name: 'rapier-cloudflare-wasm',
  setup(build) {
    build.onLoad({ filter: /@dimforge[\\/]rapier3d-compat[\\/]dist[\\/]rapier\.mjs$/ }, async (args) => {
      let source = readFileSync(args.path, 'utf8');
      const fcStart = source.indexOf('function FC()');
      const gcStart = source.indexOf('function GC()', fcStart);
      if (fcStart === -1 || gcStart === -1) {
        throw new Error('Failed to locate Rapier compat init function for Cloudflare Worker shim.');
      }

      const precompiledFc =
        'function FC(){return DC(this,void 0,void 0,(function*(){yield EI({module_or_path:__rapierWasmModule})}))}';
      source =
        'import __rapierWasmModule from "./rapier_wasm3d_bg.wasm";\n' +
        source.slice(0, fcStart) +
        precompiledFc +
        source.slice(gcStart);

      return {
        contents: source,
        loader: 'js',
      };
    });
  },
};

await esbuild.build({
  entryPoints: [path.join(__dirname, 'src/worker.ts')],
  outfile: path.join(outDir, 'worker.js'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'browser',
  conditions: ['worker', 'browser', 'import'],
  external: ['cloudflare:*', './rapier_wasm3d_bg.wasm'],
  plugins: [rapierWorkerShimPlugin],
  minify: true,
  logLevel: 'info',
});
