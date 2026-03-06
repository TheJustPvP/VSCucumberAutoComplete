import * as path from 'path';
import { TextDecoder } from 'util';

import {
    workspace,
    ExtensionContext,
    window,
    commands,
    ConfigurationTarget,
    Uri,
    Range,
    TextEditor,
    Location,
    Position,
    Hover,
    MarkdownString,
    languages,
} from 'vscode';
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    TransportKind,
} from 'vscode-languageclient/node';
import { activateVALibrary } from './vaLibrary';

type ExportScenario = {
    title: string;
    body: string[];
    sourcePath: string;
    sourceLine: number;
};

let client: LanguageClient;
let exportScenariosStatusBar: ReturnType<typeof window.createStatusBarItem>;
let exportScenariosDecoration: ReturnType<typeof window.createTextEditorDecorationType>;
const exportScenariosMap = new Map<string, ExportScenario>();
const parameterizedExportScenarios: Array<{ scenario: ExportScenario; matcher: RegExp }> = [];
const decoder = new TextDecoder('utf-8');
let activePreviewKey = '';
let previewSessionVersion = 0;
let exportScenariosEnabled = false;
let isApplyingExportState = false;

function getExportScenariosEnabled() {
    return workspace
        .getConfiguration('cucumberautocomplete')
        .get<boolean>('includeExportScenarios', false);
}

function updateExportScenariosStatusBar() {
    const enabled = exportScenariosEnabled;
    exportScenariosStatusBar.text = enabled
        ? '$(check) Export Scenarios: On'
        : '$(circle-slash) Export Scenarios: Off';
    exportScenariosStatusBar.tooltip = 'Toggle export scenarios support';
}

function normalizeText(text: string) {
    return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function normalizeExportMatchText(text: string) {
    return normalizeText(text).replace(/'([^'\r\n]*)'/g, '"$1"');
}

function escapeRegExp(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildQuotedParamMatcher(text: string): RegExp | null {
    const normalized = normalizeExportMatchText(text);
    if (!/["']/.test(normalized)) {
        return null;
    }

    const token = '__va_export_param__';
    const template = normalized.replace(/"[^"\r\n]*"|'[^'\r\n]*'/g, token);
    const escaped = escapeRegExp(template).replace(
        new RegExp(escapeRegExp(token), 'g'),
        '"[^"\\r\\n]*"'
    );
    return new RegExp(`^${escaped}$`, 'i');
}

function shouldSkipExportScenarioPath(filePath: string) {
    return /[\\/]vanessa[-_]add([\\/]|$)/i.test(filePath);
}

function getStepPart(line: string): string | null {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('@') || trimmed.includes(':')) {
        return null;
    }
    const firstSpace = trimmed.indexOf(' ');
    if (firstSpace < 0) {
        return null;
    }
    const keyword = trimmed.slice(0, firstSpace).toLowerCase();
    const allowed = new Set([
        '\u0434\u0430\u043d\u043e', // Дано
        '\u0434\u043e\u043f\u0443\u0441\u0442\u0438\u043c', // Допустим
        '\u043a\u043e\u0433\u0434\u0430', // Когда
        '\u0442\u043e\u0433\u0434\u0430', // Тогда
        '\u0438', // И
        '\u043d\u043e', // Но
        'given',
        'when',
        'then',
        'and',
        'but',
        '*',
    ]);
    if (!allowed.has(keyword)) {
        return null;
    }
    return trimmed.slice(firstSpace + 1).trim();
}

function tryGetScenarioTitle(line: string): string | null {
    const m = line.match(/^\s*([^:]+):\s*(.+?)\s*$/);
    if (!m) {
        return null;
    }
    const key = normalizeText(m[1]);
    if (
        key === '\u0441\u0446\u0435\u043d\u0430\u0440\u0438\u0439' ||
        key === '\u0441\u0442\u0440\u0443\u043a\u0442\u0443\u0440\u0430 \u0441\u0446\u0435\u043d\u0430\u0440\u0438\u044f' ||
        key === 'scenario' ||
        key === 'scenario outline'
    ) {
        return m[2].trim();
    }
    return null;
}

async function rebuildExportScenariosMap() {
    exportScenariosMap.clear();
    parameterizedExportScenarios.length = 0;
    if (!exportScenariosEnabled) {
        return;
    }

    const files = await workspace.findFiles('**/*.feature', '**/{node_modules,.git}/**');
    for (const uri of files) {
        if (shouldSkipExportScenarioPath(uri.fsPath)) {
            continue;
        }
        const bytes = await workspace.fs.readFile(uri);
        const text = decoder.decode(bytes);
        const lines = text.split(/\r?\n/g);
        const hasExportTag = lines.some((l) => /(^|\s)@exportscenarios(\s|$)/i.test(l));
        if (!hasExportTag) {
            continue;
        }

        for (let i = 0; i < lines.length; i++) {
            const scenarioTitle = tryGetScenarioTitle(lines[i]);
            if (!scenarioTitle) {
                continue;
            }

            const body: string[] = [];
            for (let j = i + 1; j < lines.length; j++) {
                if (tryGetScenarioTitle(lines[j]) || /^\s*@(?!@)/.test(lines[j])) {
                    break;
                }
                const trimmed = lines[j].trim();
                if (!trimmed) {
                    continue;
                }
                body.push(lines[j].replace(/\t/g, '    '));
            }

            const key = normalizeExportMatchText(scenarioTitle);
            if (!exportScenariosMap.has(key)) {
                const scenario: ExportScenario = {
                    title: scenarioTitle,
                    body,
                    sourcePath: uri.fsPath,
                    sourceLine: i,
                };
                exportScenariosMap.set(key, scenario);
                const matcher = buildQuotedParamMatcher(scenarioTitle);
                if (matcher) {
                    parameterizedExportScenarios.push({ scenario, matcher });
                }
            }
        }
    }
}

function findExportScenarioByStepPart(stepPart: string) {
    const normalizedStep = normalizeExportMatchText(stepPart);
    const exact = exportScenariosMap.get(normalizedStep);
    if (exact) {
        return exact;
    }

    for (const candidate of parameterizedExportScenarios) {
        if (candidate.matcher.test(normalizedStep)) {
            return candidate.scenario;
        }
    }
    return undefined;
}

function updateEditorExportDecorations(editor?: TextEditor) {
    const target = editor || window.activeTextEditor;
    if (!target || target.document.languageId !== 'feature') {
        return;
    }

    if (!exportScenariosEnabled) {
        target.setDecorations(exportScenariosDecoration, []);
        return;
    }

    const ranges: Range[] = [];
    for (let i = 0; i < target.document.lineCount; i++) {
        const stepPart = getStepPart(target.document.lineAt(i).text);
        if (!stepPart) {
            continue;
        }
        if (findExportScenarioByStepPart(stepPart)) {
            const line = target.document.lineAt(i);
            ranges.push(new Range(i, 0, i, line.text.length));
        }
    }
    target.setDecorations(exportScenariosDecoration, ranges);
}

function updateVisibleEditorsDecorations() {
    window.visibleTextEditors.forEach((editor) => updateEditorExportDecorations(editor));
}

async function closeExportPeekIfOpen() {
    activePreviewKey = '';
    try {
        await commands.executeCommand('closeReferenceSearch');
    } catch {
        // no-op
    }
    try {
        await commands.executeCommand('editor.action.closeReferenceSearch');
    } catch {
        // no-op
    }
    try {
        const editor = window.activeTextEditor;
        if (editor) {
            await commands.executeCommand(
                'editor.action.peekLocations',
                editor.document.uri,
                editor.selection.active,
                [],
                'peek'
            );
        }
    } catch {
        // no-op
    }
    await new Promise<void>((resolve) => {
        setTimeout(() => {
            void commands.executeCommand('closeReferenceSearch').then(
                () => resolve(),
                () => resolve()
            );
        }, 30);
    });
}

function findExportScenarioAtLine(
    document: { lineCount: number; lineAt: (line: number) => { text: string } },
    lineIndex: number
) {
    if (lineIndex < 0 || lineIndex >= document.lineCount) {
        return undefined;
    }

    const stepPart = getStepPart(document.lineAt(lineIndex).text);
    if (!stepPart) {
        return undefined;
    }

    const scenario = findExportScenarioByStepPart(stepPart);
    if (!scenario || !scenario.body.length) {
        return undefined;
    }

    return { scenario, lineIndex };
}

function findFirstExportScenarioInDocument(document: {
    lineCount: number;
    lineAt: (line: number) => { text: string };
}) {
    for (let i = 0; i < document.lineCount; i++) {
        const found = findExportScenarioAtLine(document, i);
        if (found) {
            return found;
        }
    }
    return undefined;
}

export function activate(context: ExtensionContext) {
    exportScenariosEnabled = getExportScenariosEnabled();
    const serverModule = context.asAbsolutePath(path.join('gserver', 'out', 'server.js'));
    const bundledVaJsonPath = context.asAbsolutePath(
        path.join('resources', 'default-va-step-library.json')
    );
    const userVaJsonPath = Uri.joinPath(context.globalStorageUri, 'va-step-library.json').fsPath;
    void workspace.fs.createDirectory(context.globalStorageUri);

    const serverOptions: ServerOptions = {
        run: { module: serverModule, transport: TransportKind.ipc },
        debug: { module: serverModule, transport: TransportKind.ipc },
    };

    const clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: 'file', language: 'feature' }],
        synchronize: {
            fileEvents: workspace.createFileSystemWatcher('**/.clientrc'),
        },
        initializationOptions: {
            vaBundledJsonPath: bundledVaJsonPath,
            vaUserJsonPath: userVaJsonPath,
        },
    };

    client = new LanguageClient(
        'cucumberautocomplete-client',
        'Cucumber auto complete plugin',
        serverOptions,
        clientOptions
    );
    client.start();

    exportScenariosDecoration = window.createTextEditorDecorationType({
        gutterIconPath: context.asAbsolutePath(path.join('img', 'export-step.svg')),
        gutterIconSize: 'contain',
        isWholeLine: true,
    });

    exportScenariosStatusBar = window.createStatusBarItem(1);
    exportScenariosStatusBar.command = 'cucumberautocompletevaedition.toggleExportScenarios';
    updateExportScenariosStatusBar();
    exportScenariosStatusBar.show();

    const showPreviewForActiveEditor = async (editor?: TextEditor, force = false) => {
        const version = previewSessionVersion;
        const target = editor || window.activeTextEditor;
        if (!target || target.document.languageId !== 'feature' || !exportScenariosEnabled) {
            return;
        }

        const selectedLine = target.selection.active.line;
        const found =
            findExportScenarioAtLine(target.document, selectedLine) ||
            findFirstExportScenarioInDocument(target.document);
        if (!found) {
            return;
        }

        const previewKey = `${target.document.uri.toString()}:${found.lineIndex}`;
        if (!force && activePreviewKey === previewKey) {
            return;
        }
        activePreviewKey = previewKey;

        const sourceUri = Uri.file(found.scenario.sourcePath);
        const sourceLine = Math.max(0, found.scenario.sourceLine);
        if (version !== previewSessionVersion || !exportScenariosEnabled) {
            return;
        }

        await commands.executeCommand(
            'editor.action.peekLocations',
            target.document.uri,
            new Position(found.lineIndex, 0),
            [new Location(sourceUri, new Range(sourceLine, 0, sourceLine, 0))],
            'peek'
        );
    };

    const applyExportState = async (next: boolean) => {
        previewSessionVersion++;
        exportScenariosEnabled = next;
        updateExportScenariosStatusBar();

        // phase 1: fully clear old UI state
        await closeExportPeekIfOpen();
        exportScenariosMap.clear();
        parameterizedExportScenarios.length = 0;
        updateVisibleEditorsDecorations();

        // phase 2: rebuild and re-open if enabled
        if (!next) {
            return;
        }
        await rebuildExportScenariosMap();
        updateVisibleEditorsDecorations();
        activePreviewKey = '';
        await showPreviewForActiveEditor(undefined, true);
    };

    const toggleCommand = commands.registerCommand(
        'cucumberautocompletevaedition.toggleExportScenarios',
        async () => {
            if (isApplyingExportState) {
                return;
            }
            if (!workspace.workspaceFolders?.length) {
                window.showWarningMessage(
                    'Режим Export Scenarios недоступен без открытой папки проекта. Если вы открыли только один `.feature`-файл, откройте весь репозиторий в VS Code (Файл -> Открыть папку).'
                );
                return;
            }
            isApplyingExportState = true;
            try {
                const current = exportScenariosEnabled;
                const next = !current;
                await workspace
                    .getConfiguration('cucumberautocomplete')
                    .update('includeExportScenarios', next, ConfigurationTarget.Workspace);
                await applyExportState(next);
            } finally {
                isApplyingExportState = false;
            }
        }
    );

    const configSubscription = workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration('cucumberautocomplete.includeExportScenarios')) {
            return;
        }
        if (isApplyingExportState) {
            return;
        }
        const next = getExportScenariosEnabled();
        void applyExportState(next);
    });

    const featureWatcher = workspace.createFileSystemWatcher('**/*.feature');
    const refresh = () => {
        if (!exportScenariosEnabled) {
            exportScenariosEnabled = false;
            return;
        }
        void rebuildExportScenariosMap().then(() => updateVisibleEditorsDecorations());
    };
    featureWatcher.onDidCreate(refresh);
    featureWatcher.onDidChange(refresh);
    featureWatcher.onDidDelete(refresh);

    const activeEditorSub = window.onDidChangeActiveTextEditor((editor) => {
        activePreviewKey = '';
        updateEditorExportDecorations(editor);
        if (!exportScenariosEnabled) {
            void closeExportPeekIfOpen();
        }
    });

    const selectionSub = window.onDidChangeTextEditorSelection(async (e) => {
        const version = previewSessionVersion;
        if (!exportScenariosEnabled || e.textEditor.document.languageId !== 'feature') {
            return;
        }
        const lineIndex = e.selections[0]?.active.line ?? -1;
        const found = findExportScenarioAtLine(e.textEditor.document, lineIndex);
        if (!found) {
            return;
        }
        const scenario = found.scenario;

        const previewKey = `${e.textEditor.document.uri.toString()}:${found.lineIndex}`;
        if (activePreviewKey === previewKey) {
            return;
        }
        activePreviewKey = previewKey;

        const sourceUri = Uri.file(scenario.sourcePath);
        const sourceLine = Math.max(0, scenario.sourceLine);
        if (version !== previewSessionVersion || !exportScenariosEnabled) {
            return;
        }

        await commands.executeCommand(
            'editor.action.peekLocations',
            e.textEditor.document.uri,
            new Position(found.lineIndex, 0),
            [new Location(sourceUri, new Range(sourceLine, 0, sourceLine, 0))],
            'peek'
        );
    });

    const hoverSub = languages.registerHoverProvider('feature', {
        provideHover(document, position): Hover | undefined {
            if (!exportScenariosEnabled) {
                return undefined;
            }
            const stepPart = getStepPart(document.lineAt(position.line).text);
            if (!stepPart) {
                return undefined;
            }
            const scenario = findExportScenarioByStepPart(stepPart);
            if (!scenario || !scenario.body.length) {
                return undefined;
            }

            const md = new MarkdownString();
            md.appendMarkdown(`**Export Scenario:** ${scenario.title}\n\n`);
            md.appendCodeblock(scenario.body.join('\n'), 'feature');
            md.isTrusted = false;
            return new Hover(md);
        },
    });

    const textChangeSub = workspace.onDidChangeTextDocument((e) => {
        if (window.activeTextEditor && e.document === window.activeTextEditor.document) {
            updateEditorExportDecorations(window.activeTextEditor);
        }
    });

    void rebuildExportScenariosMap().then(() => {
        updateVisibleEditorsDecorations();
    });

    context.subscriptions.push(
        toggleCommand,
        configSubscription,
        featureWatcher,
        activeEditorSub,
        selectionSub,
        hoverSub,
        textChangeSub,
        exportScenariosStatusBar,
        exportScenariosDecoration
    );

    context.subscriptions.push(...activateVALibrary(context));
}

export function deactivate(): Thenable<void> | undefined {
    if (!client) {
        return undefined;
    }
    return client.stop();
}
