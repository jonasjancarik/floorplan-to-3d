import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const RENDERS = join(dirname(fileURLToPath(import.meta.url)), '..', 'out', 'renders');

// Development helper: the page can post a picture of its canvas here (see `viewer.capture`
// in src/main.js) and it is written to out/renders/<name>.jpg.
const saveRenders = () => ({
  name: 'save-renders',
  configureServer(server) {
    server.middlewares.use('/__render', (req, res) => {
      const name = (new URL(req.url, 'http://localhost').searchParams.get('name') ?? 'render').replace(/[^\w-]/g, '');
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const base64 = Buffer.concat(chunks).toString().replace(/^data:image\/\w+;base64,/, '');
        mkdirSync(RENDERS, { recursive: true });
        writeFileSync(join(RENDERS, `${name}.jpg`), Buffer.from(base64, 'base64'));
        res.end('saved');
      });
    });
  },
});

// Development helper: the model exported from the page is also written to out/flat.glb.
const saveModel = () => ({
  name: 'save-model',
  configureServer(server) {
    server.middlewares.use('/__model', (req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        writeFileSync(join(RENDERS, '..', 'flat.glb'), Buffer.concat(chunks));
        res.end('saved');
      });
    });
  },
});

// The Basis Universal transcoder that ships with three.js, served at /basis/ for KTX2Loader
// (the photos of the surroundings are KTX2) and copied there by a build.
const BASIS = join(dirname(fileURLToPath(import.meta.url)), 'node_modules', 'three', 'examples', 'jsm', 'libs', 'basis');
const BASIS_FILES = { 'basis_transcoder.js': 'text/javascript', 'basis_transcoder.wasm': 'application/wasm' };
const basisTranscoder = () => ({
  name: 'basis-transcoder',
  configureServer(server) {
    server.middlewares.use('/basis', (req, res, next) => {
      const name = req.url.replace(/^\//, '').split('?')[0];
      if (!BASIS_FILES[name]) return next();
      res.setHeader('Content-Type', BASIS_FILES[name]);
      res.end(readFileSync(join(BASIS, name)));
    });
  },
  generateBundle() {
    for (const name of Object.keys(BASIS_FILES)) this.emitFile({ type: 'asset', fileName: `basis/${name}`, source: readFileSync(join(BASIS, name)) });
  },
});

export default defineConfig({
  plugins: [saveRenders(), saveModel(), basisTranscoder()],
  server: {
    host: '0.0.0.0',
    port: 8791,
    strictPort: true,
    allowedHosts: ['.local', '.ts.net'],
    fs: { allow: ['..'] },   // the model lives in ../out
  },
  build: { target: 'esnext' },
});
