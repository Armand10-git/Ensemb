/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testMatch: ['**/*.e2e.spec.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
  // Attend que les ports éphémères Windows soient disponibles (TIME_WAIT < 13 000)
  globalSetup: '<rootDir>/test/global-setup.ts',
  // Charge le .env racine du monorepo avant chaque suite (REDIS_URL, DATABASE_URL, etc.)
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  // Ces packages sont ESM-only et incompatibles avec Jest en mode CJS + pnpm nested paths.
  // Mocks CJS-compatibles : @scure/base (base32 RFC 4648), plugins otplib (Node.js crypto natif).
  moduleNameMapper: {
    '^@scure/base$': '<rootDir>/test/__mocks__/@scure/base.ts',
    '^@otplib/plugin-crypto-noble$': '<rootDir>/test/__mocks__/@otplib/plugin-crypto-noble.ts',
    '^@otplib/plugin-base32-scure$': '<rootDir>/test/__mocks__/@otplib/plugin-base32-scure.ts',
  },
  // Sérialiser les suites e2e pour éviter la contention Redis/Postgres entre suites parallèles
  maxWorkers: 1,
  testTimeout: 60_000,
  // Forcer la sortie après les tests (connexions Redis/Postgres maintenues open par ioredis/Socket.io)
  forceExit: true,
};
