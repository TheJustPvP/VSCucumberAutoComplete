import {
    splitGherkinRow,
    parseGherkinTable,
    isTableRow,
    getIndent,
    findGherkinTableRange,
} from '../src/gherkinTableEditor/parser';
import { formatGherkinTable } from '../src/gherkinTableEditor/formatter';

describe('gherkin table parser', () => {
    describe('isTableRow', () => {
        it('распознаёт строку таблицы с любым отступом', () => {
            expect(isTableRow('| a | b |')).toBe(true);
            expect(isTableRow('    | a | b |')).toBe(true);
            expect(isTableRow('\t\t|x|')).toBe(true);
        });
        it('возвращает false для не-табличных строк', () => {
            expect(isTableRow('Когда я делаю что-то')).toBe(false);
            expect(isTableRow('')).toBe(false);
            expect(isTableRow('# | comment')).toBe(false);
        });
    });

    describe('getIndent', () => {
        it('возвращает ведущие пробелы и табы', () => {
            expect(getIndent('    | a |')).toBe('    ');
            expect(getIndent('\t\t| a |')).toBe('\t\t');
            expect(getIndent('| a |')).toBe('');
        });
    });

    describe('splitGherkinRow', () => {
        it('разбивает обычную строку', () => {
            expect(splitGherkinRow('| a | b | c |')).toEqual(['a', 'b', 'c']);
        });
        it('сохраняет экранированный |', () => {
            expect(splitGherkinRow('| 340\\|350 | x |')).toEqual([
                '340\\|350',
                'x',
            ]);
            expect(splitGherkinRow('| a \\| b \\| c |')).toEqual(['a \\| b \\| c']);
        });
        it('обрабатывает строку без замыкающего |', () => {
            expect(splitGherkinRow('| this')).toEqual(['this']);
        });
        it('тримит ячейки', () => {
            expect(splitGherkinRow('|   foo   |   bar   |')).toEqual([
                'foo',
                'bar',
            ]);
        });
        it('сохраняет одинарные кавычки внутри значений', () => {
            expect(splitGherkinRow("| 'Колонка1' | 'Значение1' |")).toEqual([
                "'Колонка1'",
                "'Значение1'",
            ]);
        });
    });

    describe('parseGherkinTable', () => {
        it('добавляет пустые ячейки до максимальной ширины', () => {
            const result = parseGherkinTable([
                '| a | b | c |',
                '| 1 |',
                '| 2 | 3 |',
            ]);
            expect(result.rows).toEqual([
                ['a', 'b', 'c'],
                ['1', '', ''],
                ['2', '3', ''],
            ]);
        });
        it('сохраняет отступ первой строки', () => {
            const result = parseGherkinTable(['    | a |', '    | b |']);
            expect(result.indent).toBe('    ');
        });
    });

    describe('findGherkinTableRange', () => {
        function makeDoc(lines: string[]) {
            return {
                lineCount: lines.length,
                lineAt: (i: number) => ({ text: lines[i] }),
            } as any;
        }
        it('возвращает диапазон от первой до последней строки таблицы', () => {
            const doc = makeDoc([
                'Когда я делаю',
                '| a | b |',
                '| 1 | 2 |',
                '| 3 | 4 |',
                'Тогда',
            ]);
            const range = findGherkinTableRange(doc, 2);
            expect(range).toBeDefined();
            expect(range!.start.line).toBe(1);
            expect(range!.end.line).toBe(3);
        });
        it('возвращает undefined если курсор не на таблице', () => {
            const doc = makeDoc(['Когда я делаю', '| a |', 'Тогда']);
            expect(findGherkinTableRange(doc, 0)).toBeUndefined();
            expect(findGherkinTableRange(doc, 2)).toBeUndefined();
        });
    });
});

describe('gherkin table formatter', () => {
    it('выравнивает ширину колонок по максимальному значению', () => {
        const formatted = formatGherkinTable([
            ['name', 'email'],
            ['Aslak', 'aslak@cucumber.io'],
            ['Matt', 'matt@cucumber.io'],
        ]);
        expect(formatted).toBe(
            [
                '| name  | email             |',
                '| Aslak | aslak@cucumber.io |',
                '| Matt  | matt@cucumber.io  |',
            ].join('\n')
        );
    });
    it('сохраняет переданный отступ', () => {
        const formatted = formatGherkinTable([['a'], ['b']], '\t\t');
        expect(formatted.split('\n')).toEqual(['\t\t| a |', '\t\t| b |']);
    });
    it('дополняет короткие строки пустыми ячейками', () => {
        const formatted = formatGherkinTable([
            ['a', 'b', 'c'],
            ['1'],
        ]);
        expect(formatted).toBe(['| a | b | c |', '| 1 |   |   |'].join('\n'));
    });
    it('round-trip: parse + format не теряет данные', () => {
        const lines = [
            "| 'Колонка1'  | 'Колонка2' |",
            "| 'Значение1' | 'V'        |",
        ];
        const parsed = parseGherkinTable(lines);
        const formatted = formatGherkinTable(parsed.rows, parsed.indent);
        expect(formatted.split('\n')).toEqual(lines);
    });
});
