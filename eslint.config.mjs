// Flat config, because the ESLint that ships with @rancher/shell's toolchain is v10.
import js from '@eslint/js';
import ts from 'typescript-eslint';
import vue from 'eslint-plugin-vue';
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**',
      'dist-pkg/**',
      '.shell/**',
      'pkg/*/*.generated.ts',
      // Carried from the Dev extension's agent seed. Editing somebody else's working tool to
      // satisfy this config would risk breaking it and make re-syncing it harder, and it is not
      // this repository's code to style. Both are command-line tools, so `console.log` IS their
      // output rather than a stray debug line.
      'pkg/*/seed/workspace/browser.mjs',
      'pkg/*/seed/workspace/rancher-login.mjs',
    ],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  ...vue.configs['flat/recommended'],
  {
    files:           ['**/*.{js,mjs,ts,vue}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType:  'module',
      globals:     { ...globals.browser, ...globals.node },
      parserOptions: { parser: ts.parser },
    },
    rules: {
      // The report's vocabulary arrives as a JSON document the agent wrote, so the boundaries
      // where it is read back are deliberately loose about types.
      '@typescript-eslint/no-explicit-any':  'off',
      '@typescript-eslint/no-var-requires':  'off',
      '@typescript-eslint/no-require-imports': 'off',
      'vue/no-v-html':                       'error',
      'vue/max-attributes-per-line':         'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/html-self-closing':               'off',
      'vue/html-indent':                     'off',
      'vue/html-closing-bracket-newline':    'off',
      'vue/attributes-order':                'off',
      'no-console':                          ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['scripts/*.mjs', 'pkg/*/seed/*.mjs'],
    rules: { 'no-console': 'off' },
  },
];
