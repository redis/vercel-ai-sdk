import type { NextConfig } from 'next';

// Pin the project root so Next.js doesn't pick up the repository root's lockfile.
const root = import.meta.dirname;

const config: NextConfig = {
  outputFileTracingRoot: root,
  turbopack: { root },
};

export default config;
