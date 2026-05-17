# Cucumber (Gherkin) Full Support — VA Edition

Расширение VS Code для работы с `.feature` файлами в проектах на базе **Vanessa Automation**.  
Обеспечивает подсветку синтаксиса, автодополнение шагов из `.bsl` библиотек и JSON-каталогов, визуальный редактор таблиц Gherkin и встроенную библиотеку шагов прямо в боковой панели VS Code.

---

## Возможности

### Подсветка синтаксиса
- Полная раскраска `.feature` файлов: ключевые слова (`Функционал`, `Сценарий`, `Когда`, `Тогда` и др.)
- Подсветка строк в одинарных и двойных кавычках
- Выделение переменных шаблонов `<ПеременнаяСценария>`
- Раскраска тегов `@ТегСценария`
- Подсветка комментариев и строк-таблиц `| ... |`
- Поддержка русского и многих других языков Gherkin

### Автодополнение шагов
- Подсказки шагов по мере набора текста в `.feature` файле
- Источники шагов:
  - `.bsl` файлы библиотек Vanessa Automation (читает комментарии-описания шагов)
  - JSON-каталоги шагов (`cucumberautocomplete.vaStepsJson`)
  - `.feature` файлы с тегом `@ExportScenarios` (сценарии как вызываемые шаги)
- Сортировка подсказок по частоте использования
- Умные сниппеты: параметры шага автоматически становятся полями для заполнения
- Строгий режим: показывать только шаги, объявленные через соответствующее ключевое слово (`Когда`, `Тогда` и т.д.)

### Библиотека шагов VA (боковая панель)
Просмотр известных шагов Vanessa Automation прямо внутри VS Code без переключения в браузер или документацию.

**Как использовать:**
1. Экспортируйте шаги из 1С в JSON с помощью шаблона `tools/1c/export_va_steps_json.bsl`
2. В VS Code выполните команду `VA Библиотека: Загрузить JSON`
3. Откройте панель **Библиотека известных шагов VA** на боковой панели активности

**Возможности панели:**
- Дерево шагов по папкам/группам
- Поиск шага: `VA Библиотека: Найти шаг`
- Клик по шагу — вставка в текущий `.feature` файл на позицию курсора
- Открытие описания шага через контекстное меню
- Обновление библиотеки: `VA Библиотека: Обновить`
- Открытие исходного JSON: `VA Библиотека: Открыть JSON`

Подробное руководство по экспорту: [docs/va-json-export.md](docs/va-json-export.md)

### Визуальный редактор таблиц Gherkin
Редактирование таблиц данных в `.feature` файлах через удобный интерфейс — без ручного выравнивания и подсчёта пробелов.

**Как открыть:**
- Поставьте курсор на любую строку таблицы (`| ... |`)
- Правая кнопка мыши → `Gherkin: Редактировать таблицу`
- Или горячая клавиша `Ctrl+Shift+T`

**Возможности редактора:**
- Редактирование всех ячеек в виде таблицы с инпутами
- Добавление строк (`+ Строка`) и колонок (`+ Колонка`)
- Удаление строк и колонок (кнопка `✕`)
- Перемещение строк вверх/вниз (`↑` / `↓`)
- Перемещение колонок влево/вправо (`←` / `→`)
- Скрытие/показ колонок (чекбоксы) — скрытые колонки не попадают в файл при сохранении
- Автоматическое обёртывание значений ячеек в одинарные кавычки `'...'` при сохранении
- Проверка существующих кавычек — двойного оборачивания не происходит
- Автоматическое выравнивание отступа таблицы относительно шага, под которым она написана

### Выравнивание таблицы без открытия редактора
- Правая кнопка мыши → `Gherkin: Выровнять таблицу под курсором`
- Или горячая клавиша `Ctrl+Alt+T`

Выровнивает ширину всех колонок по самому длинному значению прямо в файле.

### Экспортируемые сценарии (`@ExportScenarios`)
Сценарии с тегом `@ExportScenarios` из `.feature` файлов рабочего пространства становятся доступны как подсказки-шаги в других `.feature` файлах.

Переключить: кнопка в строке состояния `Export Scenarios: On/Off` или команда `Cucumber: Toggle Export Scenarios`.

---

## Быстрый старт

1. Установите расширение из `.vsix` или через marketplace
2. Откройте проект в VS Code
3. Создайте `.vscode/settings.json` (если нет) и добавьте пути к шагам:

```json
{
    "cucumberautocomplete.steps": [
        "../vanessa-automation/features/Libraries/**/Forms/Форма/Ext/Form/Module.bsl"
    ],
    "editor.quickSuggestions": {
        "strings": true
    }
}
```

4. Перезагрузите окно (`Ctrl+Shift+P` → `Developer: Reload Window`)
5. Откройте любой `.feature` файл — автодополнение и подсветка активны

---

## Настройки

### `cucumberautocomplete.steps`
Путь или массив glob-путей к файлам с определениями шагов.  
Поддерживаются `.js`, `.ts`, `.py`, `.rb`, `.kt` и `.bsl` (Vanessa Automation).

```json
{
    "cucumberautocomplete.steps": [
        "../vanessa-automation/features/Libraries/**/Forms/Форма/Ext/Form/Module.bsl",
        "features/step_definitions/*.js"
    ]
}
```

Для `.bsl` файлов расширение читает комментарии-описания шагов в формате:
```bsl
//И я выполняю действие "Параметр"
Функция ИмяШага(Парам01) Экспорт
```

---

### `cucumberautocomplete.vaStepsJson`
Путь или массив путей к JSON-каталогам шагов (гибридный режим).

Поддерживаемые форматы:
- `string[]` — каждый элемент это текст шага
- `{ "text": "...", "documentation": "..." }[]`

```json
{
    "cucumberautocomplete.vaStepsJson": [
        ".vscode/va-step-library.json"
    ]
}
```

---

### `cucumberautocomplete.syncfeatures`
Glob-путь к `.feature` файлам для подсчёта использования шагов (влияет на сортировку подсказок).

```json
{
    "cucumberautocomplete.syncfeatures": "features/**/*.feature"
}
```

---

### `cucumberautocomplete.includeExportScenarios`
Парсить `.feature` файлы с тегом `@ExportScenarios` и использовать имена сценариев как шаги.

```json
{
    "cucumberautocomplete.includeExportScenarios": true
}
```

---

### `cucumberautocomplete.strictGherkinCompletion`
Показывать только шаги, объявленные через то же ключевое слово, которое написано в файле (`Когда` → только `When`-шаги).

```json
{
    "cucumberautocomplete.strictGherkinCompletion": true
}
```

---

### `cucumberautocomplete.smartSnippets`
Автоматически превращать части шага, требующие ввода (`.+`, `\\w+`, `([a-z]+)`), в сниппеты с позициями курсора.

```json
{
    "cucumberautocomplete.smartSnippets": true
}
```

---

### `cucumberautocomplete.stepsInvariants`
Показывать варианты шагов с `(a|b)` как отдельные подсказки.

```json
{
    "cucumberautocomplete.stepsInvariants": true
}
```

---

### `cucumberautocomplete.customParameters`
Замена частей RegEx шагов перед их разбором. Полезно для нестандартных форматов определений.

```json
{
    "cucumberautocomplete.customParameters": [
        { "parameter": "(u'", "value": "('" }
    ]
}
```

---

### `cucumberautocomplete.formatConfOverride`
Переопределение отступов форматирования для конкретных ключевых слов.

```json
{
    "cucumberautocomplete.formatConfOverride": {
        "И": 2,
        "Тогда": "relative"
    }
}
```

---

### `cucumberautocomplete.onTypeFormat`
Автоформатирование при нажатии пробела, `@` и `:`.

```json
{
    "cucumberautocomplete.onTypeFormat": true
}
```

---

### `cucumberautocomplete.pureTextSteps`
Режим чистого текста (Cucumber Expressions вместо RegEx). Спецсимволы RegEx в шагах трактуются буквально.

```json
{
    "cucumberautocomplete.pureTextSteps": true
}
```

---

## Горячие клавиши

| Действие | Клавиша |
|---|---|
| Открыть редактор таблицы | `Ctrl+Shift+T` |
| Выровнять таблицу под курсором | `Ctrl+Alt+T` |

---

## Пример полного settings.json

```json
{
    "cucumberautocomplete.steps": [
        "../vanessa-automation/features/Libraries/**/Forms/Форма/Ext/Form/Module.bsl"
    ],
    "cucumberautocomplete.vaStepsJson": [
        ".vscode/va-step-library.json"
    ],
    "cucumberautocomplete.syncfeatures": "features/**/*.feature",
    "cucumberautocomplete.includeExportScenarios": true,
    "cucumberautocomplete.strictGherkinCompletion": false,
    "cucumberautocomplete.smartSnippets": true,
    "cucumberautocomplete.stepsInvariants": false,
    "cucumberautocomplete.onTypeFormat": false,
    "editor.quickSuggestions": {
        "comments": false,
        "strings": true,
        "other": true
    }
}
```

---

## Основа

Расширение создано на базе [VSCucumberAutoComplete](https://github.com/alexkrechik/VSCucumberAutoComplete) от Alexander Krechik и доработано для использования совместно с [Vanessa Automation](https://github.com/Pr-Mex/vanessa-automation) — фреймворком BDD-тестирования для платформы 1С:Предприятие.

**Добавленные возможности по сравнению с оригиналом:**
- Поддержка `.bsl` файлов библиотек Vanessa Automation как источников шагов
- JSON-каталог шагов VA с боковой панелью просмотра прямо в VS Code
- Визуальный редактор таблиц Gherkin с выравниванием и управлением колонками
- Поддержка сценариев `@ExportScenarios` как вызываемых шагов
- Адаптация форматирования и поведения под русскоязычные проекты на Vanessa Automation
