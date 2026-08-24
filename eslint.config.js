const js = require('@eslint/js')
const tseslint = require('typescript-eslint')

const typedFiles = [
  'apps/**/*.{ts,tsx}',
  'packages/**/*.{ts,tsx}',
  'scripts/**/*.ts',
  'tests/**/*.ts',
]

module.exports = tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'content/raw/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/reports/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['eslint.config.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        __dirname: 'readonly',
        module: 'readonly',
        require: 'readonly',
      },
    },
  },
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: typedFiles,
  })),
  {
    files: typedFiles,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
        },
      ],
    },
  },
)
