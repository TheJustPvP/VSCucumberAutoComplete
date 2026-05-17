import * as vscode from 'vscode';
import { GherkinTable, GherkinTableEditorMessage } from './types';

function getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let nonce = '';
    for (let i = 0; i < 32; i++) {
        nonce += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return nonce;
}

export function openGherkinTableWebview(
    _context: vscode.ExtensionContext,
    table: GherkinTable
): Promise<{ rows: string[][] } | undefined> {
    return new Promise((resolve) => {
        const panel = vscode.window.createWebviewPanel(
            'cucumberautocompletevaedition.gherkinTableEditor',
            'Редактор таблиц Gherkin',
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
            }
        );

        const nonce = getNonce();
        panel.webview.html = renderHtml(panel.webview, nonce, table);

        let resolved = false;
        const finish = (value: { rows: string[][] } | undefined) => {
            if (resolved) {
                return;
            }
            resolved = true;
            resolve(value);
            panel.dispose();
        };

        panel.webview.onDidReceiveMessage((message: GherkinTableEditorMessage) => {
            if (message.type === 'ok') {
                finish({ rows: message.rows });
            } else if (message.type === 'cancel') {
                finish(undefined);
            }
        });

        panel.onDidDispose(() => finish(undefined));
    });
}

function renderHtml(
    webview: vscode.Webview,
    nonce: string,
    table: GherkinTable
): string {
    const csp = [
        `default-src 'none'`,
        `style-src ${webview.cspSource} 'unsafe-inline'`,
        `script-src 'nonce-${nonce}'`,
        `font-src ${webview.cspSource}`,
    ].join('; ');

    const initialPayload = JSON.stringify(table.rows);

    return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<title>Редактор таблиц Gherkin</title>
<style>
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 12px;
    margin: 0;
  }
  .toolbar {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 10px;
  }
  button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    padding: 6px 10px;
    cursor: pointer;
    font-family: inherit;
    font-size: var(--vscode-font-size);
  }
  button:hover:not(:disabled) {
    background: var(--vscode-button-hoverBackground);
  }
  button.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  button.secondary:hover:not(:disabled) {
    background: var(--vscode-button-secondaryHoverBackground);
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  table {
    border-collapse: collapse;
    width: 100%;
  }
  th, td {
    border: 1px solid var(--vscode-panel-border);
    padding: 0;
    vertical-align: top;
  }
  th {
    background: var(--vscode-editorWidget-background);
    font-weight: 600;
    padding: 4px 6px;
  }
  th.row-controls, td.row-controls {
    width: 80px;
    text-align: center;
    padding: 2px;
    background: var(--vscode-editorWidget-background);
  }
  th .col-header {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  th .col-actions {
    display: flex;
    gap: 2px;
    justify-content: center;
  }
  th .col-actions button {
    padding: 2px 6px;
    font-size: 0.85em;
  }
  th .col-visible-label {
    display: flex;
    align-items: center;
    gap: 4px;
    font-weight: normal;
    font-size: 0.85em;
  }
  td input {
    border: none;
    outline: none;
    background: transparent;
    color: inherit;
    width: 100%;
    box-sizing: border-box;
    padding: 4px 6px;
    font-family: var(--vscode-editor-font-family);
    font-size: var(--vscode-editor-font-size);
  }
  td input:focus {
    background: var(--vscode-input-background);
    outline: 1px solid var(--vscode-focusBorder);
  }
  tr.hidden-col-col {
    opacity: 0.5;
  }
  .footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 14px;
  }
  .row-controls button {
    padding: 2px 6px;
    font-size: 0.85em;
  }
  .table-wrap {
    overflow: auto;
    max-height: calc(100vh - 160px);
    border: 1px solid var(--vscode-panel-border);
  }
</style>
</head>
<body>
<div class="toolbar">
  <button id="add-row">+ Строка</button>
  <button id="add-col">+ Колонка</button>
  <button id="show-all" class="secondary">Показать все колонки</button>
  <button id="hide-all" class="secondary">Скрыть все колонки</button>
</div>
<div class="table-wrap">
  <table id="grid"></table>
</div>
<div class="footer">
  <button id="cancel" class="secondary">Отмена</button>
  <button id="ok">OK</button>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();

  function stripQuotes(v) {
    if (v.length >= 2 && v[0] === "'" && v[v.length - 1] === "'") return v.slice(1, -1);
    return v;
  }
  function wrapQuotes(v) {
    if (!v) return '';
    if (v.length >= 2 && v[0] === "'" && v[v.length - 1] === "'") return v;
    return "'" + v + "'";
  }

  /** @type {string[][]} */
  let rows = ${initialPayload}.map(function(row) { return row.map(stripQuotes); });
  /** @type {boolean[]} */
  let visible = (rows[0] || []).map(() => true);

  function ensureRectangular() {
    const maxLen = rows.reduce((m, r) => Math.max(m, r.length), 0);
    rows = rows.map((r) => {
      const copy = r.slice();
      while (copy.length < maxLen) copy.push('');
      return copy;
    });
    while (visible.length < maxLen) visible.push(true);
    while (visible.length > maxLen) visible.pop();
  }

  function render() {
    ensureRectangular();
    const grid = document.getElementById('grid');
    grid.innerHTML = '';

    const colCount = rows[0] ? rows[0].length : 0;

    const thead = document.createElement('thead');
    const headTr = document.createElement('tr');

    const cornerTh = document.createElement('th');
    cornerTh.className = 'row-controls';
    cornerTh.textContent = '#';
    headTr.appendChild(cornerTh);

    for (let c = 0; c < colCount; c++) {
      const th = document.createElement('th');
      const wrap = document.createElement('div');
      wrap.className = 'col-header';

      const label = document.createElement('label');
      label.className = 'col-visible-label';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = visible[c];
      cb.addEventListener('change', () => {
        visible[c] = cb.checked;
        render();
      });
      label.appendChild(cb);
      const span = document.createElement('span');
      span.textContent = 'Колонка ' + (c + 1);
      label.appendChild(span);
      wrap.appendChild(label);

      const actions = document.createElement('div');
      actions.className = 'col-actions';

      const leftBtn = document.createElement('button');
      leftBtn.textContent = '←';
      leftBtn.title = 'Переместить колонку влево';
      leftBtn.disabled = c === 0;
      leftBtn.addEventListener('click', () => moveColumn(c, c - 1));
      actions.appendChild(leftBtn);

      const rightBtn = document.createElement('button');
      rightBtn.textContent = '→';
      rightBtn.title = 'Переместить колонку вправо';
      rightBtn.disabled = c === colCount - 1;
      rightBtn.addEventListener('click', () => moveColumn(c, c + 1));
      actions.appendChild(rightBtn);

      const delBtn = document.createElement('button');
      delBtn.textContent = '✕';
      delBtn.title = 'Удалить колонку';
      delBtn.className = 'secondary';
      delBtn.addEventListener('click', () => deleteColumn(c));
      actions.appendChild(delBtn);

      wrap.appendChild(actions);
      th.appendChild(wrap);
      if (!visible[c]) th.classList.add('hidden-col-col');
      headTr.appendChild(th);
    }

    thead.appendChild(headTr);
    grid.appendChild(thead);

    const tbody = document.createElement('tbody');
    rows.forEach((row, r) => {
      const tr = document.createElement('tr');

      const ctrlTd = document.createElement('td');
      ctrlTd.className = 'row-controls';

      const upBtn = document.createElement('button');
      upBtn.textContent = '↑';
      upBtn.title = 'Переместить строку вверх';
      upBtn.disabled = r === 0;
      upBtn.addEventListener('click', () => moveRow(r, r - 1));
      ctrlTd.appendChild(upBtn);

      const downBtn = document.createElement('button');
      downBtn.textContent = '↓';
      downBtn.title = 'Переместить строку вниз';
      downBtn.disabled = r === rows.length - 1;
      downBtn.addEventListener('click', () => moveRow(r, r + 1));
      ctrlTd.appendChild(downBtn);

      const delRowBtn = document.createElement('button');
      delRowBtn.textContent = '✕';
      delRowBtn.title = 'Удалить строку';
      delRowBtn.className = 'secondary';
      delRowBtn.addEventListener('click', () => deleteRow(r));
      ctrlTd.appendChild(delRowBtn);

      tr.appendChild(ctrlTd);

      for (let c = 0; c < colCount; c++) {
        const td = document.createElement('td');
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.value = row[c] ?? '';
        inp.addEventListener('input', () => {
          rows[r][c] = inp.value;
        });
        td.appendChild(inp);
        if (!visible[c]) td.classList.add('hidden-col-col');
        tr.appendChild(td);
      }

      tbody.appendChild(tr);
    });
    grid.appendChild(tbody);
  }

  function moveColumn(from, to) {
    if (to < 0 || to >= (rows[0] ? rows[0].length : 0)) return;
    for (const row of rows) {
      const [cell] = row.splice(from, 1);
      row.splice(to, 0, cell);
    }
    const [v] = visible.splice(from, 1);
    visible.splice(to, 0, v);
    render();
  }

  function moveRow(from, to) {
    if (to < 0 || to >= rows.length) return;
    const [r] = rows.splice(from, 1);
    rows.splice(to, 0, r);
    render();
  }

  function deleteColumn(c) {
    if (rows[0] && rows[0].length <= 1) return;
    for (const row of rows) row.splice(c, 1);
    visible.splice(c, 1);
    render();
  }

  function deleteRow(r) {
    if (rows.length <= 1) return;
    rows.splice(r, 1);
    render();
  }

  document.getElementById('add-row').addEventListener('click', () => {
    const colCount = rows[0] ? rows[0].length : 1;
    const newRow = new Array(colCount).fill('');
    rows.push(newRow);
    render();
  });

  document.getElementById('add-col').addEventListener('click', () => {
    rows.forEach((row) => row.push(''));
    visible.push(true);
    render();
  });

  document.getElementById('show-all').addEventListener('click', () => {
    visible = visible.map(() => true);
    render();
  });

  document.getElementById('hide-all').addEventListener('click', () => {
    visible = visible.map(() => false);
    render();
  });

  document.getElementById('ok').addEventListener('click', () => {
    const filtered = rows.map((row) => row.filter((_, c) => visible[c]).map(wrapQuotes));
    vscode.postMessage({ type: 'ok', rows: filtered });
  });

  document.getElementById('cancel').addEventListener('click', () => {
    vscode.postMessage({ type: 'cancel' });
  });

  render();
</script>
</body>
</html>`;
}
