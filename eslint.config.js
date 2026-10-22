// Flat ESLint for the whole tree (scripts/, src/, test/). Plain JS, so @eslint/js recommended (no TypeScript
// plugin). The code under src/utils started as eco-stake/restake and carries this bot's patches; it is linted
// like the rest. Prettier owns formatting of the files it checks (see package.json) —
// eslint-config-prettier (last) disables any rule that would fight it.
import js from '@eslint/js'
import globals from 'globals'
import prettier from 'eslint-config-prettier'

export default [
  { ignores: ['node_modules/**', 'page/**'] },
  {
    files: ['**/*.mjs'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node, fetch: 'readonly' },
    },
  },
  prettier,
]
