// Unit specs: pure logic only (the saga transitions and the retry ladder). No database, no network.
/** @type {import('jest').Config} */
module.exports = {
    testMatch: ["<rootDir>/test/unit/**/*.spec.ts"],
    transform: { "^.+\.ts$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.json" }] },
    testEnvironment: "node",
}
