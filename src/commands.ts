/* Copyright (c) 2021 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-1-Clause
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

import * as dts from './dts';
import * as zephyr from './zephyr';
import { treeView } from './treeView';
import { toCIdentifier } from './names';

export async function newApp() {
    const folder = await vscode.window
        .showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: 'Select folder',
            defaultUri: vscode.window.activeTextEditor?.document
                ? vscode.Uri.file(
                      path.dirname(vscode.window.activeTextEditor?.document?.uri.fsPath)
                  )
                : vscode.workspace.workspaceFolders?.[0].uri,
        })
        .then(
            (uris) => uris?.[0].fsPath,
            () => undefined
        );

    if (!folder) {
        return;
    }

    const board = await zephyr.selectBoard();
    if (!board) {
        return;
    }
    const file = path.join(folder, board.name + '.overlay');
    if (!fs.existsSync(file)) {
        fs.writeFileSync(file, '');
    }

    vscode.window.showTextDocument(vscode.Uri.file(file));
}

export async function ctxAddShield() {
    if (dts.parser.currCtx && vscode.window.activeTextEditor?.document.languageId === 'dts') {
        const options = <vscode.OpenDialogOptions>{
            canSelectFiles: true,
            openLabel: 'Add shield file',
            canSelectMany: true,
            defaultUri: vscode.Uri.file(path.resolve(zephyr.zephyrRoot, 'boards', 'shields')),
            filters: { DeviceTree: ['dts', 'dtsi', 'overlay'] },
        };
        vscode.window.showOpenDialog(options).then((uris) => {
            if (uris) {
                dts.parser.insertOverlays(...uris).then(() => {
                    this.saveCtxs();
                    if (uris.length === 1) {
                        vscode.window.showInformationMessage(
                            `Added shield overlay ${path.basename(uris[0].fsPath)}.`
                        );
                    } else {
                        vscode.window.showInformationMessage(
                            `Added ${uris.length} shield overlays.`
                        );
                    }
                });
            }
        });
    }
}

export async function ctxRename(ctx?: dts.DTSCtx) {
    ctx = ctx ?? dts.parser.currCtx;
    if (!ctx) {
        return;
    }

    vscode.window
        .showInputBox({ prompt: 'New DeviceTree context name', value: ctx.name })
        .then((value) => {
            if (value) {
                ctx._name = value;
                treeView.update();
                this.saveCtxs();
            }
        });
}

export async function ctxDelete(ctx?: dts.DTSCtx) {
    ctx = ctx ?? dts.parser.currCtx;
    if (!ctx || !(ctx instanceof dts.DTSCtx)) {
        return;
    }

    const deleteCtx = () => {
        dts.parser.removeCtx(ctx);
    };

    // Only prompt if this context actually took some effort
    if (ctx.overlays.length > 1 || ctx._name) {
        vscode.window
            .showWarningMessage(
                `Delete devicetree context "${ctx.name}"?`,
                { modal: true },
                'Delete'
            )
            .then((button) => {
                if (button === 'Delete') {
                    deleteCtx();
                }
            });
    } else {
        deleteCtx();
    }
}

export async function ctxSetBoard(file?: dts.DTSFile) {
    const ctx = file?.ctx ?? dts.parser.currCtx;
    if (!ctx) {
        return;
    }

    zephyr.selectBoard().then((board) => {
        if (board) {
            dts.parser.setBoard(board, ctx).then(() => {
                this.saveCtxs();
            });
        }
    });
}

export async function getMacro() {
    const ctx = dts.parser.currCtx;
    const selection = vscode.window.activeTextEditor?.selection;
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (!ctx || !selection || !uri) {
        return;
    }

    const nodeMacro = (node: dts.Node) => {
        const labels = node.labels();
        if (labels.length) {
            return `DT_NODELABEL(${toCIdentifier(labels[0])})`;
        }

        const alias = ctx
            .node('/alias/')
            ?.properties()
            .find((p) => p.pHandle?.is(node));
        if (alias) {
            return `DT_ALIAS(${toCIdentifier(alias.pHandle.val)})`;
        }

        const chosen = ctx
            .node('/chosen/')
            ?.properties()
            .find((p) => p.pHandle?.is(node));
        if (chosen) {
            return `DT_CHOSEN(${toCIdentifier(alias.pHandle.val)})`;
        }

        if (node.parent) {
            const parent = nodeMacro(node.parent);

            // better to do DT_PATH(a, b, c) than DT_CHILD(DT_CHILD(a, b), c)
            if (!parent.startsWith('DT_NODELABEL(')) {
                return `DT_PATH(${toCIdentifier(
                    node.path.slice(1, node.path.length - 1).replace(/\//g, ', ')
                )})`;
            }

            return `DT_CHILD(${parent}, ${toCIdentifier(node.fullName)})`;
        }

        return `DT_ROOT`;
    };

    const propMacro = (prop: dts.Property) => {
        // Selecting the property name
        if (prop.loc.range.contains(selection)) {
            if (prop.name === 'label') {
                return `DT_LABEL(${nodeMacro(prop.node)})`;
            }

            // Not generated for properties like #gpio-cells
            if (prop.name.startsWith('#')) {
                return;
            }

            return `DT_PROP(${nodeMacro(prop.node)}, ${toCIdentifier(prop.name)})`;
        }

        // Selecting a phandle. Should return the property reference, not the node or cell that's being pointed to,
        // so that if the value changes, the reference will still be valid.
        const val = prop.valueAt(selection.start, uri);
        if (val instanceof dts.ArrayValue) {
            const cell = val.cellAt(selection.start, uri);
            if (cell instanceof dts.PHandle) {
                if (prop.value.length > 1) {
                    return `DT_PHANDLE_BY_IDX(${nodeMacro(prop.node)}, ${toCIdentifier(
                        prop.name
                    )}, ${prop.value.indexOf(val)})`;
                }

                return `DT_PHANDLE(${nodeMacro(prop.node)}, ${toCIdentifier(prop.name)})`;
            }

            if (prop.name === 'reg') {
                const valIdx = prop.value.indexOf(val);
                const cellIdx = val.val.indexOf(cell);
                const names = prop.cellNames(ctx);
                if (names?.length) {
                    const name = names?.[valIdx % names.length]?.[cellIdx];
                    if (name) {
                        if (prop.regs?.length === 1) {
                            // Name is either size or addr
                            return `DT_REG_${name.toUpperCase()}(${nodeMacro(prop.node)})`;
                        }

                        // Name is either size or addr
                        return `DT_REG_${name.toUpperCase()}_BY_IDX(${nodeMacro(
                            prop.node
                        )}, ${valIdx})`;
                    }
                }
            }

            if (val.isNumberArray()) {
                const cellIdx = val.val.indexOf(cell);
                return `DT_PROP_BY_IDX(${nodeMacro(prop.node)}, ${prop.name}, ${cellIdx})`;
            }

            const names = prop.cellNames(ctx);
            if (names?.length) {
                const idx = val.val.indexOf(cell);
                if (idx >= 0) {
                    return `DT_PROP(${nodeMacro(prop.node)}, ${toCIdentifier(prop.name)})`;
                }
            }
        }
    };

    let macro: string;
    if (this.compiledDocProvider.is(uri)) {
        const entity = await this.compiledDocProvider.getEntity(selection.start);
        if (entity instanceof dts.Node) {
            macro = nodeMacro(entity);
        } else if (entity instanceof dts.Property) {
            macro = propMacro(entity);
        }
    } else {
        const prop = ctx.getPropertyAt(selection.start, uri);
        if (prop) {
            macro = propMacro(prop);
        } else {
            const entry = ctx.getEntryAt(selection.start, uri);
            if (entry?.nameLoc.range.contains(selection.start)) {
                macro = nodeMacro(entry.node);
            }
        }
    }

    if (macro) {
        vscode.env.clipboard
            .writeText(macro)
            .then(() => vscode.window.setStatusBarMessage(`Copied "${macro}" to clipboard`, 3000));
    }
}

export async function edit() {
    const ctx = dts.parser.currCtx;
    const selection = vscode.window.activeTextEditor?.selection;
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (!ctx || !selection || !uri) {
        return;
    }

    if (!ctx.overlays.length) {
        vscode.window.showErrorMessage('No overlayfile');
        return;
    }

    const overlay = [...ctx.overlays].pop();
    const doc = await vscode.workspace.openTextDocument(overlay.uri);

    if (uri.toString() === doc.uri.toString()) {
        return; // already in this file
    }

    const editNode = async (node: dts.Node, insertText = '') => {
        const edit = new vscode.WorkspaceEdit();

        let text = insertText;
        let it = node;
        let lineOffset = 0;
        let charOffset = insertText.length;
        while (it) {
            const shortName = (it.labels().length && it.refName) || (!it.parent && '/');
            text = (shortName || it.fullName) + ' {\n\t' + text.split('\n').join('\n\t') + '\n};';
            lineOffset += 1;
            charOffset += 1;

            if (shortName) {
                break;
            }

            it = it.parent;
        }
        const insert = new vscode.Position(doc.lineCount, 0);

        edit.insert(doc.uri, insert, '\n' + text + '\n');

        vscode.workspace.applyEdit(edit);
        const e =
            vscode.window.visibleTextEditors.find(
                (e) => e.document?.uri.toString() === doc.uri.toString()
            ) ?? (await vscode.window.showTextDocument(doc));
        if (e) {
            e.revealRange(new vscode.Range(insert, insert), vscode.TextEditorRevealType.Default);
            const cursor = new vscode.Position(insert.line + lineOffset, charOffset);
            e.selection = new vscode.Selection(cursor, cursor);
        }
    };

    if (this.compiledDocProvider.is(uri)) {
        const entity = await this.compiledDocProvider.getEntity(selection.start);
        if (entity instanceof dts.Node) {
            editNode(entity);
        } else if (entity instanceof dts.Property) {
            editNode(entity.node, entity.name + ' = ');
        }
        return;
    }

    const prop = ctx.getPropertyAt(selection.start, uri);
    if (prop) {
        editNode(prop.node, prop.name + ' = ');
    } else {
        const entry = ctx.getEntryAt(selection.start, uri);
        if (entry?.nameLoc.range.contains(selection.start)) {
            editNode(entry.node);
        }
    }
}

export async function goTo(p: string, uri?: vscode.Uri) {
    const ctx = uri ? dts.parser.ctx(uri) : dts.parser.currCtx;

    let loc: vscode.Location;
    if (p.endsWith('/')) {
        loc = ctx?.node(p)?.entries[0]?.nameLoc;
    } else {
        loc = ctx?.node(path.dirname(p))?.property(path.basename(p))?.loc;
    }

    if (loc) {
        const doc = await vscode.workspace.openTextDocument(loc.uri);
        const editor = await vscode.window.showTextDocument(doc);
        editor.revealRange(loc.range);
        editor.selection = new vscode.Selection(loc.range.start, loc.range.start);
    }
}
