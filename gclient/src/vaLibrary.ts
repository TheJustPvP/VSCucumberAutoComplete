import * as path from 'path';
import {
    CancellationToken,
    commands,
    Disposable,
    Event,
    EventEmitter,
    ExtensionContext,
    QuickPickItem,
    Selection,
    ThemeColor,
    ThemeIcon,
    TextDocumentContentProvider,
    TextEditorRevealType,
    TreeDataProvider,
    TreeItem,
    TreeItemCollapsibleState,
    TreeView,
    Uri,
    ViewColumn,
    languages,
    window,
    workspace,
} from 'vscode';

type VaLibraryStep = {
    text: string;
    description?: string;
    path?: string;
    section?: string;
    file?: string;
    procedure?: string;
};

type VaLibraryRawStep = {
    text?: string;
    description?: string;
    path?: string;
    section?: string;
    file?: string;
    procedure?: string;
    name?: string;
    step?: string;
    // Russian keys from 1C export
    'ИмяШага'?: string;
    'ОписаниеШага'?: string;
    'ПолныйТипШага'?: string;
    'Файл'?: string;
    'ИмяПроцедуры'?: string;
};

type VaLibraryJson = {
    version?: string;
    generatedAt?: string;
    steps?: VaLibraryRawStep[];
} | VaLibraryRawStep[];

type LibraryNode = FolderNode | StepNode | ActionNode;

type FolderNode = {
    type: 'folder';
    label: string;
    pathKey: string;
    children: LibraryNode[];
};

type StepNode = {
    type: 'step';
    step: VaLibraryStep;
};

type ActionNode = {
    type: 'action';
    label: string;
    description: string;
    command: string;
    icon: string;
};

type FlatStep = {
    path: string;
    step: VaLibraryStep;
};

const LIBRARY_FILE_NAME = 'va-step-library.json';
const WORKSPACE_LIBRARY_RELATIVE = '.vscode/va-step-library.json';
const STEP_DETAILS_SCHEME = 'va-library-step';
const RU_STEP_NAME = '\u0418\u043c\u044f\u0428\u0430\u0433\u0430';
const RU_STEP_DESC = '\u041e\u043f\u0438\u0441\u0430\u043d\u0438\u0435\u0428\u0430\u0433\u0430';
const RU_STEP_PATH = '\u041f\u043e\u043b\u043d\u044b\u0439\u0422\u0438\u043f\u0428\u0430\u0433\u0430';
const RU_STEP_FILE = '\u0424\u0430\u0439\u043b';
const RU_STEP_PROC = '\u0418\u043c\u044f\u041f\u0440\u043e\u0446\u0435\u0434\u0443\u0440\u044b';

class StepDetailsProvider implements TextDocumentContentProvider {
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
}

class VALibraryProvider implements TreeDataProvider<LibraryNode> {
    constructor(
        private readonly bundledLibraryUri?: Uri,
        private readonly userLibraryUri?: Uri
    ) {}

    private readonly actionNodes: ActionNode[] = [
        {
            type: 'action',
            label: '\u0417\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044c JSON',
            description: '\u0418\u043c\u043f\u043e\u0440\u0442',
            command: 'cucumberautocomplete.vaLibrary.importJson',
            icon: 'cloud-download',
        },
        {
            type: 'action',
            label: '\u041d\u0430\u0439\u0442\u0438 \u0448\u0430\u0433',
            description: '\u041f\u043e\u0438\u0441\u043a',
            command: 'cucumberautocomplete.vaLibrary.search',
            icon: 'search',
        },
        {
            type: 'action',
            label: '\u041e\u0431\u043d\u043e\u0432\u0438\u0442\u044c',
            description: 'Refresh',
            command: 'cucumberautocomplete.vaLibrary.refresh',
            icon: 'refresh',
        },
    ];
    private rootNodes: LibraryNode[] = [];
    private flatSteps: FlatStep[] = [];
    private tree?: TreeView<LibraryNode>;
    private detailsProvider?: StepDetailsProvider;
    private readonly onDidChangeTreeDataEmitter = new EventEmitter<LibraryNode | undefined>();

    readonly onDidChangeTreeData: Event<LibraryNode | undefined> =
        this.onDidChangeTreeDataEmitter.event;

    getTreeItem(element: LibraryNode): TreeItem {
        if (element.type === 'action') {
            const item = new TreeItem(element.label, TreeItemCollapsibleState.None);
            item.contextValue = 'vaLibraryAction';
            item.description = element.description;
            item.iconPath = new ThemeIcon(element.icon);
            item.command = {
                title: element.label,
                command: element.command,
            };
            return item;
        }

        if (element.type === 'folder') {
            const item = new TreeItem(element.label, TreeItemCollapsibleState.Collapsed);
            item.contextValue = 'vaLibraryFolder';
            item.iconPath = new ThemeIcon('folder');
            return item;
        }

        const item = new TreeItem(element.step.text, TreeItemCollapsibleState.None);
        item.contextValue = 'vaLibraryStep';
        item.iconPath = this.getStepColorIcon(element.step.text);
        item.description = element.step.description || '';
        item.tooltip = [
            element.step.text,
            element.step.description || '',
            element.step.path || element.step.section || '',
            element.step.file ? `\u0424\u0430\u0439\u043b: ${element.step.file}` : '',
            element.step.procedure ? `\u041f\u0440\u043e\u0446\u0435\u0434\u0443\u0440\u0430: ${element.step.procedure}` : '',
        ]
            .filter(Boolean)
            .join('\n');
        item.command = {
            title: 'Insert Step',
            command: 'cucumberautocomplete.vaLibrary.insertStep',
            arguments: [element],
        };
        return item;
    }

    getChildren(element?: LibraryNode): LibraryNode[] {
        if (!element) {
            return [...this.actionNodes, ...this.rootNodes];
        }
        if (element.type === 'folder') {
            return element.children;
        }
        return [];
    }

    getParent(element: LibraryNode): LibraryNode | undefined {
        if (element.type === 'action') {
            return undefined;
        }
        const findParent = (nodes: LibraryNode[], target: LibraryNode): LibraryNode | undefined => {
            for (const node of nodes) {
                if (node.type !== 'folder') {
                    continue;
                }
                if (node.children.includes(target)) {
                    return node;
                }
                const found = findParent(node.children, target);
                if (found) {
                    return found;
                }
            }
            return undefined;
        };
        return findParent(this.rootNodes, element);
    }

    setTree(tree: TreeView<LibraryNode>) {
        this.tree = tree;
    }

    setDetailsProvider(provider: StepDetailsProvider) {
        this.detailsProvider = provider;
    }

    async refresh() {
        const parsed = await this.readLibrary();
        const steps = this.normalizeSteps(parsed);
        this.flatSteps = this.buildFlatSteps(steps);
        this.rootNodes = this.buildTreeNodes(this.flatSteps);
        this.onDidChangeTreeDataEmitter.fire(undefined);
    }

    async searchAndReveal() {
        if (!this.flatSteps.length) {
            window.showInformationMessage('VA \u0431\u0438\u0431\u043b\u0438\u043e\u0442\u0435\u043a\u0430 \u0448\u0430\u0433\u043e\u0432 \u043f\u0443\u0441\u0442\u0430. \u0421\u043d\u0430\u0447\u0430\u043b\u0430 \u0438\u043c\u043f\u043e\u0440\u0442\u0438\u0440\u0443\u0439\u0442\u0435 JSON.');
            return;
        }
        const items: (QuickPickItem & { step: VaLibraryStep })[] = this.flatSteps.map((s) => ({
            label: s.step.text,
            description: s.path,
            detail: s.step.description || '',
            step: s.step,
        }));

        const selected = await window.showQuickPick(items, {
            matchOnDescription: true,
            matchOnDetail: true,
            placeHolder: '\u041d\u0430\u0439\u0434\u0438\u0442\u0435 \u0448\u0430\u0433 \u0432 \u0431\u0438\u0431\u043b\u0438\u043e\u0442\u0435\u043a\u0435 VA',
        });
        if (!selected) {
            return;
        }
        const target = this.findStepNode(selected.step, this.rootNodes);
        if (!target || !this.tree) {
            return;
        }
        await this.tree.reveal(target, {
            focus: true,
            select: true,
            expand: 10,
        });
    }

    async insertStep(target: unknown) {
        const step = this.resolveStep(target);
        const stepText = step?.text;
        if (!stepText) {
            return;
        }
        const editor = window.activeTextEditor;
        if (!editor) {
            return;
        }
        const finalText = this.appendTableFromDescription(stepText, step.description);
        await editor.edit((builder) => {
            const selection = editor.selection;
            builder.replace(selection, finalText);
        });
        const pos = editor.selection.active;
        editor.selection = new Selection(pos, pos);
        editor.revealRange(editor.selection, TextEditorRevealType.InCenterIfOutsideViewport);
    }

    async showStepDetails(target: unknown) {
        const resolved = this.resolveStep(target);
        if (resolved && this.detailsProvider) {
            const wrappedDescription = this.wrapDescriptionForPreview(resolved.description);
            const body = [
                resolved.text,
                '',
                ...(wrappedDescription ? wrappedDescription.split('\n') : []),
            ].join('\n');
            const key = encodeURIComponent(resolved.text.slice(0, 80));
            const uri = Uri.parse(`${STEP_DETAILS_SCHEME}://details/${key}.feature`);
            this.detailsProvider.setContent(uri, body);
            const doc = await workspace.openTextDocument(uri);
            if (doc.languageId !== 'feature') {
                await languages.setTextDocumentLanguage(doc, 'feature');
            }
            await window.showTextDocument(doc, { preview: false, viewColumn: ViewColumn.Beside });
            return;
        }
        return;
    }

    resolveStepText(target: unknown): string | undefined {
        if (typeof target === 'string') {
            return target;
        }
        if (target && typeof target === 'object') {
            const node = target as { type?: string; step?: { text?: string }; text?: string };
            if (node.type === 'step' && typeof node.step?.text === 'string') {
                return node.step.text;
            }
            if (typeof node.text === 'string') {
                return node.text;
            }
        }
        return undefined;
    }

    private wrapDescriptionForPreview(description?: string, width = 100) {
        if (!description || !description.trim()) {
            return '';
        }
        const lines = description.replace(/\r/g, '').split('\n');
        const wrappedLines: string[] = [];

        const pushWrapped = (line: string) => {
            const words = line.trim().split(/\s+/).filter(Boolean);
            if (!words.length) {
                wrappedLines.push('');
                return;
            }
            let current = words[0];
            for (let i = 1; i < words.length; i++) {
                const next = words[i];
                if ((current + ' ' + next).length > width) {
                    wrappedLines.push(current);
                    current = next;
                } else {
                    current += ' ' + next;
                }
            }
            wrappedLines.push(current);
        };

        for (const rawLine of lines) {
            const line = rawLine.replace(/\t/g, '    ');
            const trimmed = line.trim();
            if (!trimmed) {
                wrappedLines.push('');
                continue;
            }

            const isFence = trimmed.startsWith('```');
            const isTable = trimmed.includes('|');
            const isBullet = /^[-*]\s+/.test(trimmed);
            const isHeader = /^#+\s+/.test(trimmed);
            if (isFence || isTable || isBullet || isHeader) {
                wrappedLines.push(line);
                continue;
            }

            pushWrapped(line);
        }

        return wrappedLines.join('\n');
    }

    resolveStep(target: unknown): VaLibraryStep | undefined {
        if (typeof target === 'string') {
            return this.flatSteps.find((s) => s.step.text === target)?.step || { text: target };
        }
        if (target && typeof target === 'object') {
            const node = target as { type?: string; step?: VaLibraryStep; text?: string };
            if (node.type === 'step' && node.step?.text) {
                return node.step;
            }
            if (typeof node.text === 'string') {
                return this.flatSteps.find((s) => s.step.text === node.text)?.step || { text: node.text };
            }
        }
        return undefined;
    }

    private appendTableFromDescription(insertText: string, description?: string) {
        const table = this.extractTableTemplate(description) || this.getFallbackTable(insertText);
        if (!table) {
            return insertText;
        }
        if (insertText.includes('\n|')) {
            return insertText;
        }
        return `${insertText}\n${table}`;
    }

    private extractTableTemplate(description?: string) {
        if (!description || !description.trim()) {
            return '';
        }
        const lines = description.replace(/\r/g, '').split('\n');
        const rows: string[] = [];
        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (line.startsWith('```')) {
                continue;
            }
            const pipeCount = (line.match(/\|/g) || []).length;
            if (pipeCount >= 2) {
                let row = line;
                if (!row.startsWith('|')) {
                    row = `| ${row}`;
                }
                if (!row.endsWith('|')) {
                    row = `${row} |`;
                }
                rows.push(row);
                continue;
            }
            if (rows.length) {
                break;
            }
        }
        return rows.length >= 2 ? rows.join('\n') : '';
    }

    private getFallbackTable(stepText: string) {
        const normalized = stepText.toLowerCase();
        const hasTableContext = /\u0432 \u0442\u0430\u0431\u043b\u0438\u0446/.test(normalized) || /\u0437\u0430\u043f\u043e\u043b\u043d\u044f\u044e \u0442\u0430\u0431\u043b\u0438\u0446/.test(normalized);
        const hasRowIntent = /\u043f\u0435\u0440\u0435\u0445\u043e\u0436\u0443 \u043a \u0441\u0442\u0440\u043e\u043a\u0435/.test(normalized) || /(^|\s)\u0434\u0430\u043d\u043d\u044b\u043c\u0438(\s|$)/.test(normalized);
        const hasParamIntent = /\u0441 \u043f\u0430\u0440\u0430\u043c\u0435\u0442\u0440/.test(normalized) && /:\s*$/.test(normalized);
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

    async importFromJsonFile() {
        const selected = await window.showOpenDialog({
            canSelectMany: false,
            filters: { JSON: ['json'] },
            openLabel: '\u0418\u043c\u043f\u043e\u0440\u0442\u0438\u0440\u043e\u0432\u0430\u0442\u044c \u0431\u0438\u0431\u043b\u0438\u043e\u0442\u0435\u043a\u0443 \u0448\u0430\u0433\u043e\u0432 VA',
        });
        if (!selected?.length) {
            return;
        }

        try {
            const content = await workspace.fs.readFile(selected[0]);
            const workspaceFolder = workspace.workspaceFolders?.[0];
            if (workspaceFolder) {
                const targetDir = Uri.joinPath(workspaceFolder.uri, '.vscode');
                const targetFile = Uri.joinPath(workspaceFolder.uri, WORKSPACE_LIBRARY_RELATIVE);
                await workspace.fs.createDirectory(targetDir);
                await workspace.fs.writeFile(targetFile, content);
            }
            if (this.userLibraryUri) {
                const userDir = Uri.file(path.dirname(this.userLibraryUri.fsPath));
                await workspace.fs.createDirectory(userDir);
                await workspace.fs.writeFile(this.userLibraryUri, content);
            }
            await this.refresh();
            window.showInformationMessage('\u0411\u0438\u0431\u043b\u0438\u043e\u0442\u0435\u043a\u0430 VA \u0438\u043c\u043f\u043e\u0440\u0442\u0438\u0440\u043e\u0432\u0430\u043d\u0430.');
        } catch (error) {
            window.showErrorMessage(`\u041e\u0448\u0438\u0431\u043a\u0430 \u0438\u043c\u043f\u043e\u0440\u0442\u0430 VA \u0431\u0438\u0431\u043b\u0438\u043e\u0442\u0435\u043a\u0438: ${String(error)}`);
        }
    }

    async openLibraryJson() {
        const workspaceFolder = workspace.workspaceFolders?.[0];
        const targetFile = workspaceFolder
            ? Uri.joinPath(workspaceFolder.uri, WORKSPACE_LIBRARY_RELATIVE)
            : undefined;
        try {
            const uriToOpen = targetFile || this.userLibraryUri || this.bundledLibraryUri;
            if (!uriToOpen) {
                window.showErrorMessage('\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u043e\u0442\u043a\u0440\u044b\u0442\u044c VA JSON \u0431\u0438\u0431\u043b\u0438\u043e\u0442\u0435\u043a\u0443.');
                return;
            }
            const doc = await workspace.openTextDocument(uriToOpen);
            await window.showTextDocument(doc, { preview: false, viewColumn: ViewColumn.Active });
        } catch {
            const fallback = this.userLibraryUri || this.bundledLibraryUri;
            if (fallback) {
                const fallbackDoc = await workspace.openTextDocument(fallback);
                await window.showTextDocument(fallbackDoc, {
                    preview: false,
                    viewColumn: ViewColumn.Active,
                });
                return;
            }
            window.showWarningMessage(`\u0424\u0430\u0439\u043b \u0431\u0438\u0431\u043b\u0438\u043e\u0442\u0435\u043a\u0438 \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d: ${LIBRARY_FILE_NAME}.`);
        }
    }

    private async readLibrary(): Promise<VaLibraryJson> {
        const workspaceFolder = workspace.workspaceFolders?.[0];
        if (workspaceFolder) {
            const userLibrary = Uri.joinPath(workspaceFolder.uri, WORKSPACE_LIBRARY_RELATIVE);
            try {
                const bytes = await workspace.fs.readFile(userLibrary);
                return JSON.parse(Buffer.from(bytes).toString('utf8')) as VaLibraryJson;
            } catch {
                // Continue with user/bundled fallback.
            }
        }

        if (this.userLibraryUri) {
            try {
                const bytes = await workspace.fs.readFile(this.userLibraryUri);
                return JSON.parse(Buffer.from(bytes).toString('utf8')) as VaLibraryJson;
            } catch {
                // Fallback to bundled JSON below.
            }
        }

        if (!this.bundledLibraryUri) {
            return [];
        }

        try {
            const bytes = await workspace.fs.readFile(this.bundledLibraryUri);
            return JSON.parse(Buffer.from(bytes).toString('utf8')) as VaLibraryJson;
        } catch {
            return [];
        }
    }

    private normalizeSteps(json: VaLibraryJson): VaLibraryStep[] {
        const arr = Array.isArray(json) ? json : json.steps || [];
        return arr
            .map((s) => {
                const text = (s.text || s[RU_STEP_NAME] || s.step || s.name || '').trim();
                if (!text) {
                    return undefined;
                }
                const rawPath = (s.path || s.section || s[RU_STEP_PATH] || '').trim();
                const path = rawPath
                    ? rawPath
                          .replace(/\s*\.\s*/g, '/')
                          .replace(/\\/g, '/')
                    : undefined;

                return {
                    text,
                    description: (s.description || s[RU_STEP_DESC] || '').trim() || undefined,
                    path,
                    section: (s.section || '').trim() || undefined,
                    file: (s.file || s[RU_STEP_FILE] || '').trim() || undefined,
                    procedure: (s.procedure || s[RU_STEP_PROC] || '').trim() || undefined,
                } as VaLibraryStep;
            })
            .filter((s): s is VaLibraryStep => !!s);
    }

    private findStepNode(step: VaLibraryStep, nodes: LibraryNode[]): StepNode | undefined {
        for (const node of nodes) {
            if (node.type === 'step' && node.step === step) {
                return node;
            }
            if (node.type === 'folder') {
                const found = this.findStepNode(step, node.children);
                if (found) {
                    return found;
                }
            }
        }
        return undefined;
    }

    private getStepColorIcon(stepText: string) {
        const text = stepText.trim().toLowerCase();
        if (text.startsWith('\u0434\u0430\u043d\u043e ') || text.startsWith('given ')) {
            return new ThemeIcon('circle-filled', new ThemeColor('charts.green'));
        }
        if (text.startsWith('\u043a\u043e\u0433\u0434\u0430 ') || text.startsWith('when ')) {
            return new ThemeIcon('circle-filled', new ThemeColor('charts.blue'));
        }
        if (text.startsWith('\u0442\u043e\u0433\u0434\u0430 ') || text.startsWith('then ')) {
            return new ThemeIcon('circle-filled', new ThemeColor('charts.orange'));
        }
        if (text.startsWith('\u0438 ') || text.startsWith('and ')) {
            return new ThemeIcon('circle-filled', new ThemeColor('charts.yellow'));
        }
        if (text.startsWith('\u043d\u043e ') || text.startsWith('but ')) {
            return new ThemeIcon('circle-filled', new ThemeColor('charts.red'));
        }
        return new ThemeIcon('circle-filled', new ThemeColor('disabledForeground'));
    }

    private buildFlatSteps(steps: VaLibraryStep[]): FlatStep[] {
        return steps.map((step) => {
            const base = step.path || step.section || '\u0411\u0435\u0437 \u0440\u0430\u0437\u0434\u0435\u043b\u0430';
            const normalizedPath = base
                .replace(/\\/g, '/')
                .split('/')
                .map((p) => p.trim())
                .filter(Boolean)
                .join('/');
            return {
                path: normalizedPath || '\u0411\u0435\u0437 \u0440\u0430\u0437\u0434\u0435\u043b\u0430',
                step,
            };
        });
    }

    private buildTreeNodes(flat: FlatStep[]): LibraryNode[] {
        const rootMap = new Map<string, FolderNode>();

        const ensureFolder = (segments: string[]) => {
            let currentChildrenMap = rootMap;
            let currentNode: FolderNode | undefined;
            let keyBuilder = '';
            segments.forEach((segment) => {
                keyBuilder = keyBuilder ? `${keyBuilder}/${segment}` : segment;
                const existing = currentChildrenMap.get(keyBuilder);
                if (existing) {
                    currentNode = existing;
                    currentChildrenMap = this.folderChildrenToMap(existing.children);
                    return;
                }
                const created: FolderNode = {
                    type: 'folder',
                    label: segment,
                    pathKey: keyBuilder,
                    children: [],
                };
                if (currentNode) {
                    currentNode.children.push(created);
                } else {
                    rootMap.set(keyBuilder, created);
                }
                currentNode = created;
                currentChildrenMap = this.folderChildrenToMap(created.children);
            });
            return currentNode;
        };

        flat.forEach(({ path: p, step }) => {
            const segments = p.split('/').filter(Boolean);
            const folder = ensureFolder(segments);
            if (!folder) {
                return;
            }
            folder.children.push({ type: 'step', step });
        });

        const roots = Array.from(rootMap.values()).filter((n) => !n.pathKey.includes('/'));
        return roots.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
    }

    private folderChildrenToMap(children: LibraryNode[]): Map<string, FolderNode> {
        const map = new Map<string, FolderNode>();
        children
            .filter((c): c is FolderNode => c.type === 'folder')
            .forEach((f) => map.set(f.pathKey, f));
        return map;
    }
}

export function activateVALibrary(context: ExtensionContext): Disposable[] {
    const provider = new VALibraryProvider(
        Uri.joinPath(context.extensionUri, 'resources', 'default-va-step-library.json'),
        Uri.joinPath(context.globalStorageUri, 'va-step-library.json')
    );
    const detailsProvider = new StepDetailsProvider();
    const tree = window.createTreeView('cucumberautocomplete.vaLibrary', {
        treeDataProvider: provider,
        showCollapseAll: true,
    });
    provider.setTree(tree);
    provider.setDetailsProvider(detailsProvider);

    const refreshCommand = commands.registerCommand(
        'cucumberautocomplete.vaLibrary.refresh',
        async () => provider.refresh()
    );
    const importCommand = commands.registerCommand(
        'cucumberautocomplete.vaLibrary.importJson',
        async () => provider.importFromJsonFile()
    );
    const openJsonCommand = commands.registerCommand(
        'cucumberautocomplete.vaLibrary.openJson',
        async () => provider.openLibraryJson()
    );
    const searchCommand = commands.registerCommand(
        'cucumberautocomplete.vaLibrary.search',
        async () => provider.searchAndReveal()
    );
    const insertStepCommand = commands.registerCommand(
        'cucumberautocomplete.vaLibrary.insertStep',
        async (target: unknown) => {
            await provider.insertStep(target);
        }
    );
    const showStepDetailsCommand = commands.registerCommand(
        'cucumberautocomplete.vaLibrary.showStepDetails',
        async (target: unknown) => provider.showStepDetails(target)
    );

    const watcher = workspace.createFileSystemWatcher(`**/${LIBRARY_FILE_NAME}`);
    watcher.onDidCreate(() => void provider.refresh());
    watcher.onDidChange(() => void provider.refresh());
    watcher.onDidDelete(() => void provider.refresh());

    void provider.refresh();

    return [
        workspace.registerTextDocumentContentProvider(STEP_DETAILS_SCHEME, detailsProvider),
        tree,
        refreshCommand,
        importCommand,
        openJsonCommand,
        searchCommand,
        insertStepCommand,
        showStepDetailsCommand,
        watcher,
    ];
}


