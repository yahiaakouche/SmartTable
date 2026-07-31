/** Unit + integration tests (Engineering Standards §10) — co-located *.spec.ts
 * files. E2E tests run separately via test/jest-e2e.json. */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.spec.ts'],
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  moduleNameMapper: {
    '^@smarttable/shared-types$': '<rootDir>/../../packages/shared-types/src',
  },
};
