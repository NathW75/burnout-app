/** @type {import('jest').Config} */
module.exports = {
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.test.json' }] },
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  moduleNameMapper: { '^@burnout/test-support$': '<rootDir>/../test-support/src/index.ts' },
  globalSetup: '<rootDir>/../test-support/src/global-setup.ts',
  maxWorkers: 4,
  testTimeout: 30000,
};
