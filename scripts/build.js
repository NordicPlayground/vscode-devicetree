/* Copyright (c) 2021 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-1-Clause
 */

const esbuild = require('esbuild');
const path = require('path');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const base = path.join(__dirname, '../');
const outputDir = 'dist';

const y = yargs(hideBin(process.argv)).options({
    watch: {
        describe: 'Watches extension files and rebuilds on change.',
        type: 'boolean',
    },
    production: {
        describe: 'Enables production optimisations.',
        type: 'boolean',
    },
}).argv;

/** @type esbuild.BuildOptions */
const common = {
    bundle: true,
    minify: y.production,
    watch: y.watch && {
        onRebuild(error) {
            if (!error) {
                console.log('[watch] extension rebuilt');
            }
        },
    },
    format: 'cjs',
    target: 'es6',
    sourcemap: y.production ? undefined : 'inline',
};

function buildMainExtension() {
    console.log('Building main extension...');

    return esbuild.build({
        ...common,
        platform: 'node',
        external: ['vscode'],
        entryPoints: [path.join(base, 'src', 'extension.ts')],
        outfile: path.join(base, outputDir, 'extension.js'),
    });
}

async function build() {
    if (y.production) {
        console.log('Packaging for production.');
    }
    if (y.watch) {
        console.log('[watch] build started');
    }
    await buildMainExtension();
    if (y.watch) {
        console.log('[watch] build finished');
    } else {
        console.log('Done.');
    }
}

build();
