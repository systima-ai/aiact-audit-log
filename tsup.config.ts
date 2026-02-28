import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      'ai-sdk/index': 'src/ai-sdk/index.ts',
      'ai-sdk/middleware/index': 'src/ai-sdk/middleware/index.ts',
    },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    outDir: 'dist',
    external: ['@aws-sdk/client-s3', 'ai'],
  },
  {
    entry: {
      'cli/index': 'src/cli/index.ts',
    },
    format: ['esm'],
    dts: false,
    sourcemap: true,
    outDir: 'dist',
    banner: {
      js: '#!/usr/bin/env node',
    },
    external: ['@aws-sdk/client-s3'],
  },
])
