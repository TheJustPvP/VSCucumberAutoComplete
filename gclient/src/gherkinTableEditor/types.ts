export interface GherkinTable {
    rows: string[][];
    indent: string;
}

export type GherkinTableEditorMessage =
    | { type: 'ok'; rows: string[][] }
    | { type: 'cancel' };
