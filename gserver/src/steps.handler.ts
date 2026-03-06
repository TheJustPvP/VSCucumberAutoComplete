import * as glob from 'glob';
import * as commentParser from 'doctrine';

import {
    Definition,
    CompletionItem,
    Diagnostic,
    DiagnosticSeverity,
    Position,
    Location,
    Range,
    CompletionItemKind,
    InsertTextFormat,
} from 'vscode-languageserver';

import {
    getOSPath,
    getFileContent,
    clearComments,
    getMD5Id,
    escapeRegExp,
    escaprRegExpForPureText,
    getTextRange,
    getSortPrefix,
} from './util';

import {
    allGherkinWords,
    GherkinType,
    getGherkinType,
    getGherkinTypeLower,
} from './gherkin';

import { Settings, StepSettings, CustomParameter } from './types';

export type Step = {
  id: string;
  reg: RegExp;
  partialReg: RegExp;
  text: string;
  pureText: boolean;
  desc: string;
  def: Definition;
  count: number;
  gherkin: GherkinType;
  documentation: string;
};

export type StepsCountHash = {
  [step: string]: number;
};

interface JSDocComments {
  [key: number]: string;
}

type ExternalStepEntry = string | {
  text?: string;
  documentation?: string;
  description?: string;
  path?: string;
  section?: string;
  file?: string;
  procedure?: string;
  name?: string;
  step?: string;
  // Russian keys from 1C export
  '\u0418\u043c\u044f\u0428\u0430\u0433\u0430'?: string;
  '\u041e\u043f\u0438\u0441\u0430\u043d\u0438\u0435\u0428\u0430\u0433\u0430'?: string;
  '\u041f\u043e\u043b\u043d\u044b\u0439\u0422\u0438\u043f\u0428\u0430\u0433\u0430'?: string;
  '\u0424\u0430\u0439\u043b'?: string;
  '\u0418\u043c\u044f\u041f\u0440\u043e\u0446\u0435\u0434\u0443\u0440\u044b'?: string;
};

type StepBuildOptions = {
  forcePureText?: boolean;
  vaParameterizeQuotes?: boolean;
};

export default class StepsHandler {
    elements: Step[] = [];

    elementsHash: { [step: string]: boolean } = {};

    elemenstCountHash: StepsCountHash = {};
    bestDocumentationByNormalizedText = new Map<string, string>();

    settings: Settings;

    constructor(root: string, settings: Settings) {
        const { syncfeatures, steps } = settings;
        this.settings = settings;
        this.populate(root, steps);
        if (syncfeatures === true) {
            this.setElementsHash(`${root}/**/*.feature`);
        } else if (typeof syncfeatures === 'string') {
            this.setElementsHash(`${root}/${syncfeatures}`);
        }
    }

    getGherkinRegEx() {
        return new RegExp(`^(\\s*)(${allGherkinWords})(\\s+)(.*)`, 'i');
    }

    getElements(): Step[] {
        return this.elements;
    }

    isAbsoluteGlobPath(path: string) {
        return (
            /^[a-zA-Z]:[\\/]/.test(path) ||
            path.startsWith('\\\\')
        );
    }

    resolveGlobPath(root: string, path: string) {
        return this.isAbsoluteGlobPath(path) ? path : `${root}/${path}`;
    }

    setElementsHash(path: string): void {
        this.elemenstCountHash = {};
        const files = glob.sync(path);
        files.forEach((f) => {
            const text = getFileContent(f);
            text.split(/\r?\n/g).forEach((line) => {
                const match = this.getGherkinMatch(line, text);
                if (match) {
                    const step = this.getStepByText(match[4]);
                    if (step) {
                        this.incrementElementCount(step.id);
                    }
                }
            });
        });
        this.elements.forEach((el) => (el.count = this.getElementCount(el.id)));
    }

    incrementElementCount(id: string) {
        if (this.elemenstCountHash[id]) {
            this.elemenstCountHash[id]++;
        } else {
            this.elemenstCountHash[id] = 1;
        }
    }

    getElementCount(id: string) {
        return this.elemenstCountHash[id] || 0;
    }

    getStepRegExp() {
    //Actually, we dont care what the symbols are before our 'Gherkin' word
    //But they shouldn't end with letter
        const startPart = "^((?:[^'\"/]*?[^\\w])|.{0})";

        //All the steps should be declared using any gherkin keyword. We should get first 'gherkin' word
        const gherkinPart =
      this.settings.gherkinDefinitionPart ||
      `(${allGherkinWords}|defineStep|Step|StepDefinition)`;

        //All the symbols, except of symbols, using as step start and letters, could be between gherkin word and our step
        const nonStepStartSymbols = '[^/\'"`\\w]*?';

        // Step part getting
        const { stepRegExSymbol } = this.settings;
        // Step text could be placed between '/' symbols (ex. in JS) or between quotes, like in Java
        const stepStart = stepRegExSymbol ? `(${stepRegExSymbol})` : '(/|\'|"|`)';
        // ref to RegEx Example: https://regex101.com/r/mS1zJ8/1
        // Use a RegEx that peeks ahead to ensure escape character can still work, like `\'`.
        const stepBody = '((?:(?=(?:\\\\)*)\\\\.|.)*?)';
        //Step should be ended with same symbol it begins
        const stepEnd = stepRegExSymbol ? stepRegExSymbol : '\\3';

        //Our RegExp will be case-insensitive to support cases like TypeScript (...@when...)
        const r = new RegExp(
            startPart +
        gherkinPart +
        nonStepStartSymbols +
        stepStart +
        stepBody +
        stepEnd,
            'i'
        );

        // /^((?:[^'"\/]*?[^\w])|.{0})(Given|When|Then|And|But|defineStep)[^\/'"\w]*?(\/|'|")([^\3]+)\3/i
        return r;
    }

    geStepDefinitionMatch(line: string) {
        return line.match(this.getStepRegExp());
    }

    getOutlineVars(text: string) {
        return text.split(/\r?\n/g).reduce((res, a, i, arr) => {
            if (a.match(/^\s*Examples:\s*$/) && arr[i + 2]) {
                const names = arr[i + 1].split(/\s*\|\s*/).slice(1, -1);
                const values = arr[i + 2].split(/\s*\|\s*/).slice(1, -1);
                names.forEach((n, i) => {
                    if (values[i]) {
                        res[n] = values[i];
                    }
                });
            }
            return res;
        }, {} as Record<string, string>);
    }

    getGherkinMatch(line: string, document: string) {
        const outlineMatch = line.match(/<.*?>/g);
        if (outlineMatch) {
            const outlineVars = this.getOutlineVars(document);
            //We should support both outlines lines variants - with and without quotes
            const pureLine = outlineMatch
                .map((s) => s.replace(/<|>/g, ''))
                .reduce((resLine, key) => {
                    if (outlineVars[key]) {
                        resLine = resLine.replace(`<${key}>`, outlineVars[key]);
                    }
                    return resLine;
                }, line);
            const quotesLine = outlineMatch
                .map((s) => s.replace(/<|>/g, ''))
                .reduce((resLine, key) => {
                    if (outlineVars[key]) {
                        resLine = resLine.replace(`<${key}>`, `"${outlineVars[key]}"`);
                    }
                    return resLine;
                }, line);
            const pureMatch = pureLine.match(this.getGherkinRegEx());
            const quotesMatch = quotesLine.match(this.getGherkinRegEx());
            if (quotesMatch && quotesMatch[4] && this.getStepByText(quotesMatch[4])) {
                return quotesMatch;
            } else {
                return pureMatch;
            }
        }
        return line.match(this.getGherkinRegEx());
    }

    handleCustomParameters(step: string) {
        const { customParameters } = this.settings;
        if (!customParameters.length) {
            return step;
        }
        customParameters.forEach((p: CustomParameter) => {
            if (p.isRegex) {
                const { parameter, value, flags } = p;
                try {
                    step = step.replace(new RegExp(parameter, flags), value);
                    return;
                } catch {
                    return;
                }
            }
            
            const { parameter, value } = p;
            step = step.split(parameter).join(value);
        });
        return step;
    }

    specialParameters = [
        //Ruby interpolation (like `#{Something}` ) should be replaced with `.*`
        //https://github.com/alexkrechik/VSCucumberAutoComplete/issues/65
        [/#{(.*?)}/g, '.*'],

        //Parameter-types
        //https://github.com/alexkrechik/VSCucumberAutoComplete/issues/66
        //https://docs.cucumber.io/cucumber/cucumber-expressions/
        [/{float}/g, '-?\\d*\\.?\\d+'],
        [/{int}/g, '-?\\d+'],
        [/{stringInDoubleQuotes}/g, '"[^"]+"'],
        [/{word}/g, '[^\\s]+'],
        [/{string}/g, "(\"|')[^\\1]*\\1"],
        [/{}/g, '.*'],
    ] as const

    getRegTextForPureStep(step: string) {
        
        // Change all the special parameters
        this.specialParameters.forEach(([parameter, change]) => {
            step = step.replace(parameter, change)
        })
    
        // Escape all special symbols
        step = escaprRegExpForPureText(step)

        // Escape all the special parameters back
        this.specialParameters.forEach(([, change]) => {
            const escapedChange = escaprRegExpForPureText(change);
            step = step.replace(escapedChange, change)
        })

        // Compile the final regex
        return `^${step}$`;
    }

    getRegTextForVAPureStep(step: string) {
        const token = '__VA_QUOTED_PARAM__';
        step = step.replace(/"[^"\r\n]*"|'[^'\r\n]*'/g, token);
        step = escaprRegExpForPureText(step);
        const escapedToken = escaprRegExpForPureText(token);
        step = step.replace(
            new RegExp(escapedToken, 'g'),
            '(?:"|\')[^"\'\\r\\n]*(?:"|\')'
        );
        return `^${step}$`;
    }

    getRegTextForStep(step: string) {

        this.specialParameters.forEach(([parameter, change]) => {
            step = step.replace(parameter, change)
        })

        //Optional Text
        step = step.replace(/\(([a-z\s]+)\)/g, '($1)?');

        //Alternative text a/b/c === (a|b|c)
        step = step.replace(
            /([a-zA-Z]+)(?:\/([a-zA-Z]+))+/g,
            (match) => `(${match.replace(/\//g, '|')})`
        );

        //Handle Cucumber Expressions (like `{Something}`) should be replaced with `.*`
        //https://github.com/alexkrechik/VSCucumberAutoComplete/issues/99
        //Cucumber Expressions Custom Parameter Type Documentation
        //https://docs.cucumber.io/cucumber-expressions/#custom-parameters
        step = step.replace(/([^\\]|^){(?![\d,])(.*?)}/g, '$1.*');

        //Escape all the regex symbols to avoid errors
        step = escapeRegExp(step);

        return step;
    }

    getPartialRegParts(text: string) {
    // We should separate got string into the parts by space symbol
    // But we should not touch /()/ RegEx elements
        text = this.settings.pureTextSteps
            ? this.getRegTextForPureStep(text)
            : this.getRegTextForStep(text);
        let currString = '';
        let bracesMode = false;
        let openingBracesNum = 0;
        let closingBracesNum = 0;
        const res = [];
        for (let i = 0; i <= text.length; i++) {
            const currSymbol = text[i];
            if (i === text.length) {
                res.push(currString);
            } else if (bracesMode) {
                //We should do this hard check to avoid circular braces errors
                if (currSymbol === ')') {
                    closingBracesNum++;
                    if (openingBracesNum === closingBracesNum) {
                        bracesMode = false;
                    }
                }
                if (currSymbol === '(') {
                    openingBracesNum++;
                }
                currString += currSymbol;
            } else {
                if (currSymbol === ' ') {
                    res.push(currString);
                    currString = '';
                } else if (currSymbol === '(') {
                    currString += '(';
                    bracesMode = true;
                    openingBracesNum = 1;
                    closingBracesNum = 0;
                } else {
                    currString += currSymbol;
                }
            }
        }
        return res;
    }

    getPartialRegText(regText: string) {
    //Same with main reg, only differ is match any string that same or less that current one
        return this.getPartialRegParts(regText)
            .map((el) => `(${el}|$)`)
            .join('( |$)')
            .replace(/^\^|^/, '^');
    }

    getTextForStep(step: string) {
    //Remove all the backslashes
        step = step.replace(/\\/g, '');

        //Remove "string start" and "string end" RegEx symbols
        step = step.replace(/^\^|\$$/g, '');

        return step;
    }

    getDescForStep(step: string) {
    //Remove 'Function body' part
        step = step.replace(/\{.*/, '');

        //Remove spaces in the beginning end in the end of string
        step = step.replace(/^\s*/, '').replace(/\s*$/, '');

        return step;
    }

    getStepTextInvariants(step: string): string[] {
    //Handle regexp's like 'I do (one|to|three)'
    //TODO - generate correct num of invariants for the circular braces
        const bracesRegEx = /(\([^)()]+\|[^()]+\))/;
        if (~step.search(bracesRegEx)) {
            const match = step.match(bracesRegEx);
            const matchRes = match![1];
            const variants = matchRes
                .replace(/\(\?:/, '')
                .replace(/^\(|\)$/g, '')
                .split('|');
            return variants.reduce((varRes, variant) => {
                return varRes.concat(
                    this.getStepTextInvariants(step.replace(matchRes, variant))
                );
            }, new Array<string>());
        } else {
            return [step];
        }
    }

    getCompletionInsertText(
        step: string,
        stepPart: string,
        pureText?: boolean,
        documentation?: string
    ) {
    // Return only part we need for our step
        let res = step;
        const strArray = this.getPartialRegParts(res);
        const currArray = new Array<string>();
        const { length } = strArray;
        for (let i = 0; i < length; i++) {
            currArray.push(strArray.shift()!);
            try {
                const r = new RegExp('^' + escapeRegExp(currArray.join(' ')), 'i');
                if (!r.test(stepPart)) {
                    res = new Array<string>()
                        .concat(currArray.slice(-1), strArray)
                        .join(' ');
                    break;
                }
            } catch (err) {
                //TODO - show some warning
            }
        }

        if (this.settings.smartSnippets) {
            /*
                Now we should change all the 'user input' items to some snippets
                Create our regexp for this:
                1) \(? - we be started from opening brace
                2) \\.|\[\[^\]]\] - [a-z] or \w or .
                3) \*|\+|\{[^\}]+\} - * or + or {1, 2}
                4) \)? - could be finished with opening brace
            */
            const match = res.match(
                /((?:\()?(?:\\.|\.|\[[^\]]+\])(?:\*|\+|\{[^}]+\})(?:\)?))/g
            );
            if (match) {
                for (let i = 0; i < match.length; i++) {
                    const num = i + 1;
                    res = res.replace(match[i], () => '${' + num + ':}');
                }
            }
        } else {
            //We can replace some outputs, ex. strings in brackets to make insert strings more neat
            res = res.replace(/"\[\^"\]\+"/g, '""');
        }

        if (this.settings.pureTextSteps || pureText) {
            // Replace all the escape chars for now
            res = res.replace(/\\/g, '');
            // Also remove start and end of the string - we don't need them in the completion
            res = res.replace(/^\^/, '');
            res = res.replace(/\$$/, '');
        }

        return this.appendDocumentationTable(res, documentation, step);
    }

    appendDocumentationTable(insertText: string, documentation?: string, stepText?: string) {
        const table = this.extractTableTemplate(documentation);
        const fallbackTable = table ? '' : this.getFallbackVaTableTemplate(stepText || insertText);
        const finalTable = table || fallbackTable;
        if (!finalTable) {
            return insertText;
        }
        if (insertText.includes('\n|') || /^\s*\|/.test(insertText.trim())) {
            return insertText;
        }
        return `${insertText}\n${finalTable}`;
    }

    extractTableTemplate(documentation?: string) {
        if (!documentation || !documentation.trim()) {
            return '';
        }
        const lines = documentation.replace(/\r/g, '').split('\n');
        const tableLines: string[] = [];
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('```')) {
                continue;
            }
            const pipeCount = (trimmed.match(/\|/g) || []).length;
            if (pipeCount >= 2) {
                let row = trimmed;
                if (!row.startsWith('|')) {
                    row = `| ${row}`;
                }
                if (!row.endsWith('|')) {
                    row = `${row} |`;
                }
                tableLines.push(row);
                continue;
            }
            if (tableLines.length) {
                break;
            }
        }
        // Header + at least one row
        return tableLines.length >= 2 ? tableLines.join('\n') : '';
    }

    getFallbackVaTableTemplate(text: string) {
        const normalized = text.toLowerCase();
        const hasTableContext = /\u0432 \u0442\u0430\u0431\u043b\u0438\u0446/.test(normalized) ||
            /\u0437\u0430\u043f\u043e\u043b\u043d\u044f\u044e \u0442\u0430\u0431\u043b\u0438\u0446/.test(normalized);
        const hasRowIntent = /\u043f\u0435\u0440\u0435\u0445\u043e\u0436\u0443 \u043a \u0441\u0442\u0440\u043e\u043a\u0435/.test(normalized) ||
            /(^|\s)\u0434\u0430\u043d\u043d\u044b\u043c\u0438(\s|$)/.test(normalized);
        const hasParamIntent = /\u0441 \u043f\u0430\u0440\u0430\u043c\u0435\u0442\u0440/.test(normalized) &&
            /:\s*$/.test(normalized);
        if (!(hasTableContext && hasRowIntent) && !hasParamIntent) {
            return '';
        }
        if (hasParamIntent && !(hasTableContext && hasRowIntent)) {
            return [
                "| '\u041f\u0430\u0440\u0430\u043c\u0435\u0442\u0440' | '\u0417\u043d\u0430\u0447\u0435\u043d\u0438\u0435' |",
                "| '\u0418\u043c\u044f\u041f\u0430\u0440\u0430\u043c\u0435\u0442\u0440\u0430' | '\u0417\u043d\u0430\u0447\u0435\u043d\u0438\u0435\u041f\u0430\u0440\u0430\u043c\u0435\u0442\u0440\u0430' |",
            ].join('\n');
        }
        return [
            "| '\u0418\u043c\u044f\u041a\u043e\u043b\u043e\u043d\u043a\u0438' |",
            "| '\u0417\u043d\u0430\u0447\u0435\u043d\u0438\u0435\u041a\u043e\u043b\u043e\u043d\u043a\u0438' |",
        ].join('\n');
    }

    getDocumentation(stepRawComment: string) {
        const stepParsedComment = commentParser.parse(stepRawComment.trim(), {
            unwrap: true,
            sloppy: true,
            recoverable: true,
        });
        return (
            stepParsedComment.description ||
      (stepParsedComment.tags.find((tag) => tag.title === 'description') || {})
          .description ||
      (stepParsedComment.tags.find((tag) => tag.title === 'desc') || {})
          .description ||
      stepRawComment
        );
    }

    getSteps(
        fullStepLine: string,
        stepPart: string,
        def: Location,
        gherkin: GherkinType,
        comments: JSDocComments,
        options?: StepBuildOptions
    ): Step[] {
        const forcePureText = !!options?.forcePureText;
        const vaParameterizeQuotes = !!options?.vaParameterizeQuotes;
        const stepsVariants = this.settings.stepsInvariants
            ? this.getStepTextInvariants(stepPart)
            : [stepPart];
        const desc = this.getDescForStep(fullStepLine);
        const comment = comments[def.range.start.line];
        const documentation = comment
            ? this.getDocumentation(comment)
            : fullStepLine;
        return stepsVariants
            .filter((step) => {
                //Filter invalid long regular expressions
                try {
                    const regText = (this.settings.pureTextSteps || forcePureText)
                        ? (vaParameterizeQuotes
                            ? this.getRegTextForVAPureStep(step)
                            : this.getRegTextForPureStep(step))
                        : this.getRegTextForStep(step);
                    new RegExp(regText);
                    return true;
                } catch (err) {
                    //Todo - show some warning
                    return false;
                }
            })
            .map((step) => {
                const regText = (this.settings.pureTextSteps || forcePureText)
                    ? (vaParameterizeQuotes
                        ? this.getRegTextForVAPureStep(step)
                        : this.getRegTextForPureStep(step))
                    : this.getRegTextForStep(step);
                const reg = new RegExp(regText, 'i');
                let partialReg;
                // Use long regular expression in case of error
                try {
                    partialReg = new RegExp(this.getPartialRegText(step), 'i');
                } catch (err) {
                    // Todo - show some warning
                    partialReg = reg;
                }
                //Todo we should store full value here
                const text = (this.settings.pureTextSteps || forcePureText)
                    ? step
                    : this.getTextForStep(step);
                const id = 'step' + getMD5Id(text);
                const count = this.getElementCount(id);
                return {
                    id,
                    reg,
                    partialReg,
                    text,
                    pureText: this.settings.pureTextSteps || !!forcePureText,
                    desc,
                    def,
                    count,
                    gherkin,
                    documentation,
                };
            });
    }

    getMultiLineComments(content: string) {
        return content.split(/\r?\n/g).reduce(
            (res, line, i) => {
                if (~line.search(/^\s*\/\*/)) {
                    res.current = `${line}\n`;
                    res.commentMode = true;
                } else if (~line.search(/^\s*\*\//)) {
                    res.current += `${line}\n`;
                    res.comments[i + 1] = res.current;
                    res.commentMode = false;
                } else if (res.commentMode) {
                    res.current += `${line}\n`;
                }
                return res;
            },
            {
                comments: {} as JSDocComments,
                current: '',
                commentMode: false,
            }
        ).comments;
    }

    getFileSteps(filePath: string) {
        if (/\.bsl$/i.test(filePath)) {
            return this.getBSLFileSteps(filePath);
        }

        const fileContent = getFileContent(filePath);
        const fileComments = this.getMultiLineComments(fileContent);
        const definitionFile = clearComments(fileContent);
        return definitionFile
            .split(/\r?\n/g)
            .reduce((steps, line, lineIndex, lines) => {
                //TODO optimize
                let match;
                let finalLine = '';
                const currLine = this.handleCustomParameters(line);
                const currentMatch = this.geStepDefinitionMatch(currLine);
                //Add next line to our string to handle two-lines step definitions
                const nextLine = this.handleCustomParameters(lines[lineIndex + 1] || '');
                if (currentMatch) {
                    match = currentMatch;
                    finalLine = currLine;
                } else if (nextLine) {
                    const nextLineMatch = this.geStepDefinitionMatch(nextLine);
                    const bothLinesMatch = this.geStepDefinitionMatch(
                        currLine + nextLine
                    );
                    if (bothLinesMatch && !nextLineMatch) {
                        match = bothLinesMatch;
                        finalLine = currLine + nextLine;
                    }
                }
                if (match) {
                    const [, beforeGherkin, gherkinString, , stepPart] = match;
                    const gherkin = getGherkinTypeLower(gherkinString);
                    const pos = Position.create(lineIndex, beforeGherkin.length);
                    const def = Location.create(
                        getOSPath(filePath),
                        Range.create(pos, pos)
                    );
                    steps = steps.concat(
                        this.getSteps(finalLine, stepPart, def, gherkin, fileComments)
                    );
                }
                return steps;
            }, new Array<Step>());
    }

    getBSLFileSteps(filePath: string) {
        const fileContent = getFileContent(filePath);
        const lines = fileContent.split(/\r?\n/g);
        const comments = {} as JSDocComments;
        const commentDeclaredSteps = lines.reduce((steps, line, lineIndex) => {
            const commentMatch = line.match(/^\s*\/\/\s*(.+?)\s*$/);
            if (!commentMatch) {
                return steps;
            }

            const stepLine = commentMatch[1];
            const gherkinMatch = this.getGherkinMatch(stepLine, fileContent);
            if (!gherkinMatch) {
                return steps;
            }

            // Vanessa steps are declared as `// <step text>` and usually followed by `//@StepAlias(...)`.
            const nextNonEmptyLine = lines
                .slice(lineIndex + 1)
                .find((l) => l.trim().length > 0);
            if (!nextNonEmptyLine || !/^\s*\/\/\s*@/.test(nextNonEmptyLine)) {
                return steps;
            }

            const [, beforeGherkin, gherkinWord, , stepPart] = gherkinMatch;
            // Filter noisy "technical" steps like `Р "РСЃС‚РёРЅР°" С‚РѕРіРґР°`.
            if (/^\s*['"]/.test(stepPart)) {
                return steps;
            }
            const gherkin = getGherkinTypeLower(gherkinWord);
            const commentPrefixMatch = line.match(/^(\s*\/\/\s*)/);
            const commentPrefixLength = commentPrefixMatch ? commentPrefixMatch[1].length : 0;
            const pos = Position.create(
                lineIndex,
                commentPrefixLength + beforeGherkin.length
            );
            const def = Location.create(
                getOSPath(filePath),
                Range.create(pos, pos)
            );

            return steps.concat(
                this.getSteps(stepLine, stepPart, def, gherkin, comments, {
                    forcePureText: true,
                    vaParameterizeQuotes: true,
                })
            );
        }, new Array<Step>());

        const addStepDeclaredSteps = this.getBSLAddStepCalls(filePath, fileContent, comments);

        return commentDeclaredSteps.concat(addStepDeclaredSteps);
    }

    getBSLAddStepCalls(filePath: string, fileContent: string, comments: JSDocComments) {
        const callsRegex = /\u0414\u043e\u0431\u0430\u0432\u0438\u0442\u044c\u0428\u0430\u0433\u0412\u041c\u0430\u0441\u0441\u0438\u0432\u0422\u0435\u0441\u0442\u043e\u0432\s*\(([\s\S]*?)\)\s*;/gi;
        const quotedRegex = /"((?:""|[^"])*)"/g;
        const steps = new Array<Step>();
        let callMatch: RegExpExecArray | null;

        while ((callMatch = callsRegex.exec(fileContent)) !== null) {
            const argsBlock = callMatch[1];
            const quotedArgs = Array.from(argsBlock.matchAll(quotedRegex)).map(
                (m) => m[1].replace(/""/g, '"')
            );
            // Typical VA format:
            // Р”РѕР±Р°РІРёС‚СЊРЁР°РіР’РњР°СЃСЃРёРІРўРµСЃС‚РѕРІ(..., "Snippet", "Procedure", "Gherkin text", ...)
            const stepLine = quotedArgs[2];
            if (!stepLine) {
                continue;
            }

            const gherkinMatch = this.getGherkinMatch(stepLine, fileContent);
            if (!gherkinMatch) {
                continue;
            }

            const [, beforeGherkin, gherkinWord, , stepPart] = gherkinMatch;
            if (/^\s*['"]/.test(stepPart)) {
                continue;
            }
            const gherkin = getGherkinTypeLower(gherkinWord);
            const lineIndex = fileContent
                .slice(0, callMatch.index)
                .split(/\r?\n/g).length - 1;
            const def = Location.create(
                getOSPath(filePath),
                Range.create(
                    Position.create(lineIndex, beforeGherkin.length),
                    Position.create(lineIndex, beforeGherkin.length)
                )
            );

            steps.push(...this.getSteps(stepLine, stepPart, def, gherkin, comments, {
                forcePureText: true,
                vaParameterizeQuotes: true,
            }));
        }

        return steps;
    }

    validateConfiguration(
        settingsFile: string,
        stepsPathes: StepSettings,
        workSpaceRoot: string
    ) {
        return stepsPathes.reduce((res, path) => {
            const files = glob.sync(this.resolveGlobPath(workSpaceRoot, path));
            if (!files.length) {
                const searchTerm = path.replace(workSpaceRoot + '/', '');
                const range = getTextRange(
                    workSpaceRoot + '/' + settingsFile,
                    `"${searchTerm}"`
                );
                res.push({
                    severity: DiagnosticSeverity.Warning,
                    range: range,
                    message: 'No steps files found',
                    source: 'cucumberautocomplete',
                });
            }
            return res;
        }, new Array<Diagnostic>());
    }

    populate(root: string, stepsPathes: StepSettings) {
        this.elementsHash = {};
        this.bestDocumentationByNormalizedText.clear();
        this.elements = stepsPathes
            .reduce(
                (files, path) =>
                    files.concat(glob.sync(this.resolveGlobPath(root, path), { absolute: true })),
                new Array<string>()
            )
            .reduce(
                (elements, f) =>
                    elements.concat(
                        this.getFileSteps(f).reduce((steps, step) => {
                            if (!this.elementsHash[step.id]) {
                                steps.push(step);
                                this.elementsHash[step.id] = true;
                            }
                            return steps;
                        }, new Array<Step>())
                    ),
                new Array<Step>()
            );

        if (this.settings.includeExportScenarios) {
            // Include export scenarios from workspace feature files (VA style).
            this.getExportScenarioSteps(root).forEach((step) => {
                if (!this.elementsHash[step.id]) {
                    this.elements.push(step);
                    this.elementsHash[step.id] = true;
                }
            });
        }

        this.getExternalJsonSteps(root).forEach((step) => {
            const existing = this.elements.find((el) => el.id === step.id);
            if (existing) {
                existing.documentation = this.pickBetterDocumentation(
                    existing.documentation,
                    step.documentation
                );
                return;
            }
            if (!this.elementsHash[step.id]) {
                this.elements.push(step);
                this.elementsHash[step.id] = true;
            }
        });

        this.rebuildBestDocumentationIndex();
    }

    pickBetterDocumentation(currentDoc: string, candidateDoc: string) {
        if (!candidateDoc || !candidateDoc.trim()) {
            return currentDoc;
        }
        if (!currentDoc || !currentDoc.trim()) {
            return candidateDoc;
        }
        const currentTable = this.extractTableTemplate(currentDoc);
        const candidateTable = this.extractTableTemplate(candidateDoc);
        if (!currentTable && candidateTable) {
            return candidateDoc;
        }
        return candidateDoc.length > currentDoc.length ? candidateDoc : currentDoc;
    }

    normalizeStepTextForMerge(text: string) {
        return text
            .toLowerCase()
            .replace(/'([^'\r\n]*)'/g, '"$1"')
            .replace(/\s+/g, ' ')
            .trim();
    }

    getBestDocumentationForStepText(stepText: string, currentDoc: string) {
        const normalized = this.normalizeStepTextForMerge(stepText);
        return this.pickBetterDocumentation(
            currentDoc || '',
            this.bestDocumentationByNormalizedText.get(normalized) || ''
        );
    }

    rebuildBestDocumentationIndex() {
        this.bestDocumentationByNormalizedText.clear();
        this.elements.forEach((el) => {
            const key = this.normalizeStepTextForMerge(el.text);
            const prev = this.bestDocumentationByNormalizedText.get(key) || '';
            this.bestDocumentationByNormalizedText.set(
                key,
                this.pickBetterDocumentation(prev, el.documentation)
            );
        });
    }

    getExternalJsonSteps(root: string) {
        const jsonPaths = this.settings.vaStepsJson || [];
        return jsonPaths.reduce((res, configuredPath) => {
            const path = this.resolveGlobPath(root, configuredPath);
            const files = glob.sync(path, { absolute: true });
            files.forEach((filePath) => {
                const content = getFileContent(filePath);
                if (!content) {
                    return;
                }
                let parsed: ExternalStepEntry[];
                try {
                    const json = JSON.parse(content);
                    parsed = Array.isArray(json)
                        ? json
                        : Array.isArray(json?.steps)
                            ? json.steps
                            : [];
                } catch {
                    return;
                }

                parsed.forEach((entry, i) => {
                    const text = typeof entry === 'string'
                        ? entry
                        : (entry.text || (entry as Record<string, string>)['ИмяШага'] || entry.step || entry.name || '');
                    const doc = typeof entry === 'string'
                        ? undefined
                        : (
                            entry.documentation ||
                            entry.description ||
                            (entry as Record<string, string>)['ОписаниеШага'] ||
                            (entry as Record<string, string>)['ПолныйТипШага']
                        );
                    if (!text || !text.trim()) {
                        return;
                    }
                    const gherkinMatch = this.getGherkinMatch(text, content);
                    const pos = Position.create(i, 0);
                    const def = Location.create(
                        getOSPath(filePath),
                        Range.create(pos, pos)
                    );
                    let steps: Step[];
                    if (gherkinMatch) {
                        const [, , gherkinWord, , stepPart] = gherkinMatch;
                        steps = this.getSteps(
                            text,
                            stepPart,
                            def,
                            getGherkinTypeLower(gherkinWord),
                            {},
                            {
                                forcePureText: true,
                                vaParameterizeQuotes: true,
                            }
                        );
                    } else {
                        steps = this.getSteps(text, text, def, GherkinType.Other, {}, {
                            forcePureText: true,
                            vaParameterizeQuotes: true,
                        });
                    }
                    res.push(
                        ...steps.map((step) => ({
                            ...step,
                            documentation: doc || step.documentation,
                        }))
                    );
                });
            });
            return res;
        }, new Array<Step>());
    }

    getExportScenarioSteps(root: string) {
        const files = glob.sync(`${root}/**/*.feature`, { absolute: true });
        return files.reduce((res, filePath) => {
            if (this.shouldSkipExportScenarioPath(filePath)) {
                return res;
            }
            const content = getFileContent(filePath);
            const lines = content.split(/\r?\n/g);
            const hasExportTag = lines.some((l) => /(^|\s)@exportscenarios(\s|$)/i.test(l));
            if (!hasExportTag) {
                return res;
            }

            const scenarioHeaderReg = /^\s*(?:\u0421\u0446\u0435\u043d\u0430\u0440\u0438\u0439|Scenario|\u0421\u0442\u0440\u0443\u043a\u0442\u0443\u0440\u0430 \u0441\u0446\u0435\u043d\u0430\u0440\u0438\u044f):\s*(.+?)\s*$/i;
            for (let i = 0; i < lines.length; i++) {
                const headerMatch = lines[i].match(scenarioHeaderReg);
                if (!headerMatch) {
                    continue;
                }

                const scenarioName = headerMatch[1];
                const body = [] as string[];
                for (let j = i + 1; j < lines.length; j++) {
                    if (
                        lines[j].match(scenarioHeaderReg) ||
                        lines[j].match(/^\s*@(?!@)/)
                    ) {
                        break;
                    }
                    body.push(lines[j]);
                }

                const pos = Position.create(i, 0);
                const def = Location.create(
                    getOSPath(filePath),
                    Range.create(pos, pos)
                );
                const steps = this.getSteps(
                    scenarioName,
                    scenarioName,
                    def,
                    GherkinType.Given,
                    {},
                    {
                        forcePureText: true,
                        vaParameterizeQuotes: true,
                    }
                ).map((step) => ({
                    ...step,
                    documentation: body.join('\n').trim() || scenarioName,
                }));
                res = res.concat(steps);
            }

            return res;
        }, new Array<Step>());
    }

    getStepByText(text: string, gherkin?: GherkinType) {
        const normalizedText = text.replace(/'([^'\r\n]*)'/g, '"$1"');
        return this.elements.find(
            (s) => {
                const isGherkinOk = gherkin !== undefined ? s.gherkin === gherkin : true;
                const isStepOk = s.reg.test(text) || s.reg.test(normalizedText);
                return isGherkinOk && isStepOk;
            }
        );
    }

    isVALikeStep(step: Step) {
        const uri = ([] as Location[]).concat(step.def)[0]?.uri?.toLowerCase() || '';
        return uri.endsWith('.bsl') || uri.endsWith('.json');
    }

    getComparableWords(text: string) {
        return text
            .toLowerCase()
            .replace(/"[^"\r\n]*"|'[^'\r\n]*'/g, '')
            .split(/\s+/)
            .filter(Boolean);
    }

    hasRelaxedVAPrefixMatch(text: string, gherkin?: GherkinType) {
        const words = this.getComparableWords(text);
        if (words.length < 2) {
            return false;
        }
        return this.elements.some((s) => {
            if (!this.isVALikeStep(s)) {
                return false;
            }
            if (gherkin !== undefined && s.gherkin !== gherkin) {
                return false;
            }
            const stepWords = this.getComparableWords(s.text);
            return stepWords.length >= 2 &&
                stepWords[0] === words[0] &&
                stepWords[1] === words[1];
        });
    }

    validate(line: string, lineNum: number, text: string) {
        const lower = text.toLowerCase();
        if (lower.includes('@exportscenarios') || /(^|\s)@exportscenarios(\s|$)/im.test(text)) {
            return null;
        }
        // In many VA repos '*' is used as a visual section marker, not as a step.
        if (/^\s*\*\s+/.test(line)) {
            return null;
        }
        line = line.replace(/\s*$/, '');
        const lineForError = line.replace(/^\s*/, '');
        const match = this.getGherkinMatch(line, text);
        if (!match) {
            return null;
        }
        const beforeGherkin = match[1];
        const gherkinPart = match[2];
        const gherkinWord = this.settings.strictGherkinValidation
            ? this.getStrictGherkinType(gherkinPart, lineNum, text)
            : undefined;
        const step = this.getStepByText(match[4], gherkinWord);
        if (step) {
            return null;
        } else if (this.hasRelaxedVAPrefixMatch(match[4], gherkinWord)) {
            // In VA, many steps are templates with runtime parameters,
            // so exact text match is often too strict for validation.
            return null;
        } else {
            return {
                severity: DiagnosticSeverity.Warning,
                range: {
                    start: { line: lineNum, character: beforeGherkin.length },
                    end: { line: lineNum, character: line.length },
                },
                message: `Was unable to find step for "${lineForError}"`,
                source: 'cucumberautocomplete',
            } as Diagnostic;
        }
    }

    getDefinition(line: string, text: string) {
        const match = this.getGherkinMatch(line, text);
        if (!match) {
            return null;
        }
        const step = this.getStepByText(match[4]);
        return step ? step.def : null;
    }

    getHover(line: string, text: string) {
        const match = this.getGherkinMatch(line, text);
        if (!match) {
            return null;
        }
        const step = this.getStepByText(match[4]);
        return step ? step.documentation : null;
    }

    getStrictGherkinType(gherkinPart: string, lineNumber: number, text: string) {
        const gherkinType = getGherkinType(gherkinPart);
        if (gherkinType === GherkinType.And || gherkinType === GherkinType.But) {
            return text
                .split(/\r?\n/g)
                .slice(0, lineNumber)
                .reduceRight((res, val) => {
                    if (res === GherkinType.Other) {
                        const match = this.getGherkinMatch(val, text);
                        if (match) {
                            const [, , prevGherkinPart] = match;
                            const prevGherkinPartType = getGherkinTypeLower(prevGherkinPart);
                            if (
                                ~[
                                    GherkinType.Given,
                                    GherkinType.When,
                                    GherkinType.Then,
                                ].indexOf(prevGherkinPartType)
                            ) {
                                res = prevGherkinPartType;
                            }
                        }
                    }
                    return res;
                }, GherkinType.Other);
        } else {
            return getGherkinTypeLower(gherkinPart);
        }
    }

    getCompletion(
        line: string,
        lineNumber: number,
        text: string
    ): CompletionItem[] | null {
    //Get line part without gherkin part
        const match = this.getGherkinMatch(line, text);
        if (!match) {
            return null;
        }
        const [, , gherkinPart, , stepPartBase] = match;
        //We don't need last word in our step part due to it could be incompleted
        let stepPart = stepPartBase || '';
        stepPart = stepPart.replace(/[^\s]+$/, '');
        const completionItems = this.elements
        //Filter via gherkin words comparing if strictGherkinCompletion option provided
            .filter((step) => {
                if (this.settings.strictGherkinCompletion) {
                    const strictGherkinPart = this.getStrictGherkinType(
                        gherkinPart,
                        lineNumber,
                        text
                    );
                    return step.gherkin === strictGherkinPart;
                } else {
                    return true;
                }
            })
        //Current string without last word should partially match our regexp
            .filter((step) =>
                step.partialReg.test(stepPart) ||
                step.partialReg.test(stepPart.replace(/'([^'\r\n]*)'/g, '"$1"'))
            )
            .filter((step) => !/^\s*['"]/.test(step.text))
        //We got all the steps we need so we could make completions from them
            .map((step) => {
                const bestDocumentation = this.getBestDocumentationForStepText(
                    step.text,
                    step.documentation
                );
                return {
                    label: step.text,
                    kind: CompletionItemKind.Snippet,
                    data: step.id,
                    documentation: bestDocumentation,
                    sortText: getSortPrefix(step.count, 5) + '_' + step.text,
                    insertText: this.getCompletionInsertText(
                        step.text,
                        stepPart,
                        step.pureText,
                        bestDocumentation
                    ),
                    insertTextFormat: InsertTextFormat.Snippet,
                };
            });
        const byLabel = new Map<string, CompletionItem>();
        completionItems.forEach((item) => {
            const key = (item.label || '').toString().trim().toLowerCase();
            if (!key) {
                return;
            }
            const existing = byLabel.get(key);
            if (!existing) {
                byLabel.set(key, item);
                return;
            }
            const existingInsert = (existing.insertText || '').toString();
            const candidateInsert = (item.insertText || '').toString();
            const existingHasTable = /\r?\n\s*\|/.test(existingInsert);
            const candidateHasTable = /\r?\n\s*\|/.test(candidateInsert);
            if (!existingHasTable && candidateHasTable) {
                byLabel.set(key, item);
                return;
            }
            if (existingHasTable === candidateHasTable) {
                const existingDoc = (existing.documentation || '').toString();
                const candidateDoc = (item.documentation || '').toString();
                const existingScore = existingInsert.length + existingDoc.length;
                const candidateScore = candidateInsert.length + candidateDoc.length;
                if (candidateScore > existingScore) {
                    byLabel.set(key, item);
                }
            }
        });
        const res = Array.from(byLabel.values());
        return res.length ? res : null;
    }

    getCompletionResolve(item: CompletionItem) {
        this.incrementElementCount(item.data);
        return item;
    }

    shouldSkipExportScenarioPath(filePath: string) {
        return /[\\/]vanessa[-_]add([\\/]|$)/i.test(filePath);
    }
}
