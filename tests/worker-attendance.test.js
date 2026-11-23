const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const workerSource = fs.readFileSync(path.join(__dirname, '..', 'attendance-data-worker.js'), 'utf8')
  .replace('export default {', 'globalThis.__worker = {') +
  '\nglobalThis.__attendanceTest = { recentAttendanceFromD1, attendanceOverview, hasRecordedAttendance, removeAttendanceMemberStatements, mergeImportedAttendanceMembers, userNameKey, userIdBase, normaliseProfile, stateFingerprint, preserveMemberAttendanceNotes };';
const workerContext = vm.createContext({ console });
vm.runInContext(workerSource, workerContext);
const { recentAttendanceFromD1, attendanceOverview, hasRecordedAttendance, removeAttendanceMemberStatements, mergeImportedAttendanceMembers, userNameKey, userIdBase, normaliseProfile, stateFingerprint, preserveMemberAttendanceNotes } = workerContext.__attendanceTest;

test('o worker preserva informação recorrente e considera alterações no fingerprint da turma', () => {
  const notes = [{ id: 'note-monday', text: 'Sai mais cedo', days: [1, 1, 8] }];
  const profile = normaliseProfile({ id: 'ana-id', attendanceNotes: notes }, 'Ana');
  assert.deepEqual(JSON.parse(JSON.stringify(profile.attendanceNotes)), [
    { id: 'note-monday', text: 'Sai mais cedo', days: [1] }
  ]);
  const before = stateFingerprint({ classes: [{ id: 'gami', name: 'Gami', members: ['Ana'], memberProfiles: [{ id: 'ana-id', name: 'Ana' }] }] });
  const after = stateFingerprint({ classes: [{ id: 'gami', name: 'Gami', members: ['Ana'], memberProfiles: [profile] }] });
  assert.notEqual(before, after);
  assert.deepEqual(JSON.parse(JSON.stringify(normaliseProfile({ id: 'legacy-id' }, 'Legacy').attendanceNotes)), []);
});

test('uma atualização de perfil antiga sem o campo recorrente não apaga os lembretes', () => {
  const notes = [{ id: 'note-1', text: 'Sai cedo', days: [1] }];
  const updated = preserveMemberAttendanceNotes(
    [{ id: 'ana-id', name: 'Ana Costa', photoKey: 'photos/ana.webp' }],
    [{ id: 'ana-id', name: 'Ana', attendanceNotes: notes }]
  );
  assert.deepEqual(JSON.parse(JSON.stringify(updated[0].attendanceNotes)), notes);
  const cleared = preserveMemberAttendanceNotes(
    [{ id: 'ana-id', name: 'Ana Costa', attendanceNotes: [] }],
    [{ id: 'ana-id', name: 'Ana', attendanceNotes: notes }]
  );
  assert.deepEqual(JSON.parse(JSON.stringify(cleared[0].attendanceNotes)), []);
});

test('a reimportação do Sheets corrige estados pendentes sem substituir estados já guardados', () => {
  const merged = mergeImportedAttendanceMembers([
    { name: 'Ana', status: 'pending' },
    { name: 'Bea', status: 'attended' }
  ], [
    { name: ' ana ', status: 'absent_not_justified' },
    { name: 'Bea', status: 'absent' },
    { name: 'Carla', status: 'late' }
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(merged)), [
    { name: 'Ana', status: 'absent_not_justified' },
    { name: 'Bea', status: 'attended' },
    { name: 'Carla', status: 'late' }
  ]);
});

test('os identificadores de utilizador preservam nomes legíveis e removem acentos', () => {
  assert.equal(userIdBase('M.ª João'), 'm-joao');
  assert.equal(userIdBase('Rita G.'), 'rita-g');
  assert.equal(userIdBase('!!!'), 'utilizador');
});

test('nomes duplicados são comparados sem diferenças de espaços ou maiúsculas', () => {
  assert.equal(userNameKey('  M.ª   João '), userNameKey('m.ª joão'));
});

test('uma sessão só com estados pendentes não conta como presença preenchida', () => {
  assert.equal(hasRecordedAttendance([
    { name: 'Ana', status: 'pending' },
    { name: 'Bea', status: 'pending' }
  ]), false);
  assert.equal(hasRecordedAttendance([{ name: 'Ana', status: '*' }]), true);
  assert.equal(hasRecordedAttendance([{ name: 'Ana', status: 'F' }]), true);
  assert.equal(hasRecordedAttendance([{ name: 'Ana', status: 'A' }]), true);
});

test('o resumo usa estados de presença reais e não um registo vazio no D1', async () => {
  const db = {
    prepare(sql) {
      return {
        bind() { return this; },
        async first() {
          if (sql.includes('attendance_history_sync')) return { complete: 1, last_error: '' };
          throw new Error(`Query inesperada: ${sql}`);
        },
        async all() {
          if (sql.includes('FROM attendance_core')) return { results: [
            { date_key: '2026-10-08', members_json: JSON.stringify([{ name: 'Ana', status: 'pending' }, { name: 'Bea', status: 'pending' }]) },
            { date_key: '2026-10-06', members_json: JSON.stringify([{ name: 'Ana', status: 'attended' }, { name: 'Bea', status: 'absent_not_justified' }]) }
          ] };
          throw new Error(`Query inesperada: ${sql}`);
        }
      };
    }
  };
  const result = await recentAttendanceFromD1({ DB: db }, {
    id: 'minigami-id',
    name: 'Minigami',
    seasonStart: '2026-10-06',
    trainingDays: [2, 4]
  }, '2026-10-08', 2);

  assert.deepEqual(JSON.parse(JSON.stringify(result.dates)), [
    { date: '2026-10-08', filled: false },
    { date: '2026-10-06', filled: true }
  ]);
});

test('o histórico pagina datas únicas por ordem decrescente, incluindo datas só de um dos índices D1', async () => {
  const rows = [
    { date_key: '2026-10-08', date_created_at: 1, operation_id: '', updated_at: null, members_json: null },
    { date_key: '2026-10-07', date_created_at: null, operation_id: 'op-7', updated_at: 7, members_json: JSON.stringify([{ name: 'Ana', status: 'attended' }]) },
    { date_key: '2026-10-06', date_created_at: 1, operation_id: '', updated_at: null, members_json: null },
    { date_key: '2026-10-05', date_created_at: null, operation_id: 'op-5', updated_at: 5, members_json: JSON.stringify([{ name: 'Bea', status: 'absent' }]) }
  ];
  const db = {
    prepare(sql) {
      const statement = { values: [], bind(...values) { this.values = values; return this; } };
      statement.first = async () => {
        if (sql.includes('FROM classes_core')) return { count: 1 };
        if (sql.includes('attendance_history_sync')) return { complete: 1 };
        throw new Error(`Query inesperada: ${sql}`);
      };
      statement.all = async () => {
        if (sql.includes('FROM classes_core')) return { results: [{ id: 'minigami', name: 'Minigami', training_days_json: '[]', season_start: '2026-09-01', version: 1 }] };
        if (sql.includes('FROM members_core')) return { results: [] };
        if (sql.includes('WITH dates AS')) {
          const cursor = statement.values.find(value => typeof value === 'string' && /^2026-\d{2}-\d{2}$/.test(value));
          const limit = statement.values.at(-1);
          return { results: rows.filter(row => !cursor || row.date_key < cursor).sort((a, b) => b.date_key.localeCompare(a.date_key)).slice(0, limit) };
        }
        throw new Error(`Query inesperada: ${sql}`);
      };
      return statement;
    }
  };

  const first = await attendanceOverview({ DB: db }, 'minigami', 2);
  const second = await attendanceOverview({ DB: db }, 'minigami', 2, first.nextBeforeDate);
  assert.deepEqual(JSON.parse(JSON.stringify(first.records.map(record => record.date))), ['2026-10-08', '2026-10-07']);
  assert.equal(first.hasMore, true);
  assert.equal(first.nextBeforeDate, '2026-10-07');
  assert.deepEqual(JSON.parse(JSON.stringify(second.records.map(record => record.date))), ['2026-10-06', '2026-10-05']);
  assert.equal(second.hasMore, false);
  assert.equal(second.records[0].hasAttendance, false);
  assert.equal(second.records[1].hasAttendance, true);
});

test('a eliminação do histórico remove apenas as presenças do membro em D1', async () => {
  const prepared = [];
  const db = {
    prepare(sql) {
      return {
        sql,
        values: [],
        bind(...values) { this.values = values; return this; },
        async all() {
          return { results: [
            { date_key: '2026-10-08', members_json: JSON.stringify([
              { name: 'Ana', status: 'attended' },
              { name: 'Bea', status: 'absent_justified' }
            ]) },
            { date_key: '2026-10-06', members_json: JSON.stringify([{ name: 'Ana', status: 'late_told' }]) }
          ] };
        }
      };
    }
  };
  const originalPrepare = db.prepare.bind(db);
  db.prepare = sql => {
    const statement = originalPrepare(sql);
    const originalBind = statement.bind;
    statement.bind = (...values) => { originalBind.apply(statement, values); if (sql.startsWith('UPDATE attendance_core')) prepared.push(statement); return statement; };
    return statement;
  };

  await removeAttendanceMemberStatements({ DB: db }, 'minigami-id', 'Ana');

  assert.equal(prepared.length, 2);
  assert.deepEqual(JSON.parse(prepared[0].values[0]), [{ name: 'Bea', status: 'absent_justified' }]);
  assert.deepEqual(JSON.parse(prepared[1].values[0]), []);
  assert.equal(prepared[0].values[2], 'minigami-id');
});
