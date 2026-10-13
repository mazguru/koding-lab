import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(fileURLToPath(import.meta.url));

function cleanBuildOutputDirs() {
  return {
    name: 'clean-build-output-dirs',
    apply: 'build',
    async buildStart() {
      await Promise.all(
        ['assets', 'pyodide'].map((directory) =>
          rm(resolve(projectRoot, directory), { recursive: true, force: true })
        )
      );
    }
  };
}

export default defineConfig({
  root: 'src',
  base: './',
  plugins: [
    cleanBuildOutputDirs(),
    viteStaticCopy({
      targets: [
        {
          src: '../node_modules/pyodide/*',
          dest: 'pyodide',
          flatten: true
        }
      ]
    })
  ],
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    },
    proxy: {
      '/api.php': {
        target: 'http://localhost/koding-python',
        changeOrigin: true,
        secure: false
      }
    }
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    }
  },
  build: {
    outDir: '..',
    assetsDir: 'assets',
    emptyOutDir: false
  }
});