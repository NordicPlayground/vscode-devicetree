/* Copyright (c) 2021 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-1-Clause
 */

import * as vscode from 'vscode';
import * as dts from './dts';
import { DeviceTree, Context, InfoItem, File } from '../api';
import { TreeInfoItem, iconPath, treeView } from './treeView';
import { DTSDocumentProvider } from './compiledOutput';
import * as zephyr from './zephyr';
import { secondaryActivate } from './extension';

function packFile(file: dts.DTSFile): File {
    const getIncludes = (uri: vscode.Uri): vscode.Uri[] => {
        return file.includes.filter((i) => i.loc.uri.fsPath === uri.fsPath).map((i) => i.dst);
    };

    const packIncludeStatement = (uri: vscode.Uri): File => {
        return {
            uri,
            includes: getIncludes(uri).map(packIncludeStatement),
        };
    };

    const includes = getIncludes(file.uri);
    return {
        uri: file.uri,
        includes: includes.map(packIncludeStatement),
    };
}

function packCtx(ctx: dts.DTSCtx): Context {
    return {
        overlays: ctx.overlays.map(packFile),
        boardFile: packFile(ctx.boardFile),
        name: ctx.name,
        id: ctx.id,
    };
}

function packInfoItem(item: TreeInfoItem): InfoItem {
    const packed = { ...item.treeItem } as InfoItem;
    packed.children = item.children.map(packInfoItem);
    return packed;
}

export class API implements DeviceTree {
    private _changeEmitter = new vscode.EventEmitter<Context>();
    onChange = this._changeEmitter.event;
    icons = {
        dts: iconPath('devicetree-inner'),
        adc: iconPath('adc'),
        bus: iconPath('bus'),
        board: iconPath('circuit-board'),
        clock: iconPath('clock'),
        dac: iconPath('dac'),
        flash: iconPath('flash'),
        gpio: iconPath('gpio'),
        interrupts: iconPath('interrupts'),
        overlay: iconPath('overlay'),
        shield: iconPath('shield'),
        addShield: iconPath('add-shield'),
        removeShield: iconPath('remove-shield'),
    };
    version = 1;

    /**
     * Configuration provided by peer extension for the activation
     */
    public activationCfg: {
        zephyrBase?: string;
    };

    constructor() {
        dts.parser.onStable((ctx) => {
            this._changeEmitter.fire(packCtx(ctx));
        });

        this.activationCfg = {
            zephyrBase: undefined,
        };
    }

    async secondaryActivate(): Promise<void> {
        await secondaryActivate();
    }

    async addContext(
        boardUri: vscode.Uri,
        overlays: vscode.Uri[] = [],
        name?: string
    ): Promise<Context> {
        const ctx =
            dts.parser.contexts.find(
                (ctx) =>
                    ctx.overlays.length === overlays.length &&
                    ctx.overlays.every((overlay) =>
                        overlays.find((uri) => uri.fsPath === overlay.uri.fsPath)
                    ) &&
                    ctx.board?.uri.fsPath === boardUri.fsPath
            ) ?? (await dts.parser.addContext(boardUri, overlays, name));

        if (ctx) {
            ctx.external = true;
            return packCtx(ctx);
        }

        return Promise.reject();
    }

    async setZephyrBase(uri: vscode.Uri): Promise<void> {
        return zephyr.setZephyrBase(uri);
    }

    removeContext(id: number) {
        const ctx = dts.parser.ctx(id);
        if (ctx) {
            dts.parser.removeCtx(ctx);
        }
    }

    setOverlays(id: number, overlays: vscode.Uri[]) {
        const ctx = dts.parser.ctx(id);
        if (ctx) {
            ctx.setOverlays(overlays);
            dts.parser.reparse(ctx);
        }
    }

    getContext(id: number): Context | undefined {
        const ctx = dts.parser.ctx(id);
        if (ctx) {
            return packCtx(ctx);
        }
    }

    getDetails(id: number): InfoItem | undefined {
        const ctx = dts.parser.ctx(id);
        if (ctx) {
            return packInfoItem(treeView.details(ctx));
        }
    }

    preview(id: number, options?: vscode.TextDocumentShowOptions) {
        const ctx = dts.parser.ctx(id);
        if (ctx) {
            DTSDocumentProvider.open(ctx, options);
        }
    }
}
