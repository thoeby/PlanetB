// Flat config, no plugins and no imports: CLAUDE.md keeps the client free of
// npm packages, and a lint config that needs its own dependency tree is the
// first crack in that. eslint's built-in rules only.

const browser = {
    document: 'readonly', window: 'readonly', fetch: 'readonly', atob: 'readonly',
    URLSearchParams: 'readonly', FormData: 'readonly', console: 'readonly',
    setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
    clearInterval: 'readonly', performance: 'readonly', caches: 'readonly',
    Request: 'readonly', Response: 'readonly', Headers: 'readonly',
    requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly',
};

const node = {
    process: 'readonly', console: 'readonly', Buffer: 'readonly',
    __dirname: 'readonly', URL: 'readonly', setTimeout: 'readonly',
    fetch: 'readonly', atob: 'readonly', URLSearchParams: 'readonly',
};

const rules = {
    'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    'no-undef': 'error',
    'no-var': 'error',
    'prefer-const': 'error',
    eqeqeq: ['error', 'smart'],
    'no-implicit-coercion': 'error',
    'no-console': 'off',
    indent: ['error', 4, { SwitchCase: 1 }],
    quotes: ['error', 'single', { avoidEscape: true }],
    semi: ['error', 'always'],
    'comma-dangle': ['error', 'always-multiline'],
    'max-len': ['error', { code: 100, ignoreUrls: true }],
    // CLAUDE.md: functions under 60 lines, files under 400.
    'max-lines': ['error', { max: 400, skipBlankLines: false }],
    'max-lines-per-function': ['error', { max: 60, skipBlankLines: false, skipComments: true }],
};

export default [
    { ignores: ['node_modules/**', 'client/vendor/**', 'infra/files/**'] },
    {
        files: ['client/**/*.js'],
        languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: browser },
        rules,
    },
    {
        files: ['client/test/**/*.js', 'tools/**/*.mjs', 'eslint.config.js',
            'playwright.config.js'],
        languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: node },
        rules,
    },
    {
        // page.evaluate() bodies run in the browser, not in node.
        files: ['client/test/e2e/**/*.spec.js'],
        languageOptions: {
            ecmaVersion: 2023, sourceType: 'module', globals: { ...node, ...browser },
        },
        rules,
    },
];
