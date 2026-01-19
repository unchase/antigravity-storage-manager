module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    testMatch: ['**/src/test/unit/**/*.test.ts'],
    moduleFileExtensions: ['ts', 'js'],
    moduleNameMapper: {
        '^vscode$': 'jest-mock-vscode',
    },
    transform: {
        '^.+\\.ts$': 'ts-jest',
    },
    verbose: true,
};
