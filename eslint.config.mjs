import js from '@eslint/js';
import globals from 'globals';
import stylistic from '@stylistic/eslint-plugin';

export default [
    {
        ignores: ['node_modules/**'],
    },
    js.configs.recommended,
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'commonjs',
            globals: {
                ...globals.node,
            },
        },
        plugins: {
            '@stylistic': stylistic,
        },
        rules: {
            '@stylistic/indent': ['error', 4],
            '@stylistic/linebreak-style': ['error', 'unix'],
            '@stylistic/quotes': ['error', 'single'],
            '@stylistic/semi': ['error', 'always'],
        },
    },
];
