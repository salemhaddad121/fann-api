// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * The backend's first lint configuration.
 *
 * `npm run lint` has been in package.json since the beginning and has never
 * run: ESLint 9 and later look for a flat `eslint.config.*` and this repo
 * had none, and `eslint` itself was not even installed. Every invocation
 * failed before reading a line of source, so the API has had no linting at
 * any point in its life — which is why the audit found dead imports and an
 * unused variable or two that no tool was ever in a position to mention.
 *
 * Deliberately not type-aware (no `recommendedTypeChecked`). Turning that on
 * against 141 files that have never been linted produces hundreds of
 * findings in one go, which is a rewrite disguised as a config change. This
 * is the floor: real errors, no formatting opinions, and a build that goes
 * green today so the next change is the one that has to stay clean.
 */
export default tseslint.config(
  {
    // dist/ is build output; coverage/ is jest's. Neither is source.
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', '*.js', '*.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: { sourceType: 'module' },
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        __dirname: 'readonly',
      },
    },
    rules: {
      // `any` is load-bearing in this codebase: Knex rows are untyped, and
      // the pg driver's error shape is checked structurally. Flagging every
      // one would bury the findings that matter.
      '@typescript-eslint/no-explicit-any': 'off',

      // An unused import or variable is the class of thing this config
      // exists to catch — it is exactly what went unnoticed for a year.
      // Leading-underscore names are the established opt-out for a
      // parameter that must exist to reach the one after it.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          // Destructuring is how this codebase drops a field on purpose:
          // `const { passwordHash, ...safe } = user`. The discarded name is
          // the point, not an oversight.
          ignoreRestSiblings: true,
        },
      ],

      // Nest constructors are `constructor(private readonly x: X) {}` —
      // empty by design, and that is the framework's idiom, not a mistake.
      'no-empty-function': 'off',
      '@typescript-eslint/no-empty-function': 'off',
    },
  },
  {
    // Tests reach into privates to assert on loggers and call mocks with
    // deliberately wrong shapes. Both are fine in a spec and nowhere else.
    files: ['**/*.spec.ts', 'src/test-utils/**/*.ts'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeAll: 'readonly',
        beforeEach: 'readonly',
        afterAll: 'readonly',
        afterEach: 'readonly',
        jest: 'readonly',
        console: 'readonly',
        process: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
);
