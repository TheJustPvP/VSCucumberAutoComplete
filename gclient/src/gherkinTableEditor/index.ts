import * as vscode from 'vscode';
import {
    findGherkinTableRange,
    getIndent,
    parseGherkinTable,
} from './parser';
import { formatGherkinTable } from './formatter';
import { openGherkinTableWebview } from './webview';

const EDIT_COMMAND = 'cucumberautocompletevaedition.editGherkinTable';
const FORMAT_COMMAND = 'cucumberautocompletevaedition.formatGherkinTable';

function resolveTableIndent(
    document: vscode.TextDocument,
    tableStartLine: number,
    currentIndent: string
): string {
    if (tableStartLine <= 0) { return currentIndent; }
    const stepText = document.lineAt(tableStartLine - 1).text;
    const stepIndent = stepText.match(/^(\s*)/)?.[1] ?? '';
    if (currentIndent.length <= stepIndent.length) {
        return stepIndent + '\t';
    }
    return currentIndent;
}

async function applyTableReplacement(
    editor: vscode.TextEditor,
    range: vscode.Range,
    text: string
) {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(editor.document.uri, range, text);
    await vscode.workspace.applyEdit(edit);
}

function readRangeLines(document: vscode.TextDocument, range: vscode.Range): string[] {
    const result: string[] = [];
    for (let i = range.start.line; i <= range.end.line; i++) {
        result.push(document.lineAt(i).text);
    }
    return result;
}

export function registerGherkinTableEditor(
    context: vscode.ExtensionContext
): vscode.Disposable[] {
    const formatDisposable = vscode.commands.registerCommand(
        FORMAT_COMMAND,
        async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.languageId !== 'feature') {
                return;
            }
            const range = findGherkinTableRange(
                editor.document,
                editor.selection.active.line
            );
            if (!range) {
                vscode.window.showWarningMessage(
                    'Курсор должен находиться внутри таблицы Gherkin.'
                );
                return;
            }

            const rawLines = readRangeLines(editor.document, range);
            const table = parseGherkinTable(rawLines);
            const indent = resolveTableIndent(editor.document, range.start.line, table.indent);
            const formatted = formatGherkinTable(table.rows, indent);
            await applyTableReplacement(editor, range, formatted);
        }
    );

    const editDisposable = vscode.commands.registerCommand(
        EDIT_COMMAND,
        async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.languageId !== 'feature') {
                return;
            }
            const range = findGherkinTableRange(
                editor.document,
                editor.selection.active.line
            );
            if (!range) {
                vscode.window.showWarningMessage(
                    'Курсор должен находиться внутри таблицы Gherkin.'
                );
                return;
            }

            const rawLines = readRangeLines(editor.document, range);
            const table = parseGherkinTable(rawLines);
            const result = await openGherkinTableWebview(context, table);
            if (!result) {
                return;
            }

            const indent = resolveTableIndent(editor.document, range.start.line, getIndent(rawLines[0] ?? ''));
            const text = formatGherkinTable(result.rows, indent);
            await applyTableReplacement(editor, range, text);
        }
    );

    return [editDisposable, formatDisposable];
}
