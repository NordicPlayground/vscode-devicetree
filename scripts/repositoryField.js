/* Copyright (c) 2021 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-1-Clause
 */

/* The test runner requires that there be a "repository" field in the
package.json file, but this leads to users seeing a private repo.
This script can remove and restore the repository field such that
both cases can be satisfied. */

const fs = require('fs');
const path = require('path');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const packageJson = require('../package.json');

const packageJsonPath = path.join(__dirname, '../package.json');

yargs(hideBin(process.argv))
    .command('remove', 'Removes the repository field from package.json.', remove)
    .command('restore', 'Restores the repository field to package.json.', restore)
    .demandCommand()
    .help().argv;

function remove() {
    delete packageJson.repository;
    const formatted = JSON.stringify(packageJson, null, 4);
    fs.writeFileSync(packageJsonPath, formatted);
    console.log('Removed "repository" field from package.json');
}

function restore() {
    packageJson.repository = {
        url: 'https://github.com/NordicPlayground/vscode-nrf-connect',
        type: 'git',
    };
    const formatted = JSON.stringify(packageJson, null, 4);
    fs.writeFileSync(packageJsonPath, formatted);
    console.log('Restored "repository" field to package.json');
}
