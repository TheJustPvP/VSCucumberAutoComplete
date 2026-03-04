import * as path from 'path';
import {
    commands,
    Disposable,
    Event,
    EventEmitter,
    ExtensionContext,
    QuickPickItem,
    Selection,
    TextEditorRevealType,
    TreeDataProvider,
    TreeItem,
    TreeItemCollapsibleState,
    Uri,
    ViewColumn,
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

type VaLibraryJson = {
    version?: string;
    generatedAt?: string;
    steps?: VaLibraryStep[];
} | VaLibraryStep[];

type LibraryNode = FolderNode | StepNode;

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

type FlatStep = {
    path: string;
    step: VaLibraryStep;
};

const LIBRARY_FILE_NAME = 'va-step-library.json';
const WORKSPACE_LIBRARY_RELATIVE = '.vscode/va-step-library.json';

class VALibraryProvider implements TreeDataProvider<LibraryNode> {
    private rootNodes: LibraryNode[] = [];
    private flatSteps: FlatStep[] = [];
    private readonly onDidChangeTreeDataEmitter = new EventEmitter<LibraryNode | undefined>();

    readonly onDidChangeTreeData: Event<LibraryNode | undefined> =
        this.onDidChangeTreeDataEmitter.event;

    getTreeItem(element: LibraryNode): TreeItem {
        if (element.type === 'folder') {
            const item = new TreeItem(element.label, TreeItemCollapsibleState.Collapsed);
            item.contextValue = 'vaLibraryFolder';
            return item;
        }

        const item = new TreeItem(element.step.text, TreeItemCollapsibleState.None);
        item.contextValue = 'vaLibraryStep';
        item.description = element.step.description || '';
        item.tooltip = [
            element.step.text,
            element.step.description || '',
            element.step.path || element.step.section || '',
            element.step.file ? `Файл: ${element.step.file}` : '',
            element.step.procedure ? `Процедура: ${element.step.procedure}` : '',
        ]
            .filter(Boolean)
            .join('\n');
        item.command = {
            title: 'Insert Step',
            command: 'cucumberautocomplete.vaLibrary.insertStep',
            arguments: [element.step.text],
        };
        return item;
    }

    getChildren(element?: LibraryNode): LibraryNode[] {
        if (!element) {
            return this.rootNodes;
        }
        if (element.type === 'folder') {
            return element.children;
        }
        return [];
    }

    async refresh() {
        const parsed = await this.readLibrary();
        const steps = this.normalizeSteps(parsed);
        this.flatSteps = this.buildFlatSteps(steps);
        this.rootNodes = this.buildTreeNodes(this.flatSteps);
        this.onDidChangeTreeDataEmitter.fire(undefined);
    }

    async searchAndInsert() {
        if (!this.flatSteps.length) {
            window.showInformationMessage('VA библиотека шагов пуста. Сначала импортируйте JSON.');
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
            placeHolder: 'Найдите шаг из VA библиотеки',
        });
        if (!selected) {
            return;
        }
        await this.insertStep(selected.step.text);
    }

    async insertStep(stepText: string) {
        const editor = window.activeTextEditor;
        if (!editor) {
            return;
        }
        await editor.edit((builder) => {
            const selection = editor.selection;
            builder.replace(selection, stepText);
        });
        const pos = editor.selection.active;
        editor.selection = new Selection(pos, pos);
        editor.revealRange(editor.selection, TextEditorRevealType.InCenterIfOutsideViewport);
    }

    async importFromJsonFile() {
        const selected = await window.showOpenDialog({
            canSelectMany: false,
            filters: { JSON: ['json'] },
            openLabel: 'Импортировать библиотеку шагов VA',
        });
        if (!selected?.length) {
            return;
        }

        const workspaceFolder = workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            window.showErrorMessage('Откройте папку проекта в VS Code перед импортом библиотеки VA.');
            return;
        }

        const targetDir = Uri.joinPath(workspaceFolder.uri, '.vscode');
        const targetFile = Uri.joinPath(workspaceFolder.uri, WORKSPACE_LIBRARY_RELATIVE);
        try {
            await workspace.fs.createDirectory(targetDir);
            const content = await workspace.fs.readFile(selected[0]);
            await workspace.fs.writeFile(targetFile, content);
            await this.refresh();
            window.showInformationMessage(`VA библиотека импортирована: ${targetFile.fsPath}`);
        } catch (error) {
            window.showErrorMessage(`Ошибка импорта VA библиотеки: ${String(error)}`);
        }
    }

    async openLibraryJson() {
        const workspaceFolder = workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            window.showErrorMessage('Откройте папку проекта в VS Code.');
            return;
        }
        const targetFile = Uri.joinPath(workspaceFolder.uri, WORKSPACE_LIBRARY_RELATIVE);
        try {
            const doc = await workspace.openTextDocument(targetFile);
            await window.showTextDocument(doc, { preview: false, viewColumn: ViewColumn.Active });
        } catch {
            window.showWarningMessage(
                `Файл библиотеки не найден: ${LIBRARY_FILE_NAME}. Выполните "Import VA JSON Library".`
            );
        }
    }

    private async readLibrary(): Promise<VaLibraryJson> {
        const workspaceFolder = workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return [];
        }
        const userLibrary = Uri.joinPath(workspaceFolder.uri, WORKSPACE_LIBRARY_RELATIVE);
        try {
            const bytes = await workspace.fs.readFile(userLibrary);
            return JSON.parse(Buffer.from(bytes).toString('utf8')) as VaLibraryJson;
        } catch {
            return [];
        }
    }

    private normalizeSteps(json: VaLibraryJson): VaLibraryStep[] {
        const arr = Array.isArray(json) ? json : json.steps || [];
        return arr
            .filter((s) => !!s && typeof s.text === 'string' && !!s.text.trim())
            .map((s) => ({
                text: s.text.trim(),
                description: s.description?.trim(),
                path: s.path?.trim(),
                section: s.section?.trim(),
                file: s.file?.trim(),
                procedure: s.procedure?.trim(),
            }));
    }

    private buildFlatSteps(steps: VaLibraryStep[]): FlatStep[] {
        return steps.map((step) => {
            const base = step.path || step.section || 'Без раздела';
            const normalizedPath = base
                .replace(/\\/g, '/')
                .split('/')
                .map((p) => p.trim())
                .filter(Boolean)
                .join('/');
            return {
                path: normalizedPath || 'Без раздела',
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
    const provider = new VALibraryProvider();
    const tree = window.createTreeView('cucumberautocomplete.vaLibrary', {
        treeDataProvider: provider,
        showCollapseAll: true,
    });

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
        async () => provider.searchAndInsert()
    );
    const insertStepCommand = commands.registerCommand(
        'cucumberautocomplete.vaLibrary.insertStep',
        async (stepText: string) => provider.insertStep(stepText)
    );

    const watcher = workspace.createFileSystemWatcher(`**/${LIBRARY_FILE_NAME}`);
    watcher.onDidCreate(() => void provider.refresh());
    watcher.onDidChange(() => void provider.refresh());
    watcher.onDidDelete(() => void provider.refresh());

    void provider.refresh();

    return [
        tree,
        refreshCommand,
        importCommand,
        openJsonCommand,
        searchCommand,
        insertStepCommand,
        watcher,
    ];
}

