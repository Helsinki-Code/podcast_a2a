import globals from 'globals';

export default [
  { ignores: ['node_modules/**', '.next/**', 'public/*.bundle.js', 'public/clerk-runtime/**', 'data/**'] },
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } },
    rules: { 'no-undef': 'error', 'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_', caughtErrors: 'none' }], 'no-unreachable': 'error', 'no-dupe-keys': 'error', 'no-const-assign': 'error' }
  },
  { files: ['public/**/*.js', 'client/**/*.js'], languageOptions: { globals: { ...globals.browser } } }
];
