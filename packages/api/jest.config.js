/** @type {import('jest').Config} */
module.exports = {
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.test.json' }] },
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  moduleNameMapper: {
    '^@burnout/leaderboard$': '<rootDir>/../leaderboard/src/index.ts',
    '^@burnout/payments$': '<rootDir>/../payments/src/index.ts',
    '^@burnout/test-support$': '<rootDir>/../test-support/src/index.ts',
    '^@burnout/burn-engine$': '<rootDir>/../burn-engine/src/index.ts',
    '^@burnout/scoring-engine$': '<rootDir>/../scoring-engine/src/index.ts',
    '^@burnout/db$': '<rootDir>/../db/src/index.ts',
    '^@burnout/shared$': '<rootDir>/../shared/src/index.ts',
  },
  globalSetup: '<rootDir>/../test-support/src/global-setup.ts',
  maxWorkers: 4,
  testTimeout: 30000,
};
