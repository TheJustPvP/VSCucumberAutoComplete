# Export VA Steps to JSON (1C)

This project includes a template module for external 1C processing:

- `tools/1c/export_va_steps_json.bsl`

Use it to build `ЭкспортШаговVAВJSON.epf` and generate:

- `.vscode/va-step-library.json`

for the VS Code **VA Step Library** panel.

## 1. Create external processing in 1C

1. Create new external processing (`.epf`).
2. Add a form button, bind it to `ВыполнитьЭкспорт`.
3. Paste module code from:
   - `tools/1c/export_va_steps_json.bsl`

## 2. Bind adapter to Vanessa Automation

The only place that requires environment-specific code is:

- `ПолучитьШагиVA()`

It must return an array of structures:

- `text` (required)
- `description`
- `path` (folder path, e.g. `UI/Всплывающие окна`)
- `file`
- `procedure`

Use your VA runtime object/model to iterate known steps and map each step with:

- `СконвертироватьШагVA(ЭлементVA)`

## 3. Export JSON and import to VS Code

1. Run processing in 1C and save JSON as `va-step-library.json`.
2. In VS Code run command:
   - `Cucumber: Import VA JSON Library`
3. File is copied to:
   - `.vscode/va-step-library.json`
4. Open **Cucumber** activity bar -> **VA Step Library**.

## JSON shape

```json
{
  "version": "1.2.043.1",
  "generatedAt": "2026-03-04T12:00:00",
  "steps": [
    {
      "text": "И я закрываю окно предупреждения",
      "description": "Закрывает окно предупреждения если оно есть",
      "path": "UI/Всплывающие окна",
      "file": "ExternalDataProcessor.VA....",
      "procedure": "ЯЗакрываюОкноПредупреждения"
    }
  ]
}
```

