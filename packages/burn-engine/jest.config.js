/** @type {import('jest').Config} */
module.exports = {
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.test.json' }] },
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  moduleNameMapper: {
    '^@burnout/db$': '<rootDir>/../db/src/index.ts',
    '^@burnout/shared$': '<rootDir>/../shared/src/index.ts',
    '^@burnout/test-support$': '<rootDir>/../test-support/src/index.ts',
  },
  globalSetup: '<rootDir>/../test-support/src/global-setup.ts',
  // Integration suites each create their own database from a template; keep
  // file-level parallelism modest so Postgres connection limits are not hit.
  maxWorkers: 4,
  testTimeout: 30000,
};
