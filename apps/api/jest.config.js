/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  // *.e2e.spec.ts nécessitent Postgres + Redis — exclus du job test:unit en CI
  testMatch: ['**/*.spec.ts', '**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', '\\.e2e\\.spec\\.ts$'],
  passWithNoTests: true,
};
