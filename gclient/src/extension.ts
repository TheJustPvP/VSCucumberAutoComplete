import * as path from 'path';
import { TextDecoder } from 'util';

import {
    workspace,
    ExtensionContext,
    window,
    commands,
    ConfigurationTarget,
    Uri,
    EventEmitter,
    TextDocumentContentProvider,
    CancellationToken,
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

type ExportScenario = {
    title: string;
    body: string[];
};

let client: LanguageClient;
let exportScenariosStatusBar: ReturnType<typeof window.createStatusBarItem>;
let exportScenariosDecoration: ReturnType<typeof window.createTextEditorDecorationType>;
const exportScenariosMap = new Map<string, ExportScenario>();
const decoder = new TextDecoder('utf-8');
let activePreviewKey = '';
const MAX_PREVIEW_LINES = 6;

class ExportPreviewProvider implements TextDocumentContentProvider {
    private readonly onDidChangeEmitter = new EventEmitter<Uri>();
    private readonly content = new Map<string, string>();

    readonly onDidChange = this.onDidChangeEmitter.event;

    provideTextDocumentContent(uri: Uri, _token: CancellationToken): string {
        return this.content.get(uri.toString()) || '';
    }

    setContent(uri: Uri, text: string) {
        this.content.set(uri.toString(), text);
        this.onDidChangeEmitter.fire(uri);
    }

    getContent(uri: Uri): string {
        return this.content.get(uri.toString()) || '';
    }
}

function getExportScenariosEnabled() {
    return workspace
        .getConfiguration('cucumberautocomplete')
        .get<boolean>('includeExportScenarios', false);
}

function updateExportScenariosStatusBar() {
    const enabled = getExportScenariosEnabled();
    exportScenariosStatusBar.text = enabled
        ? '$(check) Export Scenarios: On'
        : '$(circle-slash) Export Scenarios: Off';
    exportScenariosStatusBar.tooltip = 'Toggle export scenarios support';
}

function normalizeText(text: string) {
    return text.replace(/\s+/g, ' ').trim().toLowerCase();
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
    if (!getExportScenariosEnabled()) {
        return;
    }

    const files = await workspace.findFiles('**/*.feature', '**/{node_modules,.git}/**');
    for (const uri of files) {
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

            const key = normalizeText(scenarioTitle);
            if (!exportScenariosMap.has(key)) {
                exportScenariosMap.set(key, { title: scenarioTitle, body });
            }
        }
    }
}

function updateEditorExportDecorations(editor?: TextEditor) {
    const target = editor || window.activeTextEditor;
    if (!target || target.document.languageId !== 'feature') {
        return;
    }

    if (!getExportScenariosEnabled()) {
        target.setDecorations(exportScenariosDecoration, []);
        return;
    }

    const ranges: Range[] = [];
    for (let i = 0; i < target.document.lineCount; i++) {
        const stepPart = getStepPart(target.document.lineAt(i).text);
        if (!stepPart) {
            continue;
        }
        if (exportScenariosMap.has(normalizeText(stepPart))) {
            const line = target.document.lineAt(i);
            ranges.push(new Range(i, 0, i, line.text.length));
        }
    }
    target.setDecorations(exportScenariosDecoration, ranges);
}

function buildPreviewBody(body: string[]): string {
    if (body.length <= MAX_PREVIEW_LINES) {
        return body.join('\n');
    }
    const visible = body.slice(0, MAX_PREVIEW_LINES);
    visible.push(`... (${body.length - MAX_PREVIEW_LINES} more lines)`);
    return visible.join('\n');
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

    const scenario = exportScenariosMap.get(normalizeText(stepPart));
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
    const serverModule = context.asAbsolutePath(path.join('gserver', 'out', 'server.js'));

    const serverOptions: ServerOptions = {
        run: { module: serverModule, transport: TransportKind.ipc },
        debug: { module: serverModule, transport: TransportKind.ipc },
    };

    const clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: 'file', language: 'feature' }],
        synchronize: {
            fileEvents: workspace.createFileSystemWatcher('**/.clientrc'),
        },
    };

    client = new LanguageClient(
        'cucumberautocomplete-client',
        'Cucumber auto complete plugin',
        serverOptions,
        clientOptions
    );
    client.start();

    const exportPreviewProvider = new ExportPreviewProvider();
    const providerSub = workspace.registerTextDocumentContentProvider(
        'va-export-preview',
        exportPreviewProvider
    );

    exportScenariosDecoration = window.createTextEditorDecorationType({
        gutterIconPath: context.asAbsolutePath(path.join('img', 'export-step.svg')),
        gutterIconSize: 'contain',
        isWholeLine: true,
    });

    exportScenariosStatusBar = window.createStatusBarItem(1);
    exportScenariosStatusBar.command = 'cucumberautocomplete.toggleExportScenarios';
    updateExportScenariosStatusBar();
    exportScenariosStatusBar.show();

    const toggleCommand = commands.registerCommand(
        'cucumberautocomplete.toggleExportScenarios',
        async () => {
            const current = getExportScenariosEnabled();
            await workspace
                .getConfiguration('cucumberautocomplete')
                .update('includeExportScenarios', !current, ConfigurationTarget.Workspace);
            updateExportScenariosStatusBar();
            await rebuildExportScenariosMap();
            updateEditorExportDecorations();
            if (!getExportScenariosEnabled()) {
                activePreviewKey = '';
                await commands.executeCommand('closeReferenceSearch');
            } else {
                await showPreviewForActiveEditor();
            }
        }
    );

    const configSubscription = workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration('cucumberautocomplete.includeExportScenarios')) {
            return;
        }
        updateExportScenariosStatusBar();
        void rebuildExportScenariosMap().then(() => updateEditorExportDecorations());
    });

    const featureWatcher = workspace.createFileSystemWatcher('**/*.feature');
    const refresh = () => {
        if (!getExportScenariosEnabled()) {
            return;
        }
        void rebuildExportScenariosMap().then(() => updateEditorExportDecorations());
    };
    featureWatcher.onDidCreate(refresh);
    featureWatcher.onDidChange(refresh);
    featureWatcher.onDidDelete(refresh);

    const showPreviewForActiveEditor = async (editor?: TextEditor) => {
        const target = editor || window.activeTextEditor;
        if (!target || target.document.languageId !== 'feature' || !getExportScenariosEnabled()) {
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
        if (activePreviewKey === previewKey) {
            return;
        }
        activePreviewKey = previewKey;

        const previewUri = Uri.parse(
            `va-export-preview://preview/${encodeURIComponent(found.scenario.title)}.feature`
        );
        exportPreviewProvider.setContent(previewUri, buildPreviewBody(found.scenario.body));

        await commands.executeCommand(
            'editor.action.peekLocations',
            target.document.uri,
            new Position(found.lineIndex, 0),
            [new Location(previewUri, new Range(0, 0, 0, 0))],
            'peek'
        );
    };

    const activeEditorSub = window.onDidChangeActiveTextEditor((editor) => {
        updateEditorExportDecorations(editor);
        void showPreviewForActiveEditor(editor);
    });

    const selectionSub = window.onDidChangeTextEditorSelection(async (e) => {
        if (!getExportScenariosEnabled() || e.textEditor.document.languageId !== 'feature') {
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

        const previewText = buildPreviewBody(scenario.body);

        const previewUri = Uri.parse(
            `va-export-preview://preview/${encodeURIComponent(scenario.title)}.feature`
        );
        exportPreviewProvider.setContent(previewUri, previewText);

        await commands.executeCommand(
            'editor.action.peekLocations',
            e.textEditor.document.uri,
            new Position(found.lineIndex, 0),
            [new Location(previewUri, new Range(0, 0, 0, 0))],
            'peek'
        );
    });

    const hoverSub = languages.registerHoverProvider('feature', {
        provideHover(document, position): Hover | undefined {
            if (!getExportScenariosEnabled()) {
                return undefined;
            }
            const stepPart = getStepPart(document.lineAt(position.line).text);
            if (!stepPart) {
                return undefined;
            }
            const scenario = exportScenariosMap.get(normalizeText(stepPart));
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
        if (e.document.uri.scheme === 'va-export-preview') {
            const saved = exportPreviewProvider.getContent(e.document.uri);
            if (saved && e.document.getText() !== saved) {
                exportPreviewProvider.setContent(e.document.uri, saved);
            }
            return;
        }
        if (window.activeTextEditor && e.document === window.activeTextEditor.document) {
            updateEditorExportDecorations(window.activeTextEditor);
        }
    });

    void rebuildExportScenariosMap().then(() => {
        updateEditorExportDecorations();
        void showPreviewForActiveEditor();
    });

    context.subscriptions.push(
        providerSub,
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
}

export function deactivate(): Thenable<void> | undefined {
    if (!client) {
        return undefined;
    }
    return client.stop();
}
