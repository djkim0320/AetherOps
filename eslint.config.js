import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

const sourceFiles = ["**/*.{js,mjs,cjs,ts,tsx}"];

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "dist-server/**",
      "node_modules/**",
      ".tmp/**",
      ".aetherops/**",
      "coverage/**",
      "playwright-report/**",
      "package-lock.json",
      "vendor/**",
      "docs/**"
    ]
  },
  {
    files: sourceFiles,
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.node
      }
    }
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "no-undef": "off"
    }
  },
  {
    files: ["src/core/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["node:*", "react", "react/*", "react-dom", "react-dom/*", "playwright", "playwright/*"],
              message: "Core domain modules must stay platform-free."
            },
            { group: ["**/server/**", "**/renderer/**"], message: "Core domain modules cannot import outer layers." }
          ]
        }
      ]
    }
  },
  {
    files: ["src/renderer/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["node:*", "**/core/**", "**/server/**", "**/migration/**", "**/shared/**"],
              message: "Renderer cross-layer dependencies must go through src/contracts/api-v2."
            }
          ]
        }
      ]
    }
  },
  {
    files: ["src/contracts/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["node:*", "react", "react/*", "playwright", "playwright/*", "**/core/**", "**/server/**", "**/renderer/**", "**/migration/**"],
              message: "API contracts may depend only on Zod and the shared kernel."
            }
          ]
        }
      ]
    }
  },
  {
    files: ["**/*.{jsx,tsx}"],
    plugins: {
      "react-hooks": reactHooks
    },
    rules: {
      ...reactHooks.configs.recommended.rules
    }
  }
);
