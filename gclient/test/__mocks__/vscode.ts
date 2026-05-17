export class Position {
    constructor(public line: number, public character: number) {}
}

export class Range {
    public start: Position;
    public end: Position;
    constructor(
        startLine: number | Position,
        startChar: number | Position,
        endLine?: number,
        endChar?: number
    ) {
        if (startLine instanceof Position && startChar instanceof Position) {
            this.start = startLine;
            this.end = startChar;
        } else {
            this.start = new Position(startLine as number, startChar as number);
            this.end = new Position(endLine as number, endChar as number);
        }
    }
}

export const window = {};
export const workspace = {};
export const commands = {};
export const languages = {};
