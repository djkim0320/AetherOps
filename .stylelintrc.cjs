module.exports = {
  extends: ["stylelint-config-standard", "stylelint-config-css-modules"],
  rules: {
    "import-notation": "string",
    "selector-class-pattern": [
      "^[a-z][a-zA-Z0-9-]*(?:__[a-z][a-zA-Z0-9-]*)?(?:--[a-z][a-zA-Z0-9-]*)?$",
      { message: "Use kebab-case, camelCase CSS Module names, or structured BEM names." }
    ]
  },
  overrides: [
    {
      files: ["src/renderer/styles/tokens.css"],
      rules: {
        "color-hex-length": "long",
        "custom-property-empty-line-before": null,
        "value-keyword-case": ["lower", { ignoreKeywords: ["Consolas"] }]
      }
    }
  ]
};
