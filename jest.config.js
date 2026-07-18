/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.spec\\.ts$',
  setupFiles: ['<rootDir>/jest.setup.ts'],
  transform: {
    // Previously used tsconfig.spec.json with isolatedModules: true to skip
    // type-checking during test runs, working around 25 pre-existing
    // strict-null-check errors elsewhere in the codebase. Those are fixed
    // now, so tests type-check against the real tsconfig.json — one less
    // moving part, and a regression that reintroduces a type error will
    // now fail `npm test` too, not just `npm run build`.
    '^.+\\.(t|j)s$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
  collectCoverageFrom: ['src/**/*.(t|j)s'],
  coverageDirectory: 'coverage',
  testEnvironment: 'node',
};
