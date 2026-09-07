import tseslint from "typescript-eslint";

/** High-signal checks that stay fast enough for local and CI use. */
export default tseslint.config(
  {
    ignores: ["data/**", "dist/**", "node_modules/**", "web/**"],
  },
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    linterOptions: {
      reportUnusedDisableDirectives: "off",
    },
    rules: {
      "no-constant-binary-expression": "error",
      "no-dupe-else-if": "error",
      "no-duplicate-imports": "error",
      "no-unreachable": "error",
      "@typescript-eslint/no-duplicate-enum-values": "error",
      "@typescript-eslint/no-non-null-asserted-optional-chain": "error",
    },
  },
);
