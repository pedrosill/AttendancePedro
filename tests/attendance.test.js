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
  setFontWeight() { return this; }
  setHorizontalAlignment() { return this; }
  merge() {
    this.sheet.merges.push({ row: this.row, column: this.column, rowCount: this.rowCount, columnCount: this.columnCount });
    for (let row = 0; row < this.rowCount; row += 1) {
      for (let column = 0; column < this.columnCount; column += 1) {
        if (row === 0 && column === 0) continue;
        this.sheet.setValueAt(this.row + row, this.column + column, '');
      }
    }
    return this;
  }
  breakApart() {
    this.sheet.merges = this.sheet.merges.filter(merge =>
      merge.row + merge.rowCount <= this.row || merge.row >= this.row + this.rowCount ||
      merge.column + merge.columnCount <= this.column || merge.column >= this.column + this.columnCount
    );
    return this;
  }
  setNote(note) { this.sheet.notes[`${this.row}:${this.column}`] = note; return this; }
  getNote() { return this.sheet.notes[`${this.row}:${this.column}`] || ''; }

  sort(spec) {
    this.sheet.sort(spec, this.row, this.rowCount, this.column, this.columnCount);
    return this;
  }

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
    this.notes = {};
    this.merges = [];
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

  insertRowsBefore(row, count) {
    this.data.splice(row - 1, 0, ...Array.from({ length: count }, () => []));
    this.fontColors.splice(row - 1, 0, ...Array.from({ length: count }, () => []));
  }

  sort(spec, rangeRow = 2, rangeRowCount = this.getLastRow() - rangeRow + 1, rangeColumn = 1) {
    const start = rangeRow - 1;
    const column = rangeColumn + (spec.column || 1) - 2;
    const rows = this.data.slice(start, start + rangeRowCount).map((row, index) => ({
      values: row,
      colors: this.fontColors[start + index] || [],
    })).filter(item => item.values.some(value => value !== '' && value !== null && value !== undefined));
    rows.sort((a, b) => String(a.values[column] || '').localeCompare(String(b.values[column] || ''), 'pt-PT'));
    this.data.splice(start, rangeRowCount, ...rows.map(item => item.values));
    this.fontColors.splice(start, rangeRowCount, ...rows.map(item => item.colors));
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
  const cache = new Map();
  let cacheGets = 0;
  let cachePuts = 0;
  let cacheRemoves = 0;
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
    CacheService: {
      getScriptCache: () => ({
        get(key) { cacheGets += 1; return cache.get(key) || null; },
        put(key, value) { cachePuts += 1; cache.set(key, value); },
        remove(key) { cacheRemoves += 1; cache.delete(key); }
      })
    },
    Session: { getScriptTimeZone: () => 'UTC' },
    Utilities: {
      getUuid: () => 'generated-id',
      formatDate(date, _timezone, pattern) {
        if (pattern === 'yyyy-MM-dd') return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
        if (pattern === 'yyyy-MM') return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0')].join('-');
        if (pattern === 'dd/MM') return [String(date.getDate()).padStart(2, '0'), String(date.getMonth() + 1).padStart(2, '0')].join('/');
        if (pattern === 'MMMM yyyy') return `${['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'][date.getMonth()]} ${date.getFullYear()}`;
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
  return {
    context,
    spreadsheet,
    getLockCounts: () => ({ waits: lockWaits, releases: lockReleases }),
    getCacheCounts: () => ({ gets: cacheGets, puts: cachePuts, removes: cacheRemoves })
  };
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

test('migra membros antigos para perfis com ID sem alterar a folha de presenças', () => {
  const { context, spreadsheet } = createContext();
  const meta = spreadsheet.insertSheet('__classes__');
  meta.data = [
    ['id', 'name', 'membersJson', 'trainingDaysJson', 'seasonStart'],
    ['gami-id', 'Gami', '["Ana","Bia"]', '[2,4]', '2026-09-08']
  ];
  const attendance = spreadsheet.insertSheet('Gami');
  attendance.data = [
    ['Membro', '2026-09-08'],
    ['Ana', '*'],
    ['Bia', 'A']
  ];

  const output = context.getSharedState();
  assert.deepEqual(JSON.parse(JSON.stringify(output.classes[0].members)), ['Ana', 'Bia']);
  assert.deepEqual(JSON.parse(JSON.stringify(output.classes[0].memberProfiles)).map(member => member.name), ['Ana', 'Bia']);
  assert.ok(output.classes[0].memberProfiles.every(member => member.id === 'generated-id'));
  assert.equal(JSON.parse(meta.valueAt(2, 6)).length, 2);
  assert.equal(attendance.valueAt(2, 1), 'Ana');
  assert.equal(attendance.valueAt(2, 2), '*');
  assert.equal(attendance.valueAt(3, 1), 'Bia');
  assert.equal(attendance.valueAt(3, 2), 'A');
});

test('adicionar membro preserva os metadados da fotografia', () => {
  const { context, spreadsheet } = createContext();
  const meta = spreadsheet.insertSheet('__classes__');
  meta.data = [
    ['id', 'name', 'membersJson', 'trainingDaysJson', 'seasonStart', 'memberProfilesJson'],
    ['gami-id', 'Gami', '["Ana"]', '[2,4]', '2026-09-08', '[{"id":"ana-id","name":"Ana","photoKey":"assets/avatars/example-1.png","photoVersion":0}]']
  ];

  const result = JSON.parse(context.doPost({ postData: { contents: JSON.stringify({
    action: 'addMember',
    classId: 'gami-id',
    member: { id: 'bia-id', name: 'Bia', photoKey: 'photos/gami-id/bia-id.webp', photoVersion: 4 }
  }) } }).value);

  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.class.members)), ['Ana', 'Bia']);
  assert.deepEqual(JSON.parse(JSON.stringify(result.class.memberProfiles.find(member => member.id === 'bia-id'))), {
    id: 'bia-id', name: 'Bia', photoKey: 'photos/gami-id/bia-id.webp', photoVersion: 4
  });
});

test('a cache de turmas é invalidada depois de uma alteração', () => {
  const { context, spreadsheet, getCacheCounts } = createContext();
  const meta = spreadsheet.insertSheet('__classes__');
  meta.data = [
    ['id', 'name', 'membersJson', 'trainingDaysJson', 'seasonStart'],
    ['gami-id', 'Gami', '["Ana"]', '[2,4]', '2026-09-08']
  ];

  assert.deepEqual(Array.from(context.getSharedState().classes[0].members), ['Ana']);
  assert.deepEqual(Array.from(context.getSharedState().classes[0].members), ['Ana']);

  const result = JSON.parse(context.doPost({ postData: { contents: JSON.stringify({
    action: 'addMember', classId: 'gami-id', memberName: 'Bia'
  }) } }).value);
  assert.equal(result.ok, true);
  assert.deepEqual(Array.from(context.getSharedState().classes[0].members), ['Ana', 'Bia']);
  assert.deepEqual(getCacheCounts(), { gets: 3, puts: 2, removes: 1 });
});

test('migra a tabela antiga, mantém células vazias e reaplica as cores', () => {
  const { context, spreadsheet } = createContext();
  const sheet = spreadsheet.insertSheet('Gami');
  sheet.data = [
    ['Date', 'Ana', 'Bia'],
    ['2026-09-08', 'Attended', ''],
    ['2026-09-09', '', 'Late']
  ];

  context.ensureAttendanceHeader(sheet);

  assert.equal(sheet.valueAt(1, 1), 'Membro');
  assert.equal(sheet.valueAt(1, 2), 'setembro 2026');
  assert.equal(context.normalizeDateKey(sheet.valueAt(2, 2)), '2026-09-08');
  assert.equal(sheet.valueAt(3, 1), 'Ana');
  assert.equal(sheet.valueAt(3, 2), '*');
  assert.equal(sheet.valueAt(3, 3), '');
  assert.equal(sheet.valueAt(4, 3), 'A');
  assert.equal(sheet.fontColorAt(3, 2), '#437a22');
  assert.equal(sheet.fontColorAt(4, 3), '#d19900');
  assert.equal(sheet.rules.length, 0);
});

test('agrupa as datas por mês e mantém datas e presenças ordenadas', () => {
  const { context, spreadsheet } = createContext();
  const sheet = spreadsheet.insertSheet('Gami');
  sheet.data = [
    ['Membro', '2026-10-01', '2026-09-10', '2026-09-03'],
    ['Ana', 'F', 'A', '*']
  ];

  context.ensureAttendanceHeader(sheet);
  context.normalizeAttendanceDates(sheet);
  context.sortDateColumnsByDate(sheet);

  assert.equal(sheet.valueAt(1, 2), 'setembro 2026');
  assert.equal(sheet.valueAt(1, 4), 'outubro 2026');
  assert.deepEqual(sheet.data[1].slice(1).map(date => context.normalizeDateKey(date)), [
    '2026-09-03', '2026-09-10', '2026-10-01'
  ]);
  assert.deepEqual(sheet.data[2], ['Ana', '*', 'A', 'F']);
  assert.ok(sheet.merges.some(range => range.row === 1 && range.column === 2 && range.columnCount === 2));
  assert.ok(sheet.merges.some(range => range.row === 1 && range.column === 1 && range.rowCount === 2));
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
  assert.equal(sheet.valueAt(3, 2), 'A');
  assert.equal(sheet.fontColorAt(3, 2), '#d19900');
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
  const anaRow = sheet.data.findIndex(row => row[0] === 'Ana') + 1;
  assert.equal(sheet.valueAt(anaRow, 2), 'A');
  assert.equal(sheet.fontColorAt(anaRow, 2), '#d19900');
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

  context.ensureAttendanceHeader(sheet);
  context.deduplicateDateColumns(sheet);

  assert.equal(sheet.getLastColumn(), 2);
  assert.equal(sheet.valueAt(3, 2), 'F');
  assert.equal(sheet.valueAt(4, 2), 'A');
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
  assert.equal(spreadsheet.getSheetByName('Gami').valueAt(3, 1), 'Bia');
});

test('adicionar membro ordena a linha completa sem trocar presenças', () => {
  const { context, spreadsheet } = createContext();
  const meta = spreadsheet.insertSheet('__classes__');
  meta.data = [
    ['id', 'name', 'membersJson', 'trainingDaysJson', 'seasonStart'],
    ['gami-id', 'Gami', '["Bia","Zoe"]', '[2,4]', '2026-09-08']
  ];
  const sheet = spreadsheet.insertSheet('Gami');
  sheet.data = [
    ['Membro', '2026-09-08'],
    ['Bia', 'A'],
    ['Zoe', '*']
  ];

  const result = JSON.parse(context.doPost({ postData: { contents: JSON.stringify({
    action: 'addMember', classId: 'gami-id', memberName: 'Ana'
  }) } }).value);

  assert.equal(result.ok, true);
  assert.deepEqual(sheet.data.slice(2).map((row, index) => [row[0], sheet.valueAt(index + 3, 2)]), [
    ['Ana', ''],
    ['Bia', 'A'],
    ['Zoe', '*']
  ]);
});

test('remover membro elimina a linha completa sem deslocar presenças', () => {
  const { context, spreadsheet } = createContext();
  const meta = spreadsheet.insertSheet('__classes__');
  meta.data = [
    ['id', 'name', 'membersJson', 'trainingDaysJson', 'seasonStart'],
    ['gami-id', 'Gami', '["Bia","Zoe"]', '[2,4]', '2026-09-08']
  ];
  const sheet = spreadsheet.insertSheet('Gami');
  sheet.data = [
    ['Membro', '2026-09-08'],
    ['Bia', 'A'],
    ['Zoe', '*']
  ];

  const result = JSON.parse(context.doPost({ postData: { contents: JSON.stringify({
    action: 'removeMember', classId: 'gami-id', memberName: 'Bia'
  }) } }).value);

  assert.equal(result.ok, true);
  assert.equal(sheet.getLastRow(), 3);
  assert.equal(sheet.valueAt(3, 1), 'Zoe');
  assert.equal(sheet.valueAt(3, 2), '*');
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

test('renomear um membro preserva as presenças históricas e a fotografia', () => {
  const { context, spreadsheet } = createContext();
  const profiles = [
    { id: 'member-ana', name: 'Ana', photoKey: 'photos/ana.jpg', photoVersion: 123 },
    { id: 'member-bia', name: 'Bia', photoKey: '', photoVersion: 0 }
  ];
  spreadsheet.insertSheet('__classes__').data = [
    ['id', 'name', 'membersJson', 'trainingDaysJson', 'seasonStart', 'memberProfilesJson'],
    ['gami-id', 'Gami', '["Ana","Bia"]', '[2,4]', '2026-09-08', JSON.stringify(profiles)]
  ];
  const sheet = spreadsheet.insertSheet('Gami');
  sheet.data = [
    ['Membro', '2026-09-08'],
    ['Ana', '*'],
    ['Bia', 'F']
  ];

  const result = JSON.parse(context.doPost({ postData: { contents: JSON.stringify({
    action: 'saveClass',
    class: {
      id: 'gami-id',
      name: 'Gami',
      members: ['Ana Costa', 'Bia'],
      memberProfiles: [
        { ...profiles[0], name: 'Ana Costa' },
        profiles[1]
      ]
    }
  }) } }).value);

  assert.equal(result.ok, true);
  assert.equal(sheet.valueAt(3, 1), 'Ana Costa');
  assert.equal(sheet.valueAt(3, 2), '*');
  assert.equal(sheet.valueAt(4, 1), 'Bia');
  assert.equal(sheet.valueAt(4, 2), 'F');
  assert.equal(result.class.memberProfiles[0].photoKey, 'photos/ana.jpg');
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

test('o resumo mantém os dois treinos mais recentes e inclui faltas anteriores', () => {
  const { context, spreadsheet } = createContext();
  const meta = spreadsheet.insertSheet('__classes__');
  meta.data = [
    ['id', 'name', 'membersJson', 'trainingDaysJson', 'seasonStart'],
    ['diaria-id', 'Diária', '["Ana"]', '[0,1,2,3,4,5,6]', '2026-09-01']
  ];
  const sheet = spreadsheet.insertSheet('Diária');
  sheet.data = [
    ['Membro', '2026-09-01', '2026-09-03', '2026-09-04'],
    ['Ana', '*', '*', '*']
  ];

  const output = context.getRecentAttendanceState({ classId: 'diaria-id', date: '2026-09-05', count: '2' });
  assert.deepEqual(JSON.parse(JSON.stringify(output.dates)), [
    { date: '2026-09-05', filled: false },
    { date: '2026-09-04', filled: true },
    { date: '2026-09-02', filled: false }
  ]);
});
