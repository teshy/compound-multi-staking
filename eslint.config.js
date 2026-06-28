// Minimal flat ESLint for the single-file public bot (compound.mjs). This repo is plain
// JS, so it uses @eslint/js recommended (no TypeScript plugin). The vendored src/ utils
// (eco-stake/restake, pinned upstream) are excluded. Prettier owns formatting —
// eslint-config-prettier (last) disables any rule that would fight it.
import js from '@eslint/js'
import globals from 'globals'
import prettier from 'eslint-config-prettier'

export default [
  { ignores: ['node_modules/**', 'src/**'] },
  {
    files: ['compound.mjs'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node, fetch: 'readonly' },
    },
  },
  prettier,
]
