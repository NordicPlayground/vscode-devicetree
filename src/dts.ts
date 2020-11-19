/*
 * Copyright (c) 2020 Trond Snekvik
 *
 * SPDX-License-Identifier: MIT
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as zephyr from './zephyr';
import { MacroInstance, Macro, preprocess, IncludeStatement, LineMacro, FileMacro, CounterMacro } from './preprocessor';
import { DiagnosticsSet } from './diags';
import { NodeType, TypeLoader } from './types';

export type DiagCollection = {uri: vscode.Uri, diags: vscode.Diagnostic[]};
// export type PropertyValue = _PropertyValue | _PropertyValue[]; // composite

abstract class PropertyValue {
    val: any;
    loc: vscode.Location;

    constructor(val: any, loc: vscode.Location) {
        this.val = val;
        this.loc = loc;
    }

    contains(pos: vscode.Position, uri: vscode.Uri) {
        return this.loc.uri.toString() === uri.toString() && this.loc.range.contains(pos);
    }

    toString(): string {
        return this.val.toString();
    }
}

export class StringValue extends PropertyValue {
    val: string;

    constructor(val: string, loc: vscode.Location) {
        super(val, loc);
    }

    static match(state: ParserState): StringValue {
        const string = state.match(/^"(.*?)"/);
        if (string) {
            return new StringValue(string[1], state.location());
        }
    }

    toString() {
        return `"${this.val}"`;
    }
}

export class BoolValue extends PropertyValue {
    val: boolean;

    constructor(loc: vscode.Location) {
        super(true, loc);
    }
}

export class IntValue extends PropertyValue {
    val: number;
    hex: boolean;

    protected constructor(val: number, loc: vscode.Location, hex=false) {
        super(val, loc);
        this.hex = hex;
    }

    static match(state: ParserState): IntValue {
        const number = state.match(/^(0x[\da-fA-F]+|\d+)\b/);
        if (number) {
            return new IntValue(Number.parseInt(number[1]), state.location(), number[1].startsWith('0x'));
        }
    }

    toString(raw=false): string {
        const val = this.hex ? `0x${this.val.toString(16)}` : this.val.toString();
        return raw ? val : `< ${val} >`;
    }
}

export class Expression extends IntValue {
    raw: string;
    actual: string;

    private constructor(raw: string, actual: any, loc: vscode.Location) {
        super(actual, loc);
        this.raw = raw;
    }

    static match(state: ParserState): Expression {
        const start = state.freeze();
        let m = state.match(/^\(/);
        if (!m) {
            return undefined;
        }

        let level = 1;
        let text = '(';
        while (level !== 0) {
            m = state.match(/^(?:(?:<<|>>|&&|\|\||[!=<>]=|[|&~^<>!=+/*-]|\s*|0x[\da-fA-F]+|[\d.]+|'.')\s*)*([()])/);
            if (!m) {
                state.pushDiag(`Unterminated expression`, vscode.DiagnosticSeverity.Error);
                break;
            }

            // JS doesn't support single-character arithmetic, so we need to convert those to numbers first:
            const part = m[0].replace(/'(.)'/g, (_, char: string) => char.charCodeAt(0).toString());

            text += part;
            if (m[1] === '(') {
                level++;
            } else {
                level--;
            }

            state.skipWhitespace();
        }

        const loc = state.location(start);
        const raw = state.raw(loc);

        try {
            return new Expression(raw, eval(text), loc);
        } catch (e) {
            state.pushDiag(`Unable to evaluate expression`, vscode.DiagnosticSeverity.Error, loc);
        }
    }

    toString(raw=true) {
        if (raw) {
            return this.raw;
        }

        return `< ${this.val} >`;
    }
}

export class ArrayValue extends PropertyValue {
    val: (PHandle | IntValue | Expression)[];
    private constructor(value: (PHandle | IntValue | Expression)[], loc: vscode.Location) {
        super(value, loc);
    }

    static match(state: ParserState): ArrayValue {
        const start = state.freeze();
        const phandleArray = state.match(/^</);
        if (!phandleArray) {
            return undefined;
        }

        const elems = [IntValue, PHandle, Expression];
        const values: (PHandle | IntValue | Expression)[] = [];

        while (state.skipWhitespace() && !state.match(/^>/)) {
            let match: PHandle | IntValue | Expression | undefined;
            elems.find(e => match = e.match(state));
            if (match) {
                values.push(match);
                continue;
            }

            const unbracedExpression = state.match(/^([+|!^-]|&&|<<|>>|==)/);
            if (unbracedExpression) {
                state.pushDiag(`Expression without a surrounding parenthesis`, vscode.DiagnosticSeverity.Error);
                continue;
            }

            // Unexpected data: Keep going until a potential closing bracket or semicolon
            const startOfError = state.freeze();
            state.skipToken();
            let endOfError = state.freeze();

            while (state.skipWhitespace()) {
                const newProp = state.match(/^[=<{}]/);
                if (newProp) {
                    // We never hit any closing brackets or semicolons before the next value
                    // Reset the state to avoid consuming these tokens:
                    state.reset(startOfError);
                    state.pushDiag(`Unterminated expression`, vscode.DiagnosticSeverity.Error, state.location(start));
                    // state.pushInsertAction('Add closing bracket', ' >', state.location()).isPreferred = true;
                    break;
                }

                const terminators = state.match(/^[>;}]/);
                if (terminators) {
                    if (terminators[0] === '>') {
                        state.pushDiag(`Syntax error`, vscode.DiagnosticSeverity.Error, state.location(startOfError, endOfError));
                    } else {
                        if (terminators[0] === ';') {
                            // Reset to right before this to avoid getting the "Missing semicolon" error
                            state.reset(endOfError);
                        }

                        state.pushDiag(`Unterminated expression`, vscode.DiagnosticSeverity.Error, state.location(start, endOfError));
                        // state.pushInsertAction('Add closing bracket', ' >', state.location(startOfError, endOfError)).isPreferred = true;
                    }

                    break;
                }

                state.skipToken();
                endOfError = state.freeze();
            }

            break;
        }

        return new ArrayValue(values, state.location(start));
    }

    cellAt(pos: vscode.Position, uri: vscode.Uri) {
        return this.val.find(v => v.contains(pos, uri));
    }

    get length() {
        return this.val.length;
    }

    isNumberArray() {
        return this.val.every(v => v instanceof IntValue);
    }

    isNumber() {
        return (this.val.length === 1) && (this.val[0] instanceof IntValue);
    }

    isPHandle() {
        return (this.val.length === 1) && (this.val[0] instanceof IntValue);
    }

    isPHandleArray() {
        return this.val.every(v => v instanceof PHandle);
    }

    toString() {
        return `< ${this.val.map(v => v.toString(true)).join(' ')} >`;
    }
}

export class BytestringValue extends PropertyValue {
    val: number[];
    private constructor(value: number[], loc: vscode.Location) {
        super(value, loc);
    }

    get length() {
        return this.val.length;
    }

    static match(state: ParserState): BytestringValue {
        if (!state.match(/^\[/)) {
            return;
        }

        const start = state.freeze();
        const bytes = new Array<number>();
        let match: RegExpMatchArray;
        while ((match = state.match(/^\s*([\da-fA-F]{2})/))) {
            bytes.push(parseInt(match[1], 16));
        }

        if (!state.match(/^\s*]/)) {
            state.pushDiag('Missing terminating ]', vscode.DiagnosticSeverity.Error);
            state.pushInsertAction('Add terminating ]', ' ]').isPreferred = true;
        }

        return new BytestringValue(bytes, state.location(start));
    }

    toString() {
        return `[ ${this.val.map(v => (v < 0x10 ? '0' : '') + v.toString(16)).join(' ')} ]`;
    }
}

export class PHandle extends PropertyValue {
    val: string;
    kind: 'ref' | 'pathRef' | 'string' | 'invalid';

    private constructor(value: string, loc: vscode.Location, kind: 'ref' | 'pathRef' | 'string' | 'invalid') {
        super(value, loc);
        this.kind = kind;
    }

    is(node: Node) {
        if (this.kind === 'ref') {
            const labelName = this.val.slice(1);
            return node.labels().includes(labelName);
        }

        return this.val === node.path;
    }

    static match(state: ParserState): PHandle {
        let phandle = state.match(/^&\{([\w/@-]+)\}/); // path reference
        if (phandle) {
            return new PHandle(phandle[1], state.location(), 'pathRef');
        }

        phandle = state.match(/^&[\w-]+/);
        if (phandle) {
            return new PHandle(phandle[0], state.location(), 'ref');
        }
        // can be path:
        phandle = state.match(/^"(.+?)"/); // deprecated?
        if (phandle) {
            return new PHandle(phandle[1], state.location(), 'string');
        }

        // Incomplete:
        phandle = state.match(/^&/);
        if (phandle) {
            return new PHandle(phandle[0], state.location(), 'invalid');
        }
    }

    toString(raw=true) {
        switch (this.kind) {
        case 'ref':
            return raw ? this.val : `< ${this.val} >`;
        case 'pathRef':
            return raw ? `&{${this.val}}` : `< &{${this.val}} >`;
        case 'string':
            return `"${this.val}"`;
        case 'invalid':
            return '';
        }
    }
}

export function evaluateExpr(expr: string, start: vscode.Position, diags: vscode.Diagnostic[]) {
    expr = expr.trim().replace(/([\d.]+|0x[\da-f]+)[ULf]+/gi, '$1');
    let m: RegExpMatchArray;
    let level = 0;
    let text = '';
    while ((m = expr.match(/(?:(?:<<|>>|&&|\|\||[!=<>]=|[|&~^<>!=+/*-]|\s*|0x[\da-fA-F]+|[\d.]+)\s*)*([()]?)/)) && m[0].length) {
        text += m[0];
        if (m[1] === '(') {
            level++;
        } else if (m[1] === ')') {
            if (!level) {
                return undefined;
            }

            level--;
        }

        expr = expr.slice(m.index + m[0].length);
    }

    if (!text || level || expr) {
        diags.push(new vscode.Diagnostic(new vscode.Range(start.line, start.character + m.index, start.line, start.character + m.index), `Unterminated expression`));
        return undefined;
    }

    try {
        return eval(text);
    } catch (e) {
        diags.push(new vscode.Diagnostic(new vscode.Range(start.line, start.character, start.line, start.character + text.length), `Unable to evaluate expression`));
        return undefined;
    }
}

export class Line {
    raw: string;
    text: string;
    number: number;
    macros: MacroInstance[];
    location: vscode.Location;

    get length(): number {
        return this.text.length;
    }

    rawPos(range: vscode.Range): vscode.Range;
    rawPos(position: vscode.Position, earliest: boolean): number;
    rawPos(offset: number, earliest: boolean): number;

    /**
     * Remap a location in the processed text to a location in the raw input text (real human readable location)
     *
     * For instance, if a processed line is
     *
     * foo bar 1234
     *
     * and the unprocessed line is
     *
     * foo MACRO_1 MACRO_2
     *
     * the outputs should map like this:
     *
     * remap(0) -> 0
     * remap(4) -> 4 (from the 'b' in bar)
     * remap(5) -> 4 (from the 'a' in bar)
     * remap(5, true) -> 6 (from the 'a' in bar)
     * remap(9) -> 8 (from the '2' in 1234)
     *
     * @param loc Location in processed text
     * @param earliest Whether to get the earliest matching position
     */
    rawPos(loc: vscode.Position | vscode.Range | number, earliest=true) {
        if (loc instanceof vscode.Position) {
            return new vscode.Position(loc.line, this.rawPos(loc.character, earliest));
        }

        if (loc instanceof vscode.Range) {
            return new vscode.Range(loc.start.line, this.rawPos(loc.start, true), loc.end.line, this.rawPos(loc.end, false));
        }

        this.macros.find(m => {
            loc = <number>loc; // Just tricking typescript :)
            if (m.start > loc) {
                return true; // As macros are sorted by their start pos, there's no need to go through the rest
            }

            // Is inside macro
            if (loc < m.start + m.insert.length) {
                loc = m.start;
                if (!earliest) {
                    loc += m.raw.length; // clamp to end of macro
                }
                return true;
            }

            loc += m.raw.length - m.insert.length;
        });

        return loc;
    }

    contains(uri: vscode.Uri, pos: vscode.Position) {
        return uri.toString() === this.location.uri.toString() && this.location.range.contains(pos);
    }

    get uri() {
        return this.location.uri;
    }

    constructor(raw: string, number: number, uri: vscode.Uri, macros: MacroInstance[]=[]) {
        this.raw = raw;
        this.number = number;
        this.macros = MacroInstance.filterOverlapping(macros);
        this.location = new vscode.Location(uri, new vscode.Range(this.number, 0, this.number, this.raw.length));
        this.text = MacroInstance.process(raw, this.macros);
    }
}

type Offset = { line: number, col: number };

class ParserState {
    readonly token = /^[#-\w]+|./;
    macros: Macro[];
    private offset: Offset;
    private prevRange: { start: Offset, length: number };
    diags: DiagnosticsSet;
    includes: IncludeStatement[];
    lines: Line[];
    uri: vscode.Uri;

    location(start?: Offset, end?: Offset) {
        if (!start) {
            start = this.prevRange.start;
        }

        if (!end) {
            end = <Offset>{ line: this.prevRange.start.line, col: this.prevRange.start.col + this.prevRange.length };
        }

        const startLine = this.lines[start.line];
        const endLine = this.lines[end.line];

        return new vscode.Location(startLine.uri,
                                   new vscode.Range(startLine.number, startLine.rawPos(start.col, true),
                                                    endLine.number, endLine.rawPos(end.col, false)));
    }

    getLine(uri: vscode.Uri, pos: vscode.Position) {
        return this.lines.find(l => l.contains(uri, pos));
    }

    raw(loc: vscode.Location) {
        if (loc.range.isSingleLine) {
            return this.getLine(loc.uri, loc.range.start)?.raw.slice(loc.range.start.character, loc.range.end.character) ?? '';
        }

        let i = this.lines.findIndex(l => l.contains(loc.uri, loc.range.start));
        if (i < 0) {
            return '';
        }

        let content = this.lines[i].raw.slice(loc.range.start.character);
        while (!this.lines[++i].contains(loc.uri, loc.range.end)) {
            content += this.lines[i].raw;
        }

        content += this.lines[i].raw.slice(0, loc.range.end.character);
        return content;
    }

    pushDiag(message: string, severity: vscode.DiagnosticSeverity=vscode.DiagnosticSeverity.Error, loc?: vscode.Location): vscode.Diagnostic {
        if (!loc) {
            loc = this.location();
        }

        return this.diags.push(loc.uri, new vscode.Diagnostic(loc.range, message, severity));
    }

    pushAction(title: string, kind?: vscode.CodeActionKind): vscode.CodeAction {
        return this.diags.pushAction(new vscode.CodeAction(title, kind));
    }

    pushInsertAction(title: string, insert: string, loc?: vscode.Location): vscode.CodeAction {
        if (!loc) {
            loc = this.location();
        }

        const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
        action.edit = new vscode.WorkspaceEdit();
        action.edit.insert(loc.uri, loc.range.end, insert);

        return this.diags.pushAction(action);
    }

    pushDeleteAction(title: string, loc?: vscode.Location): vscode.CodeAction {
        if (!loc) {
            loc = this.location();
        }

        const action = new vscode.CodeAction(title, vscode.CodeActionKind.Refactor);
        action.edit = new vscode.WorkspaceEdit();
        action.edit.delete(loc.uri, loc.range);

        return this.diags.pushAction(action);
    }

    pushSemicolonAction(loc?: vscode.Location): vscode.CodeAction {
        const action = this.pushInsertAction('Add semicolon', ';', loc);
        action.isPreferred = true;
        return action;
    }

    private replaceDefines(text: string, loc: vscode.Location) {
        const macros = new Array<MacroInstance>();
        this.macros.filter(d => !d.undef).forEach(d => {
            macros.push(...d.find(text, this.macros, loc));
        });

        return MacroInstance.process(text, MacroInstance.filterOverlapping(macros));
    }

    evaluate(text: string, loc: vscode.Location): any {
        text = this.replaceDefines(text, loc);
        try {
            const diags = new Array<vscode.Diagnostic>();
            const result = evaluateExpr(text, loc.range.start, diags);
            diags.forEach(d => this.pushDiag(d.message, d.severity, new vscode.Location(loc.uri, d.range)));
            return result;
        } catch (e) {
            this.pushDiag('Evaluation failed: ' + e.toString(), vscode.DiagnosticSeverity.Error, loc);
        }

        return 0;
    }

    match(pattern?: RegExp): RegExpMatchArray | undefined {
        const match = this.peek(pattern ?? this.token);
        if (match) {
            this.prevRange.start = { ...this.offset };
            this.prevRange.length = match[0].length;

            this.offset.col += match[0].length;
            if (this.offset.col === this.lines[this.offset.line].length) {
                this.offset.col = 0;
                this.offset.line++;
            }
        }

        return match;
    }

    eof(): boolean {
        return this.offset.line === this.lines.length;
    }

    get next(): string {
        return this.lines[this.offset.line].text.slice(this.offset.col);
    }

    skipWhitespace() {
        const prevRange = { ...this.prevRange };

        while (this.match(/^\s+/));

        /* Ignore whitespace in diagnostics ranges */
        this.prevRange = prevRange;
        return !this.eof();
    }

    skipToken() {
        const match = this.match(this.token);
        if (!match) {
            this.offset.line = this.lines.length;
            return '';
        }

        return match[0];
    }

    reset(offset: Offset) {
        this.offset = offset;
    }

    peek(pattern?: RegExp) {
        if (this.offset.line >= this.lines.length) {
            return undefined;
        }

        return this.next.match(pattern ?? this.token);
    }

    peekLocation(pattern?: RegExp): vscode.Location {
        const match = this.peek(pattern ?? this.token);
        if (!match) {
            return undefined;
        }

        const prev = this.location();
        return new vscode.Location(prev.uri, new vscode.Range(prev.range.end, new vscode.Position(prev.range.end.line, prev.range.end.character + match[0].length)));
    }

    freeze(): Offset {
        return { ...this.offset };
    }

    since(start: Offset) {
        return this.lines.slice(start.line, this.offset.line + 1).map((l, i) => {
            if (i === this.offset.line - start.line) {
                if (i === 0) {
                    return l.text.slice(start.col, this.offset.col);
                }

                return l.text.slice(0, this.offset.col);
            }

            if (i === 0) {
                return l.text.slice(start.col);
            }

            return l.text;
        }).join('\n');
    }

    constructor(uri: vscode.Uri, diags: DiagnosticsSet, lines: Line[], macros: Macro[], includes: IncludeStatement[]) {
        this.uri = uri;
        this.diags = diags;
        this.offset = {line: 0, col: 0};
        this.prevRange = { start: this.offset, length: 0 };
        this.lines = lines;
        this.includes = includes;
        this.macros = macros;
    }
}

function parsePropValue(state: ParserState) {
    const elems: PropertyValue[] = [];

    const valueTypes = [ArrayValue, StringValue, BytestringValue, PHandle];
    let missingComma: vscode.Location;

    while (state.skipWhitespace()) {
        if (state.peek(/^;/)) {
            break;
        }

        if (missingComma) {
            state.pushDiag(`Expected comma between property values`, vscode.DiagnosticSeverity.Error, missingComma);
            state.pushInsertAction('Separate values by comma', ',', missingComma).isPreferred = true;
            missingComma = null;
        }

        if (elems.length > 0) {
            if (!state.match(/^,/)) {
                /* Found a missing comma, but will only emit comma error if we manage
                 * to parse another property value, as this could also just mean a missing
                 * semicolon.
                 */
                missingComma = state.location();
            }

            state.skipWhitespace();
        }

        let match: PropertyValue;
        valueTypes.find(type => match = type.match(state));
        if (match) {
            elems.push(match);
            continue;
        }

        // Easy to miss brackets around numbers.
        const number = state.match(/^(0x[\da-fA-F]+|\d+)/);
        if (number) {
            const loc = state.location();
            state.pushDiag('Missing < > brackets around number', vscode.DiagnosticSeverity.Error);
            const action = state.pushAction('Add brackets', vscode.CodeActionKind.QuickFix);
            action.edit = new vscode.WorkspaceEdit();
            action.edit.replace(loc.uri, loc.range, '< ' + number[0] + ' >');
            action.isPreferred = true;
            // Don't want to continue parsing, as this an invalid value.
        }

        /* As none of the value types matched, there's a format error in this value.
         * We'll just exit without consuming the next token, as this is likely a missing semicolon.
         */
        return elems;
    }

    if (elems.length === 0) {
        return [new BoolValue(state.location())];
    }

    return elems;
}

export class Property {
    name: string;
    labels?: string[];
    value: PropertyValue[];
    loc: vscode.Location;
    fullRange: vscode.Range;
    entry: NodeEntry;

    constructor(name: string, loc: vscode.Location, state: ParserState, entry: NodeEntry, labels: string[]=[]) {
        this.name = name;
        this.loc = loc;
        this.labels = labels;
        this.entry = entry;
        this.value = parsePropValue(state);
        this.fullRange = new vscode.Range(loc.range.start, state.location().range.end);
    }

    get path() {
        return this.entry.node.path + this.name;
    }

    toString(indent=0): string {
        if (this.value.length === 1 && this.value[0] instanceof BoolValue) {
            return `${this.name}`;
        }

        return `${this.name} = ${this.valueString(indent + this.name.length + 3)}`;
    }

    valueString(indent=0): string {
        if (this.value === undefined) {
            return '?';
        }

        if (this.boolean) {
            return 'true';
        }

        const values = this.value.map(v => v.toString());
        if (values.length > 1 && indent + values.join(', ').length > 80) {
            return values.join(',\n' + ' '.repeat(indent));
        }

        return values.join(', ');
    }

    get valueLoc() {
        const range = this.value.reduce((union, v) => {
            if (union) {
                return union.union(v.loc.range);
            }

            return v.loc.range;
        }, <vscode.Range>undefined);

        if (range) {
            return new vscode.Location(this.loc.uri, range);
        }

        return this.loc; // better than nothing
    }

    get fullLoc() {
        if (this.value.length) {
            return new vscode.Location(this.loc.uri, this.loc.range.union(this.value[this.value.length - 1].loc.range)); // better than nothing
        }

        return this.loc;
    }

    get boolean() {
        if (this.value.length === 1 && (this.value[0] instanceof BoolValue)) {
            return true;
        }
    }

    get number() {
        if (this.value.length === 1 && (this.value[0] instanceof ArrayValue) && this.value[0].val.length === 1 && (this.value[0].val[0] instanceof IntValue)) {
            return this.value[0].val[0].val as number;
        }
    }

    get string() {
        if (this.value.length === 1 && (this.value[0] instanceof StringValue)) {
            return this.value[0].val as string;
        }
    }

    get pHandle() {
        if (this.value.length === 1 && (this.value[0] instanceof ArrayValue) && this.value[0].val.length === 1 && (this.value[0].val[0] instanceof PHandle)) {
            return this.value[0].val[0] as PHandle;
        }
        if (this.value.length === 1 && (this.value[0] instanceof PHandle)) {
            return this.value[0] as PHandle;
        }
    }

    get bytestring() {
        if (this.value.length === 1 && (this.value[0] instanceof BytestringValue)) {
            return this.value[0] as BytestringValue;
        }
    }

    get array() {
        if (this.value.length === 1 && (this.value[0] instanceof ArrayValue) && this.value[0].val.every(v => v instanceof IntValue)) {
            return this.value[0].val.map(v => v.val) as number[];
        }
    }

    get arrays() {
        if (this.value.every(v => v instanceof ArrayValue && v.val.every(v => v instanceof IntValue))) {
            return this.value.map(v => v.val.map(v => v.val) as number[]);
        }
    }

    get pHandles() {
        if (this.value.length === 1 && (this.value[0] instanceof ArrayValue) && this.value[0].val.every(v => v instanceof PHandle)) {
            return this.value[0].val as PHandle[];
        }

        if (this.value.every(v => v instanceof PHandle)) {
            return this.value as PHandle[];
        }
    }

    get pHandleArray() {
        if (this.value.every(v => v instanceof ArrayValue)) {
            return this.value as ArrayValue[];
        }
    }

    get stringArray() {
        if (this.value.every(v => v instanceof StringValue)) {
            return this.value.map(v => v.val) as string[];
        }
    }

    /** Get the entries of the property.
     *  Normally, the entries are split into their own ArrayValues, but they could also be merged to one array value.
     *  I.e., the following is equivalent:
     *  <&gpio0 1 2>, <&gpio0 2 3>
     *  <&gpio0 1 2 &gpio0 2 3>
     *
     *  Both are values with two entries:
     *  [&gpio0, 1, 2], [&gpio0, 2, 3]
     */
    get entries() {
        const val = this.pHandleArray;
        if (!val || !val.length) {
            return;
        }

        const entries = new Array<{ target: PHandle, cells: (IntValue | Expression)[] }>();

        val.forEach(v => {
            let i = 0;
            while (i < v.val.length) {
                const target = v.val[i++];
                if (!(target instanceof PHandle)) {
                    break;
                }

                let count = v.val.slice(i).findIndex(v => v instanceof PHandle);
                if (count === -1) {
                    count = v.val.length - i;
                }
                const cells = v.val.slice(i, i + count);
                if (cells.some(c => !(c instanceof IntValue))) {
                    break;
                }

                entries.push({ target, cells: <(IntValue | Expression)[]>cells });
                i += count;
            }
        });

        return entries;
    }
    get regs() {
        const val = this.pHandleArray;
        if (!val || !val.length) {
            return;
        }

        const entries = new Array<{ addrs: IntValue[], sizes: IntValue[] }>();

        const addrCells = this.entry.node.parent?.addrCells() ?? 2;
        const sizeCells = this.entry.node.parent?.sizeCells() ?? 1;

        val.forEach(v => {
            for (let i = 0; i + addrCells + sizeCells <= v.val.length; i += sizeCells) {
                const addrs = v.val.slice(i, i + addrCells);
                if (!addrs.every(a => a instanceof IntValue)) {
                    break;
                }

                i += addrCells;

                const sizes = v.val.slice(i, i + sizeCells);
                if (!sizes.every(a => a instanceof IntValue)) {
                    break;
                }

                entries.push({ addrs: <IntValue[]>addrs, sizes: <IntValue[]> sizes });
            }
        });

        return entries;
    }

    get nexusMap() {
        if (!this.name.endsWith('-map')) {
            return;
        }

        const val = this.pHandleArray;
        if (!val || !val.length) {
            return [];
        }

        const map = new Array<{ in: IntValue[], target: PHandle, out: IntValue[] }>();

        const targetIdx = val[0].val.findIndex(v => v instanceof PHandle);
        if (targetIdx === -1) {
            return [];
        }

        val.forEach(v => {
            let i = 0;
            while (i + targetIdx + 1 < v.val.length) {
                const inputCells = v.val.slice(i, i + targetIdx);
                if (inputCells.some(c => !(c instanceof IntValue))) {
                    break;
                }

                i += targetIdx;

                const target = v.val[i++];
                if (!(target instanceof PHandle)) {
                    break;
                }

                let outCnt = v.val.slice(i).findIndex(c => !(c instanceof IntValue));
                if (outCnt === -1) {
                    outCnt = v.val.length - i;
                } else {
                    outCnt -= targetIdx; // Accounting for input cells on next entry
                }

                if (outCnt < 0) {
                    break;
                }

                const outputCells = v.val.slice(i, i + outCnt);
                if (outputCells.some(c => c instanceof PHandle)) {
                    break;
                }

                map.push({in: <IntValue[]>inputCells, target: target, out: <IntValue[]>outputCells});
                i += outCnt;
            }
        });

        return map;
    }

    /* Get the expected cellnames for this property. */
    cellNames(ctx: DTSCtx): string[][] {

        const arr = this.pHandleArray;
        if (!arr) {
            return [];
        }

        return this.pHandleArray.map(arr => {
            const contents = arr.val;

            if (this.name === 'reg') {
                const addrCells = this.entry.node.parent?.addrCells() ?? 2;
                const sizeCells = this.entry.node.parent?.sizeCells() ?? 1;
                return [...Array(addrCells).fill('addr'), ...Array(sizeCells).fill('size')];
            }

            if (this.name === 'ranges') {
                const addrCells = this.entry.node.addrCells();
                const parentAddrCells = this.entry.node.parent?.addrCells() ?? 2;
                const sizeCells = this.entry.node.sizeCells();
                return [...Array(addrCells).fill('child-addr'), ...Array(parentAddrCells).fill('parent-addr'), ...Array(sizeCells).fill('size')];
            }

            // Get cells from parents:
            if (this.name.endsWith('s')) {
                const parentName = this.entry.node.parent?.property(this.name.slice(0, this.name.length - 1) + '-parent')?.pHandle?.val;
                if (parentName) {
                    const parent = ctx.node(parentName);
                    const cellCount = parent?.cellCount(this.name);
                    if (cellCount !== undefined) {
                        const cells = new Array(cellCount).fill('cell').map((c, i) => `${c}-${i}`);
                        (<string[]>parent.type?.cells(cellName(this.name)))?.forEach((name, i) => cells[i] = name);
                        return cells;
                    }
                }
            }

            // nexus node:
            if (this.name.endsWith('-map')) {
                const inputCells = contents.findIndex(v => v instanceof PHandle);
                if (inputCells >= 0) {
                    if (this.name === 'interrupt-map') {
                        const interruptSpec = new Array(this.entry.node.property('#interrupt-cells')?.number ?? 0).fill('irq-in');
                        const addrNames = new Array(inputCells - interruptSpec.length).fill('addr-in');
                        const refNode = ctx.node(contents[inputCells]?.val as string);
                        if (refNode) {
                            const outputAddrs = new Array(refNode.addrCells()).fill(`addr-out`);
                            const outputNames = new Array(refNode.property('#interrupt-cells')?.number ?? 0).fill('irq-out');
                            return [...addrNames, ...interruptSpec, '&target', ...outputAddrs, ...outputNames];
                        }

                        return [...addrNames, ...interruptSpec, '&target'];

                    } else {
                        const inputNames = new Array(inputCells).fill('input');
                        this.entry.node.refCellNames(this.name)?.slice(0, inputCells).forEach((c, i) => inputNames[i] = c);
                        const outputNames = ctx.node(contents[inputCells]?.val as string)?.refCellNames(this.name) ?? [];
                        return [...inputNames, '&target', ...outputNames];
                    }
                }
            }

            // Get names from referenced nodes:
            let refCells = [];
            return contents.map(c => {
                if (c instanceof PHandle) {
                    refCells = Array.from(ctx.node(c.val)?.refCellNames(this.name) ?? [])?.reverse() ?? [];
                    return c.toString();
                }

                if (refCells.length) {
                    return refCells.pop();
                }

                if (contents.length === 1) {
                    return this.name.replace('#', 'Number of ').replace(/-/g, ' ');
                }

                return 'cell';
            });
        });
    }

    valueAt(pos: vscode.Position, uri: vscode.Uri) {
        return this.value.find(v => v.contains(pos, uri));
    }

    type(): string {
        if (this.value.length === 0) {
            return 'invalid';
        }

        if (this.value.length === 1) {
            const v = this.value[0];
            if (v instanceof ArrayValue) {
                if (v.length === 1) {
                    if (v.val[0] instanceof IntValue) {
                        return 'int';
                    }

                    if (v.val[0] instanceof PHandle) {
                        return 'phandle';
                    }

                    return 'invalid';
                }
                if (v.length > 1) {
                    if (v.val.every(e => e instanceof PHandle)) {
                        return 'phandles';
                    }

                    if (v.val.every(e => e instanceof IntValue)) {
                        return 'array';
                    }

                    return 'phandle-array';
                }

                return 'invalid';
            }

            if (v instanceof StringValue) {
                return 'string';
            }

            if (v instanceof BytestringValue) {
                return 'uint8-array';
            }

            if (v instanceof BoolValue) {
                return 'boolean';
            }

            if (v instanceof PHandle) {
                return 'path';
            }

            return 'invalid';
        }

        if (this.value.every(v => v instanceof ArrayValue)) {

            if (this.value.every((v: ArrayValue) => v.val.every(e => e instanceof PHandle))) {
                return 'phandles';
            }

            if (this.value.every((v: ArrayValue) => v.val.every(e => e instanceof IntValue))) {
                return 'array';
            }

            return 'phandle-array';
        }

        if (this.value.every(v => v instanceof StringValue)) {
            return 'string-array';
        }

        return 'compound';
    }
}

export class OffsetRange {
    doc: vscode.TextDocument;
    start: number;
    length: number;

    constructor(doc: vscode.TextDocument, start: number, length?: number) {
        this.doc = doc;
        this.start = start;
        this.length = length || 0;
    }

    toRange(): vscode.Range {
        return new vscode.Range(this.doc.positionAt(this.start), this.doc.positionAt(this.start + this.length));
    }

    contains(pos: vscode.Position, doc: vscode.TextDocument) {
        return this.doc.uri.fsPath === doc.uri.fsPath && this.toRange().contains(pos);
    }

    containsRange(r: OffsetRange) {
        return this.doc.uri.fsPath === r.doc.uri.fsPath && this.start <= r.start && ((this.start + this.length) >= (r.start + r.length));
    }

    extendTo(offset: number) {
        this.length = offset - this.start;
    }
}

export class DTSFile {
    uri: vscode.Uri;
    lines: Line[];
    roots: NodeEntry[];
    entries: NodeEntry[];
    includes: IncludeStatement[];
    macros: Macro[];
    diags: DiagnosticsSet;
    dirty=true;
    priority: number;
    ctx: DTSCtx;

    constructor(uri: vscode.Uri, ctx: DTSCtx) {
        this.uri = uri;
        this.diags = new DiagnosticsSet();
        this.ctx = ctx;
        this.priority = ctx.fileCount;
        this.lines = [];
        this.roots = [];
        this.entries = [];
        this.includes = [];
        this.macros = [];
    }

    remove() {
        this.entries.forEach(e => {
            e.node.entries = e.node.entries.filter(nodeEntry => nodeEntry !== e);
        });
        this.entries = [];
        this.dirty = true;
    }

    has(uri: vscode.Uri) {
        return (
            this.uri.toString() === uri.toString() ||
            this.includes.find(include => uri.toString() === include.dst.toString()));
    }

    getNodeAt(pos: vscode.Position, uri: vscode.Uri): Node {
        return this.getEntryAt(pos, uri)?.node;
    }

    getEntryAt(pos: vscode.Position, uri: vscode.Uri): NodeEntry {
        const entries = this.entries.filter(e => e.loc.uri.fsPath === uri.fsPath && e.loc.range.contains(pos));
        if (entries.length === 0) {
            return undefined;
        }

        /* When multiple nodes are matching, they extend each other,
         * and the one with the longest path is the innermost child.
         */
        return entries.sort((a, b) => b.node.path.length - a.node.path.length)[0];
    }

    getPropertyAt(pos: vscode.Position, uri: vscode.Uri): Property {
        return this.getEntryAt(pos, uri)?.getPropertyAt(pos, uri);
    }

    addNode(path: string, properties: { [name: string]: string } = {}) {
        if (path.endsWith('/')) {
            path = path.slice(0, path.length);
        }

        const newComponents = [];
        let existing: NodeEntry;
        const p = path.split('/');
        while (p.length) {
            const fullPath = p.join('/');
            existing = this.entries.find(e => e.node.path === fullPath);
            if (existing) {
                break;
            }

            p.pop();
            newComponents.push(fullPath);
        }

        while (!existing && newComponents.length) {
            const component = newComponents.pop();
            const node = this.ctx.node(component);
            if (!node) {
                return; // Assert?
            }

            if (node.labels().length > 0 || !node.parent) {
                existing = new NodeEntry(null, node, null, this, this.entries.length);
            }
        }
    }
}

export class NodeEntry {
    node: Node;
    children: NodeEntry[];
    parent?: NodeEntry;
    properties: Property[];
    labels: string[];
    ref?: string;
    loc: vscode.Location;
    nameLoc: vscode.Location;
    file: DTSFile;
    number: number;

    constructor(loc: vscode.Location, node: Node, nameLoc: vscode.Location, ctx: DTSFile, number: number) {
        this.node = node;
        this.children = [];
        this.properties = [];
        this.loc = loc;
        this.nameLoc = nameLoc;
        this.labels = [];
        this.file = ctx;
        this.number = number;
    }

    get depth(): number {
        if (!this.parent) {
            return 0;
        }

        return this.parent.depth + 1;
    }

    getPropertyAt(pos: vscode.Position, uri: vscode.Uri) {
        return this.properties.find(p => p.fullRange.contains(pos) && p.loc.uri.toString() === uri.toString());
    }

    toString(indent?: string) {
        let result = indent;
        if (this.ref) {
            result += this.ref;
        } else {
            result += this.node.fullName;
        }
        result += ' {\n';
        indent += '\t';

        result += this.properties.map(p => indent + p.toString(indent.length) + ';\n').join('');

        if (this.properties.length && this.children.length) {
            result += '\n';
        }

        result += this.children.map(c => c.toString(indent) + ';\n').join('\n');

        return result + indent.slice(4) + '}';
    }
}

export class Node {
    name: string;
    fullName: string;
    deleted?: vscode.Location;
    parent?: Node;
    path: string;
    address?: number;
    type?: NodeType;
    entries: NodeEntry[];
    pins?: {prop: Property, cells: IntValue[], pinmux?: Node}[];

    constructor(name: string, address?: string, parent?: Node) {
        if (address) {
            this.fullName = name + '@' + address;
        } else {
            this.fullName = name;
        }
        if (address) {
            this.address = parseInt(address, 16);
        }

        if (parent) {
            this.path = parent.path + this.fullName + '/';
        } else if (!name.startsWith('&')) {
            this.path = '/';
            this.fullName = '/';
        } else {
            this.path = this.fullName;
        }

        this.parent = parent;
        this.name = name;
        this.entries = [];
    }

    enabled(): boolean {
        const status = this.property('status');
        return !status?.string || (['okay', 'ok'].includes(status.string));
    }

    hasLabel(label: string) {
        return !!this.entries.find(e => e.labels.indexOf(label) != -1);
    }

    children(): Node[] {
        const children: { [path: string]: Node } = {};
        this.entries.forEach(e => e.children.forEach(c => children[c.node.path] = c.node));
        return Object.values(children);
    }

    get sortedEntries() {
        return this.entries.sort((a, b) => 1000000 * (a.file.priority - b.file.priority) + (a.number - b.number));
    }

    labels(): string[] {
        const labels: string[] = [];
        this.entries.forEach(e => labels.push(...e.labels));
        return labels;
    }

    /** User readable name for this node */
    get uniqueName(): string {
        const labels = this.labels();
        if (labels.length) {
            return '&' + labels[0];
        }

        return this.path;
    }

    /** Local user readable name for this node */
    get localUniqueName(): string {
        const labels = this.labels();
        if (labels.length) {
            return '&' + labels[0];
        }

        return this.fullName;
    }

    get refName(): string {
        const labels = this.labels();
        if (labels.length) {
            return '&' + labels[0];
        }

        return `&{${this.path}}`;
    }

    properties(): Property[] {
        const props: Property[] = [];
        this.entries.forEach(e => props.push(...e.properties));
        return props;
    }

    property(name: string): Property | undefined {
        return this.uniqueProperties().find(e => e.name === name);
    }

    addrCells(): number {
        return this.property('#address-cells')?.number ?? 2;
    }

    sizeCells(): number {
        return this.property('#size-cells')?.number ?? 1;
    }

    regs() {
        return this.property('reg')?.regs;
    }

    cellCount(prop: string) {
        return this.property('#' + cellName(prop))?.number ?? 1;
    }

    /** Cell names exposed when the node is referenced */
    refCellNames(prop: string): string[] {
        const typeCellNames = this.type?.cells(cellName(prop));
        if (typeCellNames) {
            return typeCellNames;
        }

        const count = this.property('#' + cellName(prop))?.number;
        if (count === undefined) {
            return;
        }

        return new Array(count).fill(this.name).map((c, i) => `${c}-${i}`);
    }

    uniqueProperties(): Property[] {
        const props = {};
        this.sortedEntries.forEach(e => e.properties.forEach(p => props[p.name] = p));
        return Object.values(props);
    }

    toString(expandChildren=false, indent='') {
        let result = indent + this.fullName + ' {\n';
        indent += '    ';

        const props = this.uniqueProperties();
        const children = this.children();
        result += props.map(p => indent + p.toString(indent.length) + ';\n').join('');

        if (props.length && children.length) {
            result += '\n';
        }

        if (expandChildren) {
            result += children.filter(c => !c.deleted).map(c => c.toString(expandChildren, indent) + '\n').join('\n');
        } else {
            result += children.map(c => indent + c.fullName + ' { /* ... */ };\n').join('\n');
        }

        return result + indent.slice(4) + '};';
    }
}

export class DTSCtx {
    overlays: DTSFile[];
    boardFile: DTSFile;
    board?: zephyr.Board;
    parsing?: boolean;
    nodes: {[fullPath: string]: Node};
    dirty: vscode.Uri[];
    includes = new Array<string>();
    _name?: string;
    id: string;
    saved=false;

    constructor() {
        this.nodes = {};
        this.overlays = [];
        this.dirty = [];
    }

    get name() {
        if (this._name) {
            return this._name;
        }

        const uri = this.files.pop()?.uri;
        let folder = path.dirname(uri.fsPath);
        if (path.basename(folder) === 'boards') {
            folder = path.dirname(folder);
        }

        if (vscode.workspace.workspaceFolders?.find(workspace => workspace.uri.fsPath === folder)) {
            return path.basename(uri.fsPath, path.extname(uri.fsPath));
        }

        return vscode.workspace.asRelativePath(folder) + ': ' + path.basename(uri.fsPath, path.extname(uri.fsPath));
    }

    reset() {
        // Kill all affected files:
        if (this.dirty.some(uri => this.boardFile?.has(uri))) {
            this.boardFile.remove();
        }

        this.overlays
            .filter(overlay => this.dirty.some(uri => overlay.has(uri)))
            .forEach(overlay => overlay.remove());

        const removed = { board: this.boardFile, overlays: this.overlays };

        this.boardFile = null;
        this.overlays = [];
        this.nodes = {};
        this.dirty = [];

        return removed;
    }

    async setBoard(board: zephyr.Board) {
        if (board.arch) {
            this.includes = zephyr.modules.map(module => module + '/dts/' + board.arch);
        }

        this.board = board;
        this.boardFile = new DTSFile(vscode.Uri.file(board.path), this);
        this.dirty.push(this.boardFile.uri);
    }

    insertOverlay(uri: vscode.Uri) {
        this.overlays = [new DTSFile(uri, this), ...this.overlays];
        this.dirty.push(uri);
    }

    adoptNodes(file: DTSFile) {
        file.entries.forEach(e => {
            if (!(e.node.path in this.nodes)) {
                this.nodes[e.node.path] = e.node;
            }
        });
    }

    isValid() {
        return this.dirty.length === 0 && !this.boardFile?.dirty && !this.overlays.some(overlay => !overlay || overlay.dirty);
    }

    node(name: string, parent?: Node): Node | null {
        if (name.startsWith('&{')) {
            const path = name.match(/^&{(.*)}/);
            if (!path) {
                return;
            }

            name = path[1];
        } else if (name.startsWith('&')) {
            const ref = name.slice(1);
            return Object.values(this.nodes).find(n => n.hasLabel(ref)) ?? null;
        }

        if (!name.endsWith('/')) {
            name += '/';
        }

        if (parent) {
            name = parent.path + name;
        }

        return this.nodes[name] ?? null;
    }

    nodeArray() {
        return Object.values(this.nodes);
    }

    has(uri: vscode.Uri): boolean {
        return !!this.boardFile?.has(uri) || this.overlays.some(o => o.has(uri));
    }

    getDiags(): DiagnosticsSet {
        const all = new DiagnosticsSet();
        this.files.forEach(ctx => all.merge(ctx.diags));
        return all;
    }

    getNodeAt(pos: vscode.Position, uri: vscode.Uri): Node {
        let node: Node;
        this.files.filter(f => f.has(uri)).find(file => node = file.getNodeAt(pos, uri));
        return node;
    }

    getEntryAt(pos: vscode.Position, uri: vscode.Uri): NodeEntry {
        let entry: NodeEntry;
        this.files.filter(f => f.has(uri)).find(file => entry = file.getEntryAt(pos, uri));
        return entry;
    }

    getPropertyAt(pos: vscode.Position, uri: vscode.Uri): Property {
        let prop: Property;
        this.files.filter(f => f.has(uri)).find(file => prop = file.getPropertyAt(pos, uri));
        return prop;
    }

    getReferences(node: Node): PHandle[] {
        const refs = new Array<PHandle>();

        this.properties.forEach(p => {
            refs.push(...(<PHandle[]>p.pHandleArray?.flatMap(v => v.val.filter(v => v instanceof PHandle && v.is(node))) ?? p.pHandles ?? []));
        });

        return refs;
    }

    getProperties(range: vscode.Range, uri: vscode.Uri) {
        const props = new Array<Property>();
        this.nodeArray().forEach(n => {
            props.push(...n.properties().filter(p => p.fullLoc.uri.toString() === uri.toString() && p.fullLoc.range.intersection(range)));
        });

        return props;
    }

    getPHandleNode(handle: number | string): Node {
        if (typeof handle === 'number') {
            return this.nodeArray().find(n => n.properties().find(p => p.name === 'phandle' && p.value[0].val === handle));
        } else if (typeof handle === 'string') {
            return this.nodeArray().find(n => n.labels().find(p => p === handle));
        }
    }

    file(uri: vscode.Uri) {
        return this.files.find(f => f.has(uri));
    }

    get files() {
        if (this.boardFile) {
            return [this.boardFile, ...this.overlays];
        }

        return [...this.overlays];
    }

    get macros() {
        const macros = new Array<Macro>();
        if (this.boardFile) {
            macros.push(...this.boardFile.macros);
        }
        this.overlays.forEach(c => macros.push(...c?.macros));
        return macros;
    }

    get roots() {
        const roots = new Array<NodeEntry>();
        if (this.boardFile) {
            roots.push(...this.boardFile.roots);
        }
        this.overlays.forEach(c => roots.push(...c?.roots));
        return roots;
    }

    get entries() {
        const entries = new Array<NodeEntry>();
        if (this.boardFile) {
            entries.push(...this.boardFile.entries);
        }
        this.overlays.forEach(c => entries.push(...c?.entries));
        return entries;
    }

    get properties() {
        return this.entries.flatMap(e => e.properties);
    }

    get root() {
        return this.nodes['/'];
    }

    get fileCount() {
        return this.overlays.length + (this.boardFile ? 1 : 0);
    }

    toString() {
        return this.root?.toString(true) ?? '';
    }
}

export class Parser {
    private includes: string[];
    private defines: {[name: string]: string};
    private boards: { [board: string]: zephyr.Board };
    private appCtx: DTSCtx[];
    private boardCtx: DTSCtx[]; // Raw board contexts, for when the user just opens a .dts or .dtsi file without any overlay
    private types: TypeLoader;
    private changeEmitter: vscode.EventEmitter<DTSCtx>;
    onChange: vscode.Event<DTSCtx>;
    private openEmitter: vscode.EventEmitter<DTSCtx>;
    onOpen: vscode.Event<DTSCtx>;
    private deleteEmitter: vscode.EventEmitter<DTSCtx>;
    onDelete: vscode.Event<DTSCtx>;
    currCtx?: DTSCtx;
    private isStable = true;
    private waiters = new Array<() => void>();

    constructor(defines: {[name: string]: string}, includes: string[], types: TypeLoader) {
        this.includes = includes;
        this.defines = defines;
        this.types = types;
        this.boards = {};
        this.appCtx = [];
        this.boardCtx = [];
        this.changeEmitter = new vscode.EventEmitter();
        this.onChange = this.changeEmitter.event;
        this.openEmitter = new vscode.EventEmitter();
        this.onOpen = this.openEmitter.event;
        this.deleteEmitter = new vscode.EventEmitter();
        this.onDelete = this.deleteEmitter.event;

        zephyr.modules.forEach(m => {
            this.includes.push(m + '/include');
            this.includes.push(m + '/dts');
            this.includes.push(m + '/dts/common');
        });
    }

    file(uri: vscode.Uri) {
        let file = this.currCtx?.file(uri);
        if (file) {
            return file;
        }

        this.contexts.find(ctx => file = ctx.files.find(f => f.has(uri)));
        return file;
    }

    ctx(uri: vscode.Uri): DTSCtx {
        if (this.currCtx?.has(uri)) {
            return this.currCtx;
        }

        return this.contexts.find(ctx => ctx.has(uri));
    }

    async stable(): Promise<void> {
        if (this.isStable) {
            return;
        }

        return new Promise(resolve => this.waiters.push(resolve));
    }

    get contexts() {
        return [...this.appCtx, ...this.boardCtx];
    }

    private async guessOverlayBoard(uri: vscode.Uri): Promise<zephyr.Board> {
        const boardName = path.basename(uri.fsPath, '.overlay');
        // Some generic names are used for .overlay files: These can be ignored.
        const ignoredNames = ['app', 'dts', 'prj'];
        let board: zephyr.Board;
        if (!ignoredNames.includes(boardName)) {
            board = await zephyr.findBoard(boardName);
            if (board) {
                this.boards[boardName] = board;
                console.log(uri.toString() + ': Using board ' + boardName);
                return board;
            }
        }

        board = await zephyr.defaultBoard();
        if (board) {
            const options = ['Configure default', 'Select a different board'];
            vscode.window.showInformationMessage(`Using ${board.name} as a default board.`, ...options).then(async e => {
                if (e === options[0]) {
                    zephyr.openConfig('devicetree.board');
                } else if (e === options[1]) {
                    board = await zephyr.selectBoard();
                    if (board) {
                        // TODO: Reload context
                    }
                }
            });
            return board;
        }

        // At this point, the user probably didn't set up their repo correctly, but we'll give them a chance to fix it:
        return await vscode.window.showErrorMessage('DeviceTree: Unable to find board.', 'Select a board').then(e => {
            if (e) {
                return zephyr.selectBoard(); // TODO: Reload context instead of blocking?
            }
        });
    }

    async addContext(board?: vscode.Uri | zephyr.Board, overlays=<vscode.Uri[]>[], name?: string): Promise<DTSCtx> {
        const ctx = new DTSCtx();
        let boardDoc: vscode.TextDocument;
        if (board instanceof vscode.Uri) {
            ctx.board = { name: path.basename(board.fsPath, path.extname(board.fsPath)), path: board.fsPath, arch: board.fsPath.match(/boards[/\\]([^./\\]+)/)?.[1] };
            boardDoc = await vscode.workspace.openTextDocument(board).then(doc => doc, _ => undefined);
        } else if (board) {
            ctx.board = board;
            boardDoc = await vscode.workspace.openTextDocument(board.path).then(doc => doc, _ => undefined);
        } else if (overlays.length) {
            ctx.board = await this.guessOverlayBoard([...overlays].pop());
            if (!ctx.board) {
                return;
            }

            boardDoc = await vscode.workspace.openTextDocument(ctx.board.path).then(doc => doc, _ => undefined);
        } else {
            return;
        }

        if (!boardDoc) {
            return;
        }

        // Board specific includes:
        if (ctx.board.arch) {
            // Should this be SOC_DIR based?
            ctx.includes = zephyr.modules.map(module => module + '/dts/' + ctx.board.arch);
        }

        ctx.parsing = true;
        ctx.boardFile = await this.parse(ctx, boardDoc);
        ctx.parsing = false;
        ctx.overlays = (await Promise.all(overlays.map(uri => vscode.workspace.openTextDocument(uri).then(doc => this.parse(ctx, doc), () => undefined)))).filter(d => d);
        if (overlays.length && !ctx.overlays.length) {
            return;
        }

        ctx._name = name;

        /* We want to keep the board contexts rid of .dtsi files if we can, as they're not complete.
         * Remove any .dtsi contexts this board file includes:
         */
        if (path.extname(boardDoc.fileName) === '.dts') {
            this.boardCtx = this.boardCtx.filter(existing => path.extname(existing.boardFile.uri.fsPath) === '.dts' || !ctx.has(existing.boardFile.uri));
        }

        if (overlays.length) {
            this.appCtx.push(ctx);
        } else {
            this.boardCtx.push(ctx);
        }

        this.changeEmitter.fire(ctx);
        return ctx;
    }

    removeCtx(ctx: DTSCtx) {
        this.appCtx = this.appCtx.filter(c => c !== ctx);
        this.boardCtx = this.boardCtx.filter(c => c !== ctx);
        if (this.currCtx === ctx) {
            this.currCtx = null;
        }

        this.deleteEmitter.fire(ctx);
    }

    private async onDidOpen(doc: vscode.TextDocument) {
        if (doc.uri.scheme !== 'file' || doc.languageId !== 'dts') {
            return;
        }

        this.currCtx = this.ctx(doc.uri);
        if (this.currCtx) {
            return this.currCtx;
        }

        if (path.extname(doc.fileName) === '.overlay') {
            this.currCtx = await this.addContext(undefined, [doc.uri]);
        } else {
            this.currCtx = await this.addContext(doc.uri, []);
        }

        this.openEmitter.fire(this.currCtx);
        return this.currCtx;
    }

    async setBoard(board: zephyr.Board, ctx?: DTSCtx) {
        ctx = ctx ?? this.currCtx;
        if (ctx) {
            return ctx.setBoard(board).then(() => this.reparse(ctx));
        }
    }

    async insertOverlays(...uris: vscode.Uri[]) {
        if (this.currCtx) {
            uris.forEach(uri => this.currCtx.insertOverlay(uri));
            return this.reparse(this.currCtx);
        }
    }

    /** Reparse after a change.
     *
     * When files change, their URI gets registered in each context.
     * To reparse, we wipe the entries in the changed DTSFiles, and finally wipe the context.
     * This causes the set of nodes referenced in the unchanged files to be free of entries from the
     * changed files. For each file that used to be in the context, we either re-add the nodes it held, or
     * reparse the file (adding any new nodes and their entries). Doing this from the bottom of the
     * file list makes the context look the same as it did the first time when they're parsed.
     */
    private async reparse(ctx: DTSCtx) {
        ctx.parsing = true;
        this.isStable = false;
        const removed = ctx.reset();

        if (removed.board?.dirty) {
            const doc = await vscode.workspace.openTextDocument(removed.board.uri).then(doc => doc, _ => undefined);
            ctx.boardFile = await this.parse(ctx, doc);
        } else {
            ctx.adoptNodes(removed.board);
            ctx.boardFile = removed.board;
        }

        for (const overlay of removed.overlays) {
            if (overlay.dirty) {
                const doc = await vscode.workspace.openTextDocument(overlay.uri).then(doc => doc, _ => undefined);
                ctx.overlays.push(await this.parse(ctx, doc));
            } else {
                ctx.adoptNodes(overlay);
                ctx.overlays.push(overlay);
            }
        }

        ctx.parsing = false;
        this.isStable = true;
        while (this.waiters.length) {
            this.waiters.pop()();
        }

        this.changeEmitter.fire(ctx);
    }

    private async onDidChange(e: vscode.TextDocumentChangeEvent) {
        if (!e.contentChanges.length) {
            return;
        }

        // Postpone reparsing of other contexts until they're refocused:
        [...this.appCtx, ...this.boardCtx].filter(ctx => ctx.has(e.document.uri)).forEach(ctx => ctx.dirty.push(e.document.uri)); // TODO: Filter duplicates?

        if (this.currCtx && !this.currCtx.parsing) {
            this.reparse(this.currCtx);
        }
    }

    private async onDidChangetextEditor(editor?: vscode.TextEditor) {
        if (editor?.document?.languageId === 'dts') {
            const ctx = this.ctx(editor.document.uri);
            if (ctx) {
                this.currCtx = ctx;
                if (ctx.dirty.length) {
                    this.reparse(ctx);
                }

                return;
            }

            this.currCtx = await this.onDidOpen(editor.document);
        } else {
            this.currCtx = null;
        }
    }

    activate(ctx: vscode.ExtensionContext) {
        // ctx.subscriptions.push(vscode.workspace.onDidOpenTextDocument(doc => notActive(() => this.onDidOpen(doc))));
        ctx.subscriptions.push(vscode.workspace.onDidChangeTextDocument(doc => this.onDidChange(doc)));
        ctx.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(e => this.onDidChangetextEditor(e)));
        ctx.subscriptions.push(vscode.workspace.onDidDeleteFiles(e => e.files.forEach(uri => {
            const remove = this.contexts.filter(ctx =>
                (ctx.overlays.length === 1 && ctx.overlays[0].uri.toString() === uri.toString()) ||
                (ctx.boardFile?.uri.toString() === uri.toString()));
            remove.forEach(ctx => this.removeCtx(ctx));

            this.contexts.filter(ctx => ctx.has(uri)).forEach(ctx => ctx.dirty.push(uri));
            if (this.currCtx?.dirty.length) {
                this.reparse(this.currCtx);
            }
        })));
        vscode.window.visibleTextEditors.forEach(e => this.onDidOpen(e.document));
    }

    private async parse(ctx: DTSCtx, doc: vscode.TextDocument): Promise<DTSFile> {
        const file = new DTSFile(doc.uri, ctx);
        const preprocessed = await preprocess(doc, ctx.macros, [...this.includes, ...ctx.includes], file.diags);
        const state = new ParserState(doc.uri, file.diags, ...preprocessed);

        file.includes = state.includes;
        file.lines = state.lines;
        file.macros = state.macros;
        let entries = 0;
        const timeStart = process.hrtime();
        const nodeStack: NodeEntry[] = [];
        let requireSemicolon = false;
        let labels = new Array<string>();
        while (state.skipWhitespace()) {
            const blockComment = state.match(/^\/\*[\s\S]*?\*\//);
            if (blockComment) {
                continue;
            }

            const comment = state.match(/^\/\/.*/);
            if (comment) {
                continue;
            }

            if (requireSemicolon) {
                requireSemicolon = false;
                const semicolon = state.match(/^;/);
                if (!semicolon) {
                    const loc = state.location();
                    state.pushDiag('Missing semicolon', vscode.DiagnosticSeverity.Error, loc);
                    state.pushSemicolonAction(loc);
                }

                continue;
            }

            const label = state.match(/^([\w-]+):\s*/);
            if (label) {
                labels.push(label[1]);
                continue;
            }

            const nameStart = state.freeze();
            const name = state.match(/^([#?\w,.+-]+)/);
            if (name) {
                const addr = state.match(/^@([\da-fA-F]+)/);
                const nameLoc = state.location(nameStart);

                state.skipWhitespace();

                const nodeMatch = state.match(/^{/);
                if (nodeMatch) {
                    let node = new Node(name[1],
                        addr?.[1],
                        nodeStack.length > 0 ? nodeStack[nodeStack.length - 1].node : undefined);

                    if (ctx.nodes[node.path]) {
                        node = ctx.nodes[node.path];
                    } else {
                        ctx.nodes[node.path] = node;
                    }

                    const entry = new NodeEntry(nameLoc, node, nameLoc, file, entries++);

                    entry.labels.push(...labels);
                    node.entries.push(entry);
                    file.entries.push(entry);

                    if (nodeStack.length === 0) {
                        file.roots.push(entry);
                    } else {
                        nodeStack[nodeStack.length - 1].children.push(entry);
                        entry.parent = nodeStack[nodeStack.length - 1];
                    }

                    nodeStack.push(entry);

                    if (addr?.[1]?.startsWith('0') && Number(addr[1]) !== 0) {
                        state.pushDiag(`Address should not start with leading 0's`, vscode.DiagnosticSeverity.Warning);
                        const action = state.pushAction(`Trim leading 0's`, vscode.CodeActionKind.QuickFix);
                        action.edit = new vscode.WorkspaceEdit();
                        action.edit.delete(nameLoc.uri,
                            new vscode.Range(nameLoc.range.start.line, nameLoc.range.start.character + name[0].length + 1,
                                             nameLoc.range.end.line,   nameLoc.range.end.character - addr[1].length + addr[1].match(/0+/)[0].length));

                    }

                    labels = [];
                    continue;
                }

                requireSemicolon = true;

                if (addr) {
                    state.pushDiag(`Only nodes have addresses. Expecting opening node block`, vscode.DiagnosticSeverity.Warning, nameLoc);
                    continue;
                }

                state.skipWhitespace();
                const hasPropValue = state.match(/^=/);
                if (hasPropValue) {
                    if (nodeStack.length > 0) {
                        const p = new Property(name[0], nameLoc, state, nodeStack[nodeStack.length - 1], labels);
                        nodeStack[nodeStack.length - 1].properties.push(p);
                    } else {
                        state.pushDiag('Property outside of node context', vscode.DiagnosticSeverity.Error, nameLoc);
                    }

                    labels = [];
                    continue;
                }

                if (nodeStack.length > 0) {
                    const p = new Property(name[0], nameLoc, state, nodeStack[nodeStack.length - 1], labels);
                    nodeStack[nodeStack.length - 1].properties.push(p);
                    labels = [];
                    continue;
                }

                state.pushDiag('Property outside of node context', vscode.DiagnosticSeverity.Error, nameLoc);
                continue;
            }

            const refMatch = state.match(/^(&[\w-]+|&{[\w@/-]+})/);
            if (refMatch) {
                const refLoc = state.location();
                state.skipWhitespace();

                const isNode = state.match(/^{/);
                if (!isNode) {
                    state.pushDiag('References can only be made to nodes');
                    continue;
                }

                let node = ctx.node(refMatch[1]);
                if (!node) {
                    state.pushDiag('Unknown label', vscode.DiagnosticSeverity.Error, refLoc);
                    node = new Node(refMatch[1]);
                }

                const entry = new NodeEntry(refLoc, node, refLoc, file, entries++);
                entry.labels.push(...labels);
                node.entries.push(entry);
                entry.ref = refMatch[1];
                if (nodeStack.length === 0) {
                    file.roots.push(entry);
                }

                file.entries.push(entry);
                nodeStack.push(entry);
                labels = [];
                continue;
            }

            if (labels.length) {
                state.pushDiag('Expected node or property after label', vscode.DiagnosticSeverity.Warning);
                labels = [];
            }

            const versionDirective = state.match(/^\/dts-v.+?\/\s*/);
            if (versionDirective) {
                requireSemicolon = true;
                continue;
            }

            const deleteNode = state.match(/^\/delete-node\//);
            if (deleteNode) {
                state.skipWhitespace();
                requireSemicolon = true;

                const node = state.match(/^&?[\w,.+/@-]+/);
                if (!node) {
                    state.pushDiag(`Expected node`);
                    continue;
                }

                let n: Node;
                if (node[0].startsWith('&') || nodeStack.length === 0) {
                    n = ctx.node(node[0]);
                } else {
                    /* Scope the node search to the current node's children */
                    n = ctx.node(node[0], nodeStack[nodeStack.length - 1].node);
                }
                if (n) {
                    n.deleted = state.location();
                } else {
                    state.pushDiag(`Unknown node`, vscode.DiagnosticSeverity.Warning);
                }
                continue;
            }

            const deleteProp = state.match(/^\/delete-property\//);
            if (deleteProp) {
                state.skipWhitespace();
                requireSemicolon = true;

                const prop = state.match(/^[#?\w,._+-]+/);
                if (!prop) {
                    state.pushDiag('Expected property');
                    continue;
                }

                if (!nodeStack.length) {
                    state.pushDiag(`Can only delete properties inside a node`);
                    continue;
                }

                const props = nodeStack[nodeStack.length-1]?.node.properties();
                if (!props) {
                    continue;
                }
                const p = props.find(p => p.name === deleteProp[0]);
                if (!p) {
                    state.pushDiag(`Unknown property`, vscode.DiagnosticSeverity.Warning);
                    continue;
                }

                continue;
            }

            const rootMatch = state.match(/^\/\s*{/);
            if (rootMatch) {
                if (!ctx.root) {
                    ctx.nodes['/'] = new Node('');
                }
                const entry = new NodeEntry(state.location(), ctx.root, new vscode.Location(state.location().uri, state.location().range.start), file, entries++);
                ctx.root.entries.push(entry);
                file.roots.push(entry);
                file.entries.push(entry);
                nodeStack.push(entry);
                continue;
            }

            const closingBrace = state.match(/^}/);
            if (closingBrace) {
                if (nodeStack.length > 0) {
                    const entry = nodeStack.pop();
                    entry.loc = new vscode.Location(entry.loc.uri, new vscode.Range(entry.loc.range.start, state.location().range.end));
                } else {
                    state.pushDiag('Unexpected closing bracket');
                    state.pushDeleteAction('Delete unnecessary closing bracket').isPreferred = true;
                }

                requireSemicolon = true;
                continue;
            }

            state.skipToken();
            state.pushDiag('Unexpected token');
            state.pushDeleteAction('Delete invalid token').isPreferred = true;
        }

        if (nodeStack.length > 0) {
            const loc = state.location();
            const entry = nodeStack[nodeStack.length - 1];
            entry.loc = new vscode.Location(entry.loc.uri, new vscode.Range(entry.loc.range.start, state.location().range.end));
            console.error(`Unterminated node: ${nodeStack[nodeStack.length - 1].node.name}`);
            state.pushDiag('Unterminated node', vscode.DiagnosticSeverity.Error, entry.nameLoc);
            state.pushInsertAction('Close brackets', '\n' + nodeStack.map((_, i) => '\t'.repeat(i) + '};\n').reverse().join(''), loc).isPreferred = true;
        }

        if (requireSemicolon) {
            state.pushDiag(`Expected semicolon`, vscode.DiagnosticSeverity.Error);
            state.pushSemicolonAction();
        }

        const procTime = process.hrtime(timeStart);

        console.log(`Parsed ${doc.uri.fsPath} in ${(procTime[0] * 1e9 + procTime[1]) / 1000000} ms`);
        console.log(`Nodes: ${Object.keys(ctx.nodes).length} entries: ${Object.values(ctx.nodes).reduce((sum, n) => sum + n.entries.length, 0)}`);

        // Resolve types:
        let time = process.hrtime();
        Object.values(ctx.nodes).forEach(node => {
            if (!node.type?.valid) {
                node.type = this.types.nodeType(node);
            }
        });
        time = process.hrtime(time);
        console.log(`Resolved types for ${file.uri.fsPath} in ${(time[0] * 1e9 + time[1]) / 1000000} ms`);
        file.diags = state.diags;
        return file;
    }
}

export function getCells(propName: string, parent?: Node): string[] | undefined {
    const cellProp = getPHandleCells(propName, parent);

    if (cellProp) {
        return ['label'].concat(Array(<number> cellProp.value[0].val).fill('cell'));
    }

    if (propName === 'reg') {
        const addrCells = parent?.addrCells() ?? 2;
        const sizeCells = parent?.sizeCells() ?? 1;
        return [...Array(addrCells).fill('addr'), ...Array(sizeCells).fill('size')];
    }
}

export function cellName(propname: string) {
    if (propname.endsWith('s')) {
        /* Weird rule: phandle array cell count is determined by the #XXX-cells entry in the parent,
         * where XXX is the singular version of the name of this property UNLESS the property is called XXX-gpios, in which
         * case the cell count is determined by the parent's #gpio-cells property
         */
        return propname.endsWith('-gpios') ? 'gpio-cells' : propname.slice(0, propname.length - 1) + '-cells';
    }

    if (propname.endsWith('-map')) {
        return propname.slice(0, propname.length - '-map'.length) + '-cells';
    }

    if (propname === 'interrupts-extended') {
        return 'interrupt-cells';
    }
}

export function getPHandleCells(propname: string, parent: Node): Property {
    return parent?.property('#' + cellName(propname));
}