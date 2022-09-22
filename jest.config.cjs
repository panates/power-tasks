module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testEnvironment: 'node',
  verbose: true,
  forceExit: true,
  detectOpenHandles: true,
  testMatch: [
    '<rootDir>/test/**/*.spec.ts'
  ],
  testPathIgnorePatterns: ['/node_modules/'],
  transform: {
    '^.+.ts?$': ['ts-jest', {
      'tsconfig': '<rootDir>/test/tsconfig.json'
    }]
  },
  moduleNameMapper: {
    '^(\\..+)\\.js$': '$1'
  },
  extensionsToTreatAsEsm: ['.ts'],
  coverageDirectory: "<rootDir>/coverage/",
};
