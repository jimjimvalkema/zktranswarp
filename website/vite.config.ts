import { defineConfig, loadEnv } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, './', '')
  return {
    server: {
      allowedHosts: ['eip7503-erc20.jimjim.dev', 'erc20-eip7503.jimjim.dev', 'zktranswarp.jimjim.dev'],
    },
    define: {
      'process.env.ETHEREUM_RPC': JSON.stringify(env.ETHEREUM_RPC),
    },
    plugins: [
      nodePolyfills(),
      {
        name: "configure-response-headers",
        configureServer: (server) => {
          server.middlewares.use((_req, res, next) => {
            res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
            res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
            next();
          });
        },
      },
    ],
    optimizeDeps: {
      esbuildOptions: {
        target: 'esnext',  // Keeps top-level await support for bb.js/acvm_js
      },
      exclude: [
        '@aztec/bb.js',      // Add if not present; prevents bundling issues
        '@noir-lang/noirc_abi',
        '@noir-lang/acvm_js',  // Keep this for raw WASM loading
      ],
    },
    resolve: {
      alias: {
        pino: "pino/browser.js",
      },
    },
  }
});