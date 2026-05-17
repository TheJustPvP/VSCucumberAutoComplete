export function formatGherkinTable(rows: string[][], indent = ''): string {
    if (rows.length === 0) {
        return '';
    }

    const maxCells = rows.reduce((max, row) => Math.max(max, row.length), 0);
    const widths: number[] = new Array(maxCells).fill(0);

    for (const row of rows) {
        for (let i = 0; i < maxCells; i++) {
            const cell = row[i] ?? '';
            if (cell.length > widths[i]) {
                widths[i] = cell.length;
            }
        }
    }

    return rows
        .map((row) => {
            const cells: string[] = [];
            for (let i = 0; i < maxCells; i++) {
                const cell = row[i] ?? '';
                cells.push(cell.padEnd(widths[i], ' '));
            }
            return `${indent}| ${cells.join(' | ')} |`;
        })
        .join('\n');
}
