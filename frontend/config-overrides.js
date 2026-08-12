// frontend/config-overrides.js
//
// react-app-rewired hook: lets us patch the Webpack config that
// react-scripts (CRA) generates internally, without ejecting.
//
// Why this file exists:
// Webpack 5 (the bundler CRA 5 / react-scripts 5.0.1 ships) dropped the
// automatic Node.js core-module polyfills that Webpack 4 used to include
// for browser bundles. Our CosmJS-based signing code (see
// `src/utils/sessionKey.ts`, which imports `@cosmjs/crypto`) pulls in
// dependencies that expect Node's `crypto`, `stream`, and `vm` modules to
// exist, which they don't in a browser -- Webpack 5 fails the build with
// "Module not found: Error: Can't resolve 'crypto'" (and similarly for
// `stream`/`vm`) instead of silently polyfilling like Webpack 4 did.
//
// Fix: explicitly map each missing core module to its browser-shimmed
// npm equivalent via `resolve.fallback`, and provide the two Node globals
// (`Buffer`/`process`) that `crypto-browserify`/`stream-browserify`
// themselves expect to find, via Webpack's ProvidePlugin.
//
// Requires (see package.json devDependencies): `react-app-rewired`,
// `crypto-browserify`, `stream-browserify`, `vm-browserify`, and (for the
// ProvidePlugin globals below) `buffer` + `process`.

const webpack = require("webpack");

module.exports = function override(config) {
  config.resolve = config.resolve || {};
  config.resolve.fallback = {
    ...(config.resolve.fallback || {}),
    crypto: require.resolve("crypto-browserify"),
    stream: require.resolve("stream-browserify"),
    vm: require.resolve("vm-browserify"),
  };

  config.plugins = (config.plugins || []).concat([
    new webpack.ProvidePlugin({
      Buffer: ["buffer", "Buffer"],
      process: "process/browser",
    }),
  ]);

  return config;
};
