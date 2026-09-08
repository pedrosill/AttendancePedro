const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

class MockRange {
  constructor(sheet, row, column, rowCount, columnCount) {
    this.sheet = sheet;
    this.row = row;
    this.column = column;
    this.rowCount = rowCount;
    this.columnCount = columnCount;
  }

  getValues() {
    return Array.from({ length: this.rowCount }, (_, rowOffset) =>
      Array.from({ length: this.columnCount }, (_, columnOffset) =>
        this.sheet.valueAt(this.row + rowOffset, this.column + columnOffset))
    );
  }

  setValues(values) {
    values.forEach((row, rowOffset) => row.forEach((value, columnOffset) => {
      this.sheet.setValueAt(this.row + rowOffset, this.column + columnOffset, value);
    }));
    return this;
  }

  getValue() {
    return this.sheet.valueAt(this.row, this.column);
  }

  getFontColors() {
    return Array.from({ length: this.rowCount }, (_, rowOffset) =>
      Array.from({ length: this.columnCount }, (_, columnOffset) =>
        this.sheet.fontColorAt(this.row + rowOffset, this.column + columnOffset))
    );
  }

  setFontColors(colors) {
    colors.forEach((row, rowOffset) => row.forEach((color, columnOffset) => {
      this.sheet.setFontColorAt(this.row + rowOffset, this.column + columnOffset, color);
    }));
    return this;
  }

  setBackground() { return this; }

  setValue(value) {
    this.sheet.setValueAt(this.row, this.column, value);
    return this;
  }

  setNumberFormat() { return this; }
}

class MockSheet {
  constructor(name) {
    this.name = name;
    this.data = [];
    this.fontColors = [];
    this.rules = [];
  }

  getName() { return this.name; }
  setName(name) { this.name = name; }

  valueAt(row, column) {
    return this.data[row - 1]?.[column - 1] ?? '';
  }

  setValueAt(row, column, value) {
    while (this.data.length < row) this.data.push([]);
    while (this.data[row - 1].length < column) this.data[row - 1].push('');
    this.data[row - 1][column - 1] = value;
  }

  fontColorAt(row, column) {
    return this.fontColors[row - 1]?.[column - 1] ?? '';
  }

  setFontColorAt(row, column, color) {
    while (this.fontColors.length < row) this.fontColors.push([]);
    while (this.fontColors[row - 1].length < column) this.fontColors[row - 1].push('');
    this.fontColors[row - 1][column - 1] = color;
  }

  getLastRow() {
    for (let index = this.data.length - 1; index >= 0; index -= 1) {
      if (this.data[index].some(value => value !== '' && value !== null && value !== undefined)) return index + 1;
    }
    return 0;
  }

  getLastColumn() {
    let last = 0;
    this.data.forEach(row => row.forEach((value, index) => {
      if (value !== '' && value !== null && value !== undefined) last = Math.max(last, index + 1);
    }));
    return last;
  }

  getRange(row, column, rowCount = 1, columnCount = 1) {
    return new MockRange(this, row, column, rowCount, columnCount);
  }

  clearContents() { this.data = []; this.fontColors = []; }
  setConditionalFormatRules(rules) { this.rules = rules; }
  setFrozenRows() {}
  setFrozenColumns() {}

  sort(spec) {
    const start = 1;
    const column = (spec.column || 1) - 1;
    const rows = this.data.slice(start).map((row, index) => ({
      values: row,
      colors: this.fontColors[start + index] || [],
    })).filter(item => item.values.some(value => value !== '' && value !== null && value !== undefined));
    rows.sort((a, b) => String(a.values[column] || '').localeCompare(String(b.values[column] || ''), 'pt-PT'));
    this.data = this.data.slice(0, start).concat(rows.map(item => item.values));
    this.fontColors = this.fontColors.slice(0, start).concat(rows.map(item => item.colors));
  }

  deleteRow(row) {
    this.data.splice(row - 1, 1);
    this.fontColors.splice(row - 1, 1);
  }

  deleteColumn(column) {
    this.data.forEach(row => row.splice(column - 1, 1));
    this.fontColors.forEach(row => row.splice(column - 1, 1));
  }
}

class MockSpreadsheet {
  constructor() {
    this.sheets = [];
  }

  getSheets() { return this.sheets; }
  getSheetByName(name) { return this.sheets.find(sheet => sheet.name === name) || null; }
  insertSheet(name) {
    const sheet = new MockSheet(name);
    this.sheets.push(sheet);
    return sheet;
  }

  deleteSheet(sheet) {
    this.sheets = this.sheets.filter(item => item !== sheet);
  }
}

function createContext() {
  const spreadsheet = new MockSpreadsheet();
  let lockWaits = 0;
  let lockReleases = 0;
  const ruleBuilder = () => ({
    whenTextEqualTo() { return this; },
    whenTextContains() { return this; },
    setBackground() { return this; },
    setRanges() { return this; },
    build() { return {}; }
  });
  const context = {
    console,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => spreadsheet,
      newConditionalFormatRule: ruleBuilder
    },
    LockService: {
      getScriptLock: () => ({
        waitLock() { lockWaits += 1; },
        releaseLock() { lockReleases += 1; }
      })
    },
    Session: { getScriptTimeZone: () => 'UTC' },
    Utilities: {
      getUuid: () => 'generated-id',
      formatDate(date, _timezone, pattern) {
        if (pattern === 'yyyy-MM-dd') return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
        if (pattern === 'dd/MM') return [String(date.getDate()).padStart(2, '0'), String(date.getMonth() + 1).padStart(2, '0')].join('/');
        return date.toISOString();
      }
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput(value) { return { value, setMimeType() { return this; } }; }
    }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('ScriptForSheets', 'utf8'), context);
  return { context, spreadsheet, getLockCounts: () => ({ waits: lockWaits, releases: lockReleases }) };
}

test('normaliza datas portuguesas para uma chave única', () => {
  const { context } = createContext();
  assert.equal(context.normalizeDateKey('08/09/2026'), '2026-09-08');
  assert.equal(context.normalizeDateKey('2026/09/08'), '2026-09-08');
  assert.equal(context.normalizeDateKey('2026-09-08'), '2026-09-08');
});

test('migra os metadados antigos para guardar o calendário da turma', () => {
  const { context, spreadsheet } = createContext();
  const meta = spreadsheet.insertSheet('__classes__');
  meta.data = [
    ['id', 'name', 'membersJson'],
    ['gami-id', 'Gami', '["Ana"]']
  ];

  const output = JSON.parse(context.doGet({ parameter: { action: 'state' } }).value);
  assert.equal(output.classes[0].seasonStart, '2026-09-08');
  assert.deepEqual(Array.from(JSON.parse(meta.valueAt(2, 4))), [2, 4]);
  assert.equal(meta.valueAt(1, 4), 'trainingDaysJson');
});

test('migra a tabela antiga, mantém células vazias e reaplica as cores', () => {
  const { context, spreadsheet } = createContext();
  const sheet = spreadsheet.insertSheet('Gami');
  sheet.data = [
    ['Date', 'Ana', 'Bia'],
    ['2026-09-08', 'Attended', ''],
    ['2026-09-09', '', 'Late']
  ];

  context.transposeLegacyAttendanceSheet(sheet);

  assert.equal(sheet.valueAt(1, 1), 'Membro');
  assert.equal(sheet.valueAt(2, 1), 'Ana');
  assert.equal(sheet.valueAt(2, 2), '*');
  assert.equal(sheet.valueAt(2, 3), '');
  assert.equal(sheet.valueAt(3, 3), 'A');
  assert.equal(sheet.fontColorAt(2, 2), '#437a22');
  assert.equal(sheet.fontColorAt(3, 3), '#d19900');
  assert.equal(sheet.rules.length, 0);
});

test('a mesma data atualiza a coluna existente sem criar duplicados', () => {
  const { context, spreadsheet, getLockCounts } = createContext();
  const meta = spreadsheet.insertSheet('__classes__');
  meta.data = [
    ['id', 'name', 'membersJson', 'trainingDaysJson', 'seasonStart'],
    ['gami-id', 'Gami', '["Ana"]', '[2,4]', '2026-09-08']
  ];

  const post = payload => context.doPost({ postData: { contents: JSON.stringify(payload) } });
  post({ action: 'saveAttendance', classId: 'gami-id', className: 'Gami', date: '2026-09-08', members: [{ name: 'Ana', status: 'attended' }] });
  post({ action: 'saveAttendance', classId: 'gami-id', className: 'Gami', date: '2026-09-08', members: [{ name: 'Ana', status: 'late' }] });

  const sheet = spreadsheet.getSheetByName('Gami');
  assert.equal(sheet.getLastColumn(), 2);
  assert.equal(sheet.valueAt(2, 2), 'A');
  assert.equal(sheet.fontColorAt(2, 2), '#d19900');
  assert.deepEqual(getLockCounts(), { waits: 2, releases: 2 });
});

test('usa a cor do texto para recuperar a justificação', () => {
  const { context, spreadsheet } = createContext();
  const meta = spreadsheet.insertSheet('__classes__');
  meta.data = [
    ['id', 'name', 'membersJson', 'trainingDaysJson', 'seasonStart'],
    ['gami-id', 'Gami', '["Ana","Bia"]', '[2,4]', '2026-09-08']
  ];

  const post = payload => context.doPost({ postData: { contents: JSON.stringify(payload) } });
  post({
    action: 'saveAttendance',
    classId: 'gami-id',
    className: 'Gami',
    date: '2026-09-08',
    members: [
      { name: 'Ana', status: 'late_told' },
      { name: 'Bia', status: 'absent_not_justified' }
    ]
  });

  const sheet = spreadsheet.getSheetByName('Gami');
  assert.equal(sheet.valueAt(2, 2), 'A');
  assert.equal(sheet.fontColorAt(2, 2), '#d19900');
  const state = context.getAttendanceState({ classId: 'gami-id', date: '2026-09-08' });
  assert.deepEqual(JSON.parse(JSON.stringify(state.members.map(member => [member.name, member.status]))), [
    ['Ana', 'late_told'],
    ['Bia', 'absent_not_justified']
  ]);
});

test('consolida colunas duplicadas da mesma data', () => {
  const { context, spreadsheet } = createContext();
  const sheet = spreadsheet.insertSheet('Gami');
  sheet.data = [
    ['Membro', '2026-09-08', '08/09/2026'],
    ['Ana', '*', 'F'],
    ['Bia', '', 'A']
  ];

  context.deduplicateDateColumns(sheet);

  assert.equal(sheet.getLastColumn(), 2);
  assert.equal(sheet.valueAt(2, 2), 'F');
  assert.equal(sheet.valueAt(3, 2), 'A');
});

test('operações de membros preservam o estado mais recente da turma', () => {
  const { context, spreadsheet } = createContext();
  const meta = spreadsheet.insertSheet('__classes__');
  meta.data = [
    ['id', 'name', 'membersJson', 'trainingDaysJson', 'seasonStart'],
    ['gami-id', 'Gami', '["Ana"]', '[2,4]', '2026-09-08']
  ];
  const post = payload => context.doPost({ postData: { contents: JSON.stringify(payload) } });

  const added = JSON.parse(post({ action: 'addMember', classId: 'gami-id', memberName: 'Bia' }).value);
  assert.deepEqual(JSON.parse(JSON.stringify(added.class.members)), ['Ana', 'Bia']);
  const removed = JSON.parse(post({ action: 'removeMember', classId: 'gami-id', memberName: 'Ana' }).value);
  assert.deepEqual(JSON.parse(JSON.stringify(removed.class.members)), ['Bia']);
  assert.deepEqual(JSON.parse(meta.valueAt(2, 3)), ['Bia']);
  assert.equal(spreadsheet.getSheetByName('Gami').valueAt(2, 1), 'Bia');
});

test('renomear uma turma não substitui membros existentes', () => {
  const { context, spreadsheet } = createContext();
  const meta = spreadsheet.insertSheet('__classes__');
  meta.data = [
    ['id', 'name', 'membersJson', 'trainingDaysJson', 'seasonStart'],
    ['gami-id', 'Gami', '["Ana","Bia"]', '[2,4]', '2026-09-08']
  ];
  spreadsheet.insertSheet('Gami');

  const result = JSON.parse(context.doPost({ postData: { contents: JSON.stringify({
    action: 'saveClass',
    class: { id: 'gami-id', name: 'Gami Nova' }
  }) } }).value);

  assert.deepEqual(JSON.parse(JSON.stringify(result.class.members)), ['Ana', 'Bia']);
  assert.equal(spreadsheet.getSheetByName('Gami'), null);
  assert.ok(spreadsheet.getSheetByName('Gami Nova'));
});

test('remover uma turma remove também a sua folha', () => {
  const { context, spreadsheet } = createContext();
  const meta = spreadsheet.insertSheet('__classes__');
  meta.data = [
    ['id', 'name', 'membersJson', 'trainingDaysJson', 'seasonStart'],
    ['gami-id', 'Gami', '["Ana"]', '[2,4]', '2026-09-08'],
    ['mini-id', 'Minigami', '[]', '[1,2,4]', '2026-09-08']
  ];
  spreadsheet.insertSheet('Gami');
  spreadsheet.insertSheet('Minigami');

  const result = JSON.parse(context.doPost({ postData: { contents: JSON.stringify({
    action: 'removeClass', classId: 'gami-id'
  }) } }).value);

  assert.equal(result.ok, true);
  assert.equal(spreadsheet.getSheetByName('Gami'), null);
  assert.ok(spreadsheet.getSheetByName('Minigami'));
  assert.equal(meta.getLastRow(), 2);
});

test('o resumo devolve apenas dias de treino da turma', () => {
  const { context, spreadsheet } = createContext();
  const meta = spreadsheet.insertSheet('__classes__');
  meta.data = [
    ['id', 'name', 'membersJson', 'trainingDaysJson', 'seasonStart'],
    ['minigami-id', 'Minigami', '[]', '[1,2,4]', '2026-09-08']
  ];

  const output = context.getRecentAttendanceState({ classId: 'minigami-id', date: '2026-09-09', count: '2' });
  assert.deepEqual(Array.from(output.dates, item => item.date), ['2026-09-08']);
});
