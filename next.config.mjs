/** @type {import('next').NextConfig} */
const nextConfig = {
  // App lives under src/ui (App Router: src/ui/app).
  // Next resolves `app` relative to `src/` by default; we point explicitly.
  // Using experimental? No — Next 13+ uses src/app; we use a custom dir via turbopack/webpack?
  // Actually Next only auto-discovers src/app or app/. So we set distDir and use
  // a symlink-free approach: configure pageExtensions and put app at src/ui/app
  // via the `dir` option is not supported at runtime for `next dev` root.
  //
  // Solution used here: document that `next dev` should run with
  //   next dev src/ui
  // or we keep pages under src/ui and set experimental output.
  //
  // Next.js 15 supports running from a subdirectory:
  //   npx next dev ./src/ui
  // The config file at repo root is still loaded when using --config, but the
  // project directory is the arg. Prefer root config + srcDir mapping:
};

// Re-export a config that works when the project root is the monorepo root
// and the app directory is src/ui/app. Next does not natively nest app under
// src/ui/, so we use the `next` CLI with `src/ui` as the project directory
// (package.json scripts). This config lives at repo root and is passed via
// --config when needed; a copy-friendly default also lives conceptually at
// src/ui — we keep one root config for simplicity.

export default {
  reactStrictMode: true,
  // Transpile local packages if needed
  transpilePackages: [],
};
