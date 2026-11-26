import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  {
    ignores: ['dist/', 'coverage/', 'node_modules/', '**/scripts/**'],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': 'warn',
      'no-restricted-syntax': [
        'warn',
        {
          selector:
            "TemplateLiteral CallExpression[callee.object.name='JSON'][callee.property.name='stringify']",
          message:
            'Use safeLog() from pii-redact.format instead of JSON.stringify when logging objects that may contain PII.',
        },
      ],
    },
  },
  // Bootstrap files: console acceptable before Nest/logger available
  {
    files: ['src/main.ts', 'src/worker.ts', 'src/app.module.ts', 'src/common/tracing/tracing.ts'],
    rules: { 'no-console': 'off' },
  },
  // Test files: relax no-explicit-any to warn (test mocks often require flexible typing)
  {
    files: ['**/*.spec.ts', '**/*.test.ts', '**/*.test.tsx'],
    rules: { '@typescript-eslint/no-explicit-any': 'warn' },
  },
];
