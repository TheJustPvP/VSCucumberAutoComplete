import * as path from 'path';
import {
    commands,
    Disposable,
    Event,
    EventEmitter,
    ExtensionContext,
    QuickPickItem,
    Selection,
    ThemeIcon,
    TextEditorRevealType,
    TreeDataProvider,
    TreeItem,
    TreeItemCollapsibleState,
    TreeView,
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
    ИмяШага?: string;
    ОписаниеШага?: string;
    ПолныйТипШага?: string;
    Файл?: string;
    ИмяПроцедуры?: string;
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

class VALibraryProvider implements TreeDataProvider<LibraryNode> {
    private readonly actionNodes: ActionNode[] = [
        {
            type: 'action',
            label: 'Загрузить JSON',
            description: 'Импорт',
            command: 'cucumberautocomplete.vaLibrary.importJson',
            icon: 'cloud-download',
        },
        {
            type: 'action',
            label: 'Найти шаг',
            description: 'Поиск',
            command: 'cucumberautocomplete.vaLibrary.search',
            icon: 'search',
        },
        {
            type: 'action',
            label: 'Обновить',
            description: 'Refresh',
            command: 'cucumberautocomplete.vaLibrary.refresh',
            icon: 'refresh',
        },
    ];
    private rootNodes: LibraryNode[] = [];
    private flatSteps: FlatStep[] = [];
    private tree?: TreeView<LibraryNode>;
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

    async refresh() {
        const parsed = await this.readLibrary();
        const steps = this.normalizeSteps(parsed);
        this.flatSteps = this.buildFlatSteps(steps);
        this.rootNodes = this.buildTreeNodes(this.flatSteps);
        this.onDidChangeTreeDataEmitter.fire(undefined);
    }

    async searchAndReveal() {
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
            placeHolder: 'Найдите шаг в библиотеке VA',
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
            .map((s) => {
                const text = (s.text || s.ИмяШага || s.step || s.name || '').trim();
                if (!text) {
                    return undefined;
                }
                const rawPath = (s.path || s.section || s.ПолныйТипШага || '').trim();
                const path = rawPath
                    ? rawPath
                          .replace(/\s*\.\s*/g, '/')
                          .replace(/\\/g, '/')
                    : undefined;

                return {
                    text,
                    description: (s.description || s.ОписаниеШага || '').trim() || undefined,
                    path,
                    section: (s.section || '').trim() || undefined,
                    file: (s.file || s.Файл || '').trim() || undefined,
                    procedure: (s.procedure || s.ИмяПроцедуры || '').trim() || undefined,
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
    provider.setTree(tree);

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

