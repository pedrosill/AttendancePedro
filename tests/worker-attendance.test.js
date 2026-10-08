const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const workerSource = fs.readFileSync(path.join(__dirname, '..', 'attendance-data-worker.js'), 'utf8')
  .replace('export default {', 'globalThis.__worker = {') +
  '\nglobalThis.__attendanceTest = { recentAttendanceFromD1, hasRecordedAttendance };';
const workerContext = vm.createContext({ console });
vm.runInContext(workerSource, workerContext);
const { recentAttendanceFromD1, hasRecordedAttendance } = workerContext.__attendanceTest;

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
