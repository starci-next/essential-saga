// End-to-end specs: they drive the four running services over HTTP (start them first with `npm run up`).
/** @type {import('jest').Config} */
module.exports = {
    testMatch: ["<rootDir>/test/e2e/**/*.e2e-spec.ts"],
    transform: { "^.+\.ts$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.json" }] },
    testEnvironment: "node",
    testTimeout: 120_000,
}
