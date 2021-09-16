/* Copyright (c) 2021 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-1-Clause
 */

import * as vscode from 'vscode';

const settingsNamespace = 'devicetree';

/**
 * All config entries under the settings namespace and their types:
 * Note that values without defaults in the manifest may be `null`.
 *
 * See `package.json` for ncs to see the information on each property.
 */
interface ConfigEntries {
    modules: string[];
    zephyr: string | null;
    ctxFile: string | null;
    defaultBoard: string | null;
}

type ConfigId = keyof ConfigEntries;

/**
 * This class provides typed access to all configuration variables under the configured settings namespace,
 * as well as onChange events and a couple of utility functions.
 */
class ConfigurationReader implements vscode.Disposable {
    private _updateSubscription: vscode.Disposable;
    private _config: vscode.WorkspaceConfiguration;
    private _emitters: { [id: string]: vscode.EventEmitter<ConfigId> };

    constructor() {
        this._config = vscode.workspace.getConfiguration(settingsNamespace);
        this._emitters = {};
        this._updateSubscription = vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration(settingsNamespace)) {
                this._config = vscode.workspace.getConfiguration(settingsNamespace);
                Object.entries(this._emitters)
                    .filter(([id]) => e.affectsConfiguration(this.id(id as ConfigId)))
                    .forEach(([id, emitter]) => emitter.fire(id as ConfigId));
            }
        });
    }

    private id<K extends ConfigId>(id: K): string {
        return `${settingsNamespace}.${id}`;
    }

    set<K extends ConfigId, T = ConfigEntries[K]>(
        id: K,
        value: T,
        target = vscode.ConfigurationTarget.Workspace
    ): Thenable<void> {
        return this._config.update(id, value, target);
    }

    get<K extends ConfigId, T = ConfigEntries[K]>(id: K): T {
        return this._config.get(id) as T;
    }

    onChange(id: ConfigId, cb: (id: ConfigId) => unknown): vscode.Disposable {
        if (!(id in this._emitters)) {
            this._emitters[id] = new vscode.EventEmitter<ConfigId>();
        }

        return this._emitters[id].event(cb);
    }

    dispose(): void {
        Object.values(this._emitters).forEach((emitter) => emitter.dispose());
        this._updateSubscription.dispose();
    }

    /**
     * Open the settings UI focused on the given configuration ID.
     *
     * @param id Configuration ID
     */
    configureSetting<K extends ConfigId>(id: K) {
        vscode.commands.executeCommand('workbench.action.openSettings', this.id(id));
    }
}

/**
 * Configuration singleton that provides typed access to all configuration variables under the
 * configured settings namespace, as well as onChange events and a couple of utility functions.
 */
export const config = new ConfigurationReader();
