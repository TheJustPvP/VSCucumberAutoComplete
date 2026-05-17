import * as vscode from 'vscode';
import { GherkinTable } from './types';

const TABLE_ROW_RE = /^\s*\|/;

export function isTableRow(line: string): boolean {
    return TABLE_ROW_RE.test(line);
}

export function getIndent(line: string): string {
    return line.match(/^\s*/)?.[0] ?? '';
}

export function splitGherkinRow(row: string): string[] {
    const trimmed = row.replace(/\s+$/, '').replace(/^\s+/, '');
    if (!trimmed.startsWith('|')) {
        return [trimmed];
    }

    const content = trimmed.endsWith('|')
        ? trimmed.slice(1, -1)
        : trimmed.slice(1);

    const cells: string[] = [];
    let current = '';
    let i = 0;

    while (i < content.length) {
        const char = content[i];

        if (char === '\\' && i + 1 < content.length && content[i + 1] === '|') {
            current += '\\|';
            i += 2;
            continue;
        }

        if (char === '|') {
            cells.push(current.trim());
            current = '';
            i++;
            continue;
        }

        current += char;
        i++;
    }

    cells.push(current.trim());
    return cells;
}

export function parseGherkinTable(lines: string[]): GherkinTable {
    const rows = lines.map(splitGherkinRow);
    const indent = lines.length > 0 ? getIndent(lines[0]) : '';

    const maxCells = rows.reduce((max, row) => Math.max(max, row.length), 0);
    const normalized = rows.map((row) => {
        if (row.length >= maxCells) {
            return row;
        }
        const padded = row.slice();
        while (padded.length < maxCells) {
            padded.push('');
        }
        return padded;
    });

    return { rows: normalized, indent };
}

export function findGherkinTableRange(
    document: vscode.TextDocument,
    currentLine: number
): vscode.Range | undefined {
    if (currentLine < 0 || currentLine >= document.lineCount) {
        return undefined;
    }
    if (!isTableRow(document.lineAt(currentLine).text)) {
        return undefined;
    }

    let start = currentLine;
    let end = currentLine;

    while (start > 0 && isTableRow(document.lineAt(start - 1).text)) {
        start--;
    }
    while (
        end + 1 < document.lineCount &&
        isTableRow(document.lineAt(end + 1).text)
    ) {
        end++;
    }

    return new vscode.Range(start, 0, end, document.lineAt(end).text.length);
}
