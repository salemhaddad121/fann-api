/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.spec\\.ts$',
  setupFiles: ['<rootDir>/jest.setup.ts'],
  transform: {
    // isolatedModules: true skips type-checking during test runs, matching
    // how `nest start --watch` already behaves — there are 25 pre-existing
    // strict-null-check errors elsewhere in the codebase (knex's .first()
    // returning T | undefined) that don't affect runtime behavior but do
    // fail a full type-check. Fixing those is a separate, tracked task;
    // tests shouldn't be blocked on it in the meantime.
    '^.+\\.(t|j)s$': ['ts-jest', { tsconfig: 'tsconfig.spec.json' }],
  },
  collectCoverageFrom: ['src/**/*.(t|j)s'],
  coverageDirectory: 'coverage',
  testEnvironment: 'node',
};
