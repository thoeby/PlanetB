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
    URL: 'readonly', crypto: 'readonly', navigator: 'readonly',
    ResizeObserver: 'readonly', getComputedStyle: 'readonly', CustomEvent: 'readonly',
    location: 'readonly',
    // The flow editor reads and writes XML in the page (client/flow/elx).
    DOMParser: 'readonly', XMLSerializer: 'readonly',
    TextEncoder: 'readonly', TextDecoder: 'readonly', Worker: 'readonly',
    // The atom worker's own globals (client/js/atomworker.js).
    self: 'readonly', OffscreenCanvas: 'readonly', ImageData: 'readonly',
    createImageBitmap: 'readonly', Blob: 'readonly', btoa: 'readonly',
    // canon-v1's PNG decoder inflates with the platform's own stream (png.js).
    DecompressionStream: 'readonly', Option: 'readonly',
};

const node = {
    process: 'readonly', console: 'readonly', Buffer: 'readonly',
    __dirname: 'readonly', URL: 'readonly', setTimeout: 'readonly',
    fetch: 'readonly', atob: 'readonly', URLSearchParams: 'readonly',
    Blob: 'readonly', Response: 'readonly', DecompressionStream: 'readonly',
    TextEncoder: 'readonly', TextDecoder: 'readonly',
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
        // client/flow/ is copied from the reference editor, file by file, with
        // a header saying from where and what changed. Its formatting is that
        // repository's — two spaces, double quotes — and reformatting it would
        // make every copy undiffable against its source, which is the one
        // thing the header exists to allow. So style is off here and the rules
        // that catch mistakes are not; the 400-line rule stays, because
        // splitting to it is part of what FND.1 asks for.
        // client/test/e2e/flow/ is that repository's own test suite, copied the
        // same way and for the same reason.
        files: ['client/flow/**/*.js', 'client/test/e2e/flow/**/*.js'],
        rules: {
            indent: 'off', quotes: 'off', 'comma-dangle': 'off',
            'max-len': 'off', 'max-lines-per-function': 'off',
            'no-implicit-coercion': 'off',
            // `catch (_e)` and an import the file lists but does not call are
            // the reference repository's style; they are said out loud rather
            // than made an error, because the fix belongs in that repository.
            'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
        },
        languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: browser },
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
