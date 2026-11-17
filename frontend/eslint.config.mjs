import tseslint from 'typescript-eslint';
export default tseslint.config(
  { ignores: ['dist/**', 'release/**', 'test-results/**', 'playwright-report/**', 'electron/**', '**/.cache/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
