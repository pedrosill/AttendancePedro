const STATE_KEY = 'state';
const STATE_SYNC_KEY = 'state:last-sync';
const CACHE_MAX_AGE_MS = 60 * 1000;
const MAX_OUTBOX_BATCH = 10;
const OUTBOX_LOCK_MS = 60 * 1000;
const MAX_OUTBOX_BACKOFF_MS = 15 * 60 * 1000;
const MUTATION_LOCK_MS = 30 * 1000;
const SHEETS_TIMEOUT_MS = 15 * 1000;
let activeFlush = null;

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  if (!origin || origin !== env.ALLOWED_ORIGIN) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Credentials': 'true',
    Vary: 'Origin'
  };
}

function jsonResponse(body, status, request, env) {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8' });
  Object.entries(corsHeaders(request, env)).forEach(([key, value]) => headers.set(key, value));
  return new Response(JSON.stringify(body), { status, headers });
}

function now() { return Date.now(); }
function id() { return crypto.randomUUID(); }

async function fetchWithTimeout(url, init = {}, timeout = SHEETS_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function normaliseProfile(profile, name) {
  const source = profile && typeof profile === 'object' ? profile : {};
  return {
    id: String(source.id || id()),
    name: String(name || source.name || '').trim(),
    photoKey: String(source.photoKey || '').trim(),
    photoVersion: Number(source.photoVersion || 0) || 0
  };
}

function uniqueNames(names) {
  const seen = new Set();
  return (Array.isArray(names) ? names : [])
    .map(name => String(name || '').trim())
    .filter(name => {
      const key = name.toLocaleLowerCase('pt-PT');
      if (!name || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function sortNames(names) {
  return uniqueNames(names).sort((a, b) => a.localeCompare(b, 'pt-PT', { sensitivity: 'base' }));
}

function normaliseClass(value) {
  const source = value && typeof value === 'object' ? value : {};
  const members = sortNames(source.members);
  const profilesByName = new Map((Array.isArray(source.memberProfiles) ? source.memberProfiles : [])
    .map(profile => [String(profile?.name || '').trim().toLocaleLowerCase('pt-PT'), profile]));
  return {
    id: String(source.id || id()),
    name: String(source.name || '').trim(),
    version: Number(source.version || 1) || 1,
    members,
    memberProfiles: members.map(name => normaliseProfile(profilesByName.get(name.toLocaleLowerCase('pt-PT')), name)),
    trainingDays: Array.isArray(source.trainingDays) ? source.trainingDays.map(Number).filter(day => Number.isInteger(day) && day >= 0 && day <= 6) : [],
    seasonStart: String(source.seasonStart || '')
  };
}

function normaliseState(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    ok: true,
    classes: (Array.isArray(source.classes) ? source.classes : []).map(normaliseClass).filter(item => item.name)
  };
}

function classNameKey(value) {
  return String(value || '').trim().toLocaleLowerCase('pt-PT');
}

async function hasCoreState(env) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS count FROM classes_core').first();
  return Number(row?.count || 0) > 0;
}

async function readCoreState(env) {
  const [classRows, memberRows] = await Promise.all([
    env.DB.prepare('SELECT id, name, training_days_json, season_start, version FROM classes_core ORDER BY name_key').all(),
    env.DB.prepare('SELECT id, class_id, name, photo_key, photo_version FROM members_core ORDER BY class_id, name_key').all()
  ]);
  const membersByClass = new Map();
  for (const row of memberRows.results || []) {
    if (!membersByClass.has(row.class_id)) membersByClass.set(row.class_id, []);
    membersByClass.get(row.class_id).push({
      id: row.id,
      name: row.name,
      photoKey: row.photo_key,
      photoVersion: Number(row.photo_version || 0)
    });
  }
  const profilesByClass = new Map();
  for (const [classId, profiles] of membersByClass.entries()) profilesByClass.set(classId, profiles);
  return normaliseState({
    classes: (classRows.results || []).map(row => ({
      id: row.id,
      name: row.name,
      trainingDays: JSON.parse(row.training_days_json || '[]'),
      seasonStart: row.season_start,
      version: Number(row.version || 1),
      members: (profilesByClass.get(row.id) || []).map(profile => profile.name),
      memberProfiles: profilesByClass.get(row.id) || []
    }))
  });
}

async function writeCoreState(env, value) {
  const state = normaliseState(value);
  const classIds = state.classes.map(item => item.id);
  const statements = [];
  if (classIds.length) {
    statements.push(env.DB.prepare(`DELETE FROM classes_core WHERE id NOT IN (${classIds.map(() => '?').join(',')})`).bind(...classIds));
  } else {
    statements.push(env.DB.prepare('DELETE FROM classes_core'));
  }
  statements.push(env.DB.prepare('DELETE FROM members_core'));
  for (const cls of state.classes) {
    statements.push(env.DB.prepare(`INSERT INTO classes_core (id, name, name_key, training_days_json, season_start, version, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, name_key = excluded.name_key,
      training_days_json = excluded.training_days_json, season_start = excluded.season_start,
      version = classes_core.version + 1, updated_at = excluded.updated_at`)
      .bind(cls.id, cls.name, classNameKey(cls.name), JSON.stringify(cls.trainingDays || []), cls.seasonStart || '', Number(cls.version || 1), now()));
    for (const profile of cls.memberProfiles || []) {
      statements.push(env.DB.prepare(`INSERT INTO members_core (id, class_id, name, name_key, photo_key, photo_version, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET class_id = excluded.class_id, name = excluded.name,
        name_key = excluded.name_key, photo_key = excluded.photo_key,
        photo_version = excluded.photo_version, updated_at = excluded.updated_at`)
        .bind(profile.id, cls.id, profile.name, classNameKey(profile.name), profile.photoKey || '', Number(profile.photoVersion || 0), now()));
    }
  }
  await env.DB.batch(statements);
}

async function writeClassCore(env, value) {
  const cls = normaliseClass(value);
  const statements = [env.DB.prepare(`INSERT INTO classes_core (id, name, name_key, training_days_json, season_start, version, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, name_key = excluded.name_key,
    training_days_json = excluded.training_days_json, season_start = excluded.season_start,
    version = classes_core.version + 1, updated_at = excluded.updated_at`)
    .bind(cls.id, cls.name, classNameKey(cls.name), JSON.stringify(cls.trainingDays || []), cls.seasonStart || '', Number(cls.version || 1), now()),
  env.DB.prepare('DELETE FROM members_core WHERE class_id = ?').bind(cls.id)];
  for (const profile of cls.memberProfiles || []) {
    statements.push(env.DB.prepare(`INSERT INTO members_core (id, class_id, name, name_key, photo_key, photo_version, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET class_id = excluded.class_id, name = excluded.name,
      name_key = excluded.name_key, photo_key = excluded.photo_key,
      photo_version = excluded.photo_version, updated_at = excluded.updated_at`)
      .bind(profile.id, cls.id, profile.name, classNameKey(profile.name), profile.photoKey || '', Number(profile.photoVersion || 0), now()));
  }
  await env.DB.batch(statements);
}

async function deleteClassCore(env, classId) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM members_core WHERE class_id = ?').bind(classId),
    env.DB.prepare('DELETE FROM classes_core WHERE id = ?').bind(classId)
  ]);
}

function normaliseAttendanceStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  if (status === '*' || status === 'attended' || status === 'presente') return 'attended';
  if (status === 'a' || status === 'late' || status === 'atrasado') return 'late';
  if (status === 'late_told' || status === 'late_not_told') return status;
  if (status === 'absent_justified' || status === 'absent_not_justified') return status;
  if (status === 'f' || status === 'absent' || status === 'not attended' || status === 'falta') return 'absent';
  return 'pending';
}

function normaliseAttendanceResult(result) {
  if (!result || !Array.isArray(result.members)) return result;
  return {
    ...result,
    members: result.members.map(member => ({
      ...member,
      status: normaliseAttendanceStatus(member.status)
    }))
  };
}

async function readAttendanceCore(env, classId, date) {
  const row = await env.DB.prepare('SELECT class_id, date_key, class_name, members_json, operation_id, updated_at FROM attendance_core WHERE class_id = ? AND date_key = ?')
    .bind(classId, date).first();
  if (!row) return null;
  return normaliseAttendanceResult({
    ok: true,
    classId: row.class_id,
    className: row.class_name,
    date: row.date_key,
    members: JSON.parse(row.members_json || '[]'),
    filled: true,
    operationId: row.operation_id,
    updatedAt: row.updated_at
  });
}

async function writeAttendanceCore(env, value) {
  const attendance = normaliseAttendanceResult(value);
  await env.DB.prepare(`INSERT INTO attendance_core (class_id, date_key, class_name, members_json, operation_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(class_id, date_key) DO UPDATE SET class_name = excluded.class_name,
    members_json = excluded.members_json, operation_id = excluded.operation_id, updated_at = excluded.updated_at`)
    .bind(attendance.classId, attendance.date, attendance.className || '', JSON.stringify(attendance.members || []), attendance.operationId || id(), now())
    .run();
  return attendance;
}

async function readValue(env, key) {
  const row = await env.DB.prepare('SELECT value FROM kv WHERE key = ?').bind(key).first();
  return row ? JSON.parse(row.value) : null;
}

async function writeValue(env, key, value) {
  await env.DB.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .bind(key, JSON.stringify(value), now()).run();
}

async function ensureCoreState(env) {
  if (await hasCoreState(env)) return true;
  const cached = await readValue(env, STATE_KEY);
  if (!cached || !Array.isArray(cached.classes) || !cached.classes.length) return false;
  await writeCoreState(env, cached);
  return true;
}

async function readState(env) {
  if (await ensureCoreState(env)) return readCoreState(env);
  return readValue(env, STATE_KEY);
}

async function writeState(env, state) {
  const normalised = normaliseState(state);
  await writeCoreState(env, normalised);
  return writeValue(env, STATE_KEY, normalised);
}

async function sheetsRequest(env, action, init = {}) {
  const separator = env.SHEETS_API_URL.includes('?') ? '&' : '?';
  const url = action ? env.SHEETS_API_URL + separator + 'action=' + encodeURIComponent(action) : env.SHEETS_API_URL;
  const response = await fetchWithTimeout(url, {
    ...init,
    headers: { Accept: 'application/json', ...(init.headers || {}) }
  });
  if (!response.ok) throw new Error('Sheets HTTP ' + response.status);
  const result = await response.json();
  if (!result || result.ok !== true) throw new Error(result?.error || 'Sheets returned an error');
  return result;
}

async function importStateFromSheets(env, force = false) {
  const pending = await env.DB.prepare('SELECT COUNT(*) AS count FROM outbox').first();
  if (!force && Number(pending?.count || 0) > 0) return readState(env);
  if (!force) {
    const lastSync = await readValue(env, STATE_SYNC_KEY);
    if (lastSync && now() - Number(lastSync) < CACHE_MAX_AGE_MS) return readState(env);
  }
  const result = await sheetsRequest(env, 'state');
  const state = normaliseState(result);
  await writeState(env, state);
  await writeValue(env, STATE_SYNC_KEY, now());
  return state;
}

async function getOrBootstrapState(env) {
  const cached = await readState(env);
  return cached || importStateFromSheets(env, true);
}

async function refreshStateInBackground(env) {
  let lock;
  try {
    lock = await acquireMutationLock(env, 'state');
    await importStateFromSheets(env);
  } catch (error) {
    console.error('Background state sync failed:', error);
  } finally {
    await releaseMutationLock(env, lock);
  }
}

function findClass(state, classId) {
  return state.classes.find(item => item.id === classId) || null;
}

function findProfile(cls, memberId, memberName) {
  const name = String(memberName || '').trim().toLocaleLowerCase('pt-PT');
  return cls.memberProfiles.find(profile =>
    (memberId && profile.id === memberId) ||
    (!memberId && profile.name.toLocaleLowerCase('pt-PT') === name)
  ) || null;
}

function applyClassMutation(state, payload) {
  const next = normaliseState(state);
  let result = { ok: true };
  const action = String(payload.action || '');

  if (action === 'saveClasses') {
    next.classes = (Array.isArray(payload.classes) ? payload.classes : []).map(normaliseClass).filter(item => item.name);
    result.classes = next.classes;
    return { state: next, result };
  }

  const classId = String(payload.classId || payload.class?.id || '').trim();
  if (action === 'saveClass') {
    const input = payload.class && typeof payload.class === 'object' ? payload.class : payload;
    const current = findClass(next, classId);
    const record = normaliseClass({
      ...(current || {}),
      ...input,
      id: classId || input.id || id(),
      members: Array.isArray(input.members) ? input.members : current?.members,
      memberProfiles: Array.isArray(input.memberProfiles) ? input.memberProfiles : current?.memberProfiles
    });
    const index = next.classes.findIndex(item => item.id === record.id);
    if (index === -1) next.classes.push(record);
    else next.classes[index] = record;
    result.class = record;
    return { state: next, result };
  }

  const cls = findClass(next, classId);
  if (!cls) return { state: next, result: { ok: false, error: 'Class not found' } };

  if (action === 'addMember') {
    const input = payload.member && typeof payload.member === 'object' ? payload.member : payload;
    const name = String(input.name || payload.memberName || '').trim();
    if (!name) return { state: next, result: { ok: false, error: 'Missing memberName' } };
    if (!cls.members.some(item => item.toLocaleLowerCase('pt-PT') === name.toLocaleLowerCase('pt-PT'))) {
      cls.members = sortNames(cls.members.concat(name));
      cls.memberProfiles = cls.members.map(item => item.toLocaleLowerCase('pt-PT') === name.toLocaleLowerCase('pt-PT')
        ? normaliseProfile(input, item)
        : normaliseProfile(cls.memberProfiles.find(profile => profile.name.toLocaleLowerCase('pt-PT') === item.toLocaleLowerCase('pt-PT')), item));
    }
    result.class = cls;
    return { state: next, result };
  }

  if (action === 'removeMember') {
    const memberId = String(payload.memberId || '').trim();
    const memberName = String(payload.memberName || payload.name || '').trim();
    const removedMember = findProfile(cls, memberId, memberName);
    const removedName = removedMember?.name || memberName;
    cls.members = cls.members.filter(name => name.toLocaleLowerCase('pt-PT') !== removedName.toLocaleLowerCase('pt-PT'));
    cls.memberProfiles = cls.memberProfiles.filter(profile => profile.name.toLocaleLowerCase('pt-PT') !== removedName.toLocaleLowerCase('pt-PT'));
    result.class = cls;
    result.removedMember = removedMember || null;
    return { state: next, result };
  }

  if (action === 'removeClass') {
    next.classes = next.classes.filter(item => item.id !== classId);
    result.classId = classId;
    return { state: next, result };
  }

  return { state: next, result: { ok: false, error: 'Unknown action' } };
}

async function importAttendance(env, action, query) {
  const separator = env.SHEETS_API_URL.includes('?') ? '&' : '?';
  const params = new URLSearchParams({ action });
  Object.entries(query).forEach(([key, value]) => params.set(key, value));
  const response = await fetchWithTimeout(env.SHEETS_API_URL + separator + params.toString(), { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error('Sheets HTTP ' + response.status);
  const result = await response.json();
  if (!result || result.ok !== true) throw new Error(result?.error || 'Sheets returned an error');
  return action === 'attendance' ? normaliseAttendanceResult(result) : result;
}

async function claimOutboxRow(env) {
  const lockToken = id();
  const lockedUntil = now() + OUTBOX_LOCK_MS;
  const row = await env.DB.prepare('SELECT id, payload, attempts FROM outbox WHERE COALESCE(next_attempt_at, 0) <= ? AND (locked_until IS NULL OR locked_until < ?) ORDER BY created_at, id LIMIT 1')
    .bind(now(), now()).first();
  if (!row) return null;
  const claimed = await env.DB.prepare('UPDATE outbox SET locked_until = ?, lock_token = ? WHERE id = ? AND COALESCE(next_attempt_at, 0) <= ? AND (locked_until IS NULL OR locked_until < ?)')
    .bind(lockedUntil, lockToken, row.id, now(), now()).run();
  if (Number(claimed?.meta?.changes || 0) !== 1) return null;
  return { ...row, lockToken };
}

async function flushOutbox(env) {
  for (let index = 0; index < MAX_OUTBOX_BATCH; index += 1) {
    const row = await claimOutboxRow(env);
    if (!row) break;
    try {
      await sheetsRequest(env, '', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: row.payload
      });
      await env.DB.prepare('DELETE FROM outbox WHERE id = ? AND lock_token = ?').bind(row.id, row.lockToken).run();
      await writeSyncStatus(env, { lastSuccessAt: now(), lastError: '' });
    } catch (error) {
      const attempts = Number(row.attempts || 0) + 1;
      const retryDelay = Math.min(1000 * (2 ** Math.min(attempts, 10)), MAX_OUTBOX_BACKOFF_MS);
      await env.DB.prepare('UPDATE outbox SET attempts = ?, last_error = ?, next_attempt_at = ?, locked_until = NULL, lock_token = NULL WHERE id = ? AND lock_token = ?')
        .bind(attempts, String(error), now() + retryDelay, row.id, row.lockToken).run();
      await writeSyncStatus(env, { lastError: String(error) });
      console.error('Background Sheets write failed:', error);
      break;
    }
  }
  const remaining = await env.DB.prepare('SELECT COUNT(*) AS count FROM outbox').first();
  if (Number(remaining?.count || 0) === 0) await refreshStateInBackground(env);
}

function scheduleFlush(env) {
  if (activeFlush) return activeFlush;
  activeFlush = flushOutbox(env)
    .catch(error => console.error('Background outbox flush failed:', error))
    .finally(() => { activeFlush = null; });
  return activeFlush;
}

async function queueSheetsWrite(env, payload) {
  const operationId = String(payload.operationId || id());
  const nextPayload = { ...payload, operationId };
  await env.DB.prepare('INSERT OR IGNORE INTO outbox (payload, created_at, operation_id, next_attempt_at) VALUES (?, ?, ?, ?)')
    .bind(JSON.stringify(nextPayload), now(), operationId, now()).run();
}

async function writeSyncStatus(env, values) {
  const current = await env.DB.prepare('SELECT last_success_at, last_error FROM sync_status WHERE id = 1').first();
  await env.DB.prepare(`INSERT INTO sync_status (id, last_success_at, last_error, updated_at)
    VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET last_success_at = excluded.last_success_at,
    last_error = excluded.last_error, updated_at = excluded.updated_at`)
    .bind(values.lastSuccessAt ?? current?.last_success_at ?? null, values.lastError ?? current?.last_error ?? '', now()).run();
}

async function readSyncStatus(env) {
  const pending = await env.DB.prepare('SELECT COUNT(*) AS count FROM outbox WHERE locked_until IS NULL OR locked_until < ?').bind(now()).first();
  const row = await env.DB.prepare('SELECT last_success_at, last_error, updated_at FROM sync_status WHERE id = 1').first();
  return {
    ok: true,
    pending: Number(pending?.count || 0),
    lastSuccessAt: row?.last_success_at || null,
    lastError: row?.last_error || '',
    updatedAt: row?.updated_at || null
  };
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function acquireMutationLock(env, scope) {
  const deadline = now() + MUTATION_LOCK_MS;
  while (now() < deadline) {
    const token = id();
    const lockedUntil = now() + MUTATION_LOCK_MS;
    const result = await env.DB.prepare(`INSERT INTO mutation_locks (scope, locked_until, lock_token)
      VALUES (?, ?, ?)
      ON CONFLICT(scope) DO UPDATE SET locked_until = excluded.locked_until, lock_token = excluded.lock_token
      WHERE COALESCE(mutation_locks.locked_until, 0) < ?`)
      .bind(scope, lockedUntil, token, now()).run();
    if (Number(result?.meta?.changes || 0) === 1) return { scope, token };
    await wait(40);
  }
  throw new Error('O servidor está ocupado. Tenta novamente.');
}

async function releaseMutationLock(env, lock) {
  if (!lock) return;
  try {
    await env.DB.prepare('DELETE FROM mutation_locks WHERE scope = ? AND lock_token = ?').bind(lock.scope, lock.token).run();
  } catch (error) {
    console.error('Mutation lock release failed:', error);
  }
}

async function deleteCacheKeys(env, matches) {
  if (!matches.length) return;
  await env.DB.batch(matches.map(prefix => env.DB.prepare('DELETE FROM kv WHERE key >= ? AND key < ?').bind(prefix, `${prefix}\uffff`)));
}

async function invalidateClassCaches(env, classId) {
  if (!classId) return;
  await deleteCacheKeys(env, [`attendance:${classId}:`, `recent:${classId}:`, `sync:attendance:${classId}:`, `sync:recent:${classId}:`]);
}

async function invalidateAllAttendanceCaches(env) {
  await deleteCacheKeys(env, ['attendance:', 'recent:', 'sync:attendance:', 'sync:recent:']);
}

async function refreshReadCacheInBackground(env, action, query, cacheKey) {
  try {
    const pending = await env.DB.prepare('SELECT COUNT(*) AS count FROM outbox').first();
    if (Number(pending?.count || 0) > 0) return;
    const syncKey = 'sync:' + cacheKey;
    const lastSync = await readValue(env, syncKey);
    if (lastSync && now() - Number(lastSync) < CACHE_MAX_AGE_MS) return;
    const result = await importAttendance(env, action, query);
    if (action === 'attendance') await writeAttendanceCore(env, result);
    await writeValue(env, cacheKey, result);
    await writeValue(env, syncKey, now());
  } catch (error) {
    console.error('Background attendance sync failed:', error);
  }
}

async function handleGet(request, env, ctx) {
  const url = new URL(request.url);
  const action = url.searchParams.get('action') || 'state';
  if (action === 'syncStatus') return jsonResponse(await readSyncStatus(env), 200, request, env);
  if (action === 'bootstrap') {
    const state = await getOrBootstrapState(env);
    const classId = url.searchParams.get('classId') || '';
    const date = url.searchParams.get('date') || '';
    const recentKey = 'recent:' + classId + ':' + date + ':' + (url.searchParams.get('count') || '2');
    const attendance = classId && date
      ? await readAttendanceCore(env, classId, date) || await readValue(env, 'attendance:' + classId + ':' + date)
      : null;
    const recent = classId ? await readValue(env, recentKey) : null;
    const query = Object.fromEntries([...url.searchParams.entries()].filter(([key]) => key !== 'action'));
    if (classId && date && !attendance) ctx.waitUntil(refreshReadCacheInBackground(env, 'attendance', query, 'attendance:' + classId + ':' + date));
    if (classId && !recent) ctx.waitUntil(refreshReadCacheInBackground(env, 'recentAttendance', query, recentKey));
    ctx.waitUntil(refreshStateInBackground(env));
    ctx.waitUntil(scheduleFlush(env));
    return jsonResponse({ ...state, attendance, recent, sync: await readSyncStatus(env) }, 200, request, env);
  }
  if (action === 'state') {
    const state = await getOrBootstrapState(env);
    ctx.waitUntil(refreshStateInBackground(env));
    ctx.waitUntil(scheduleFlush(env));
    return jsonResponse(state, 200, request, env);
  }

  const classId = url.searchParams.get('classId') || '';
  const date = url.searchParams.get('date') || '';
  const cacheKey = action === 'attendance'
    ? 'attendance:' + classId + ':' + date
    : 'recent:' + classId + ':' + date + ':' + (url.searchParams.get('count') || '2');
  const cached = action === 'attendance'
    ? await readAttendanceCore(env, classId, date) || await readValue(env, cacheKey)
    : await readValue(env, cacheKey);
  const query = Object.fromEntries(url.searchParams.entries());
  if (cached) {
    ctx.waitUntil(refreshReadCacheInBackground(env, action, query, cacheKey));
    return jsonResponse(action === 'attendance' ? normaliseAttendanceResult(cached) : cached, 200, request, env);
  }
  const result = await importAttendance(env, action, query);
  await writeValue(env, cacheKey, result);
  await writeValue(env, 'sync:' + cacheKey, now());
  return jsonResponse(result, 200, request, env);
}

async function handlePost(request, env, ctx) {
  const payload = await request.json();
  const action = String(payload.action || '');
  if (!['saveClasses', 'saveClass', 'addMember', 'removeMember', 'removeClass', 'saveAttendance'].includes(action)) {
    return jsonResponse({ ok: false, error: 'Unknown action' }, 400, request, env);
  }

  const classId = String(payload.classId || payload.class?.id || '').trim();
  const date = String(payload.date || '').trim();
  if (action === 'saveAttendance' && (!classId || !date || !Array.isArray(payload.members))) {
    return jsonResponse({ ok: false, error: 'Invalid attendance payload' }, 400, request, env);
  }
  if (action !== 'saveClasses' && action !== 'saveAttendance' && !classId) {
    return jsonResponse({ ok: false, error: 'Missing classId' }, 400, request, env);
  }
  const lock = await acquireMutationLock(env, action === 'saveAttendance' ? `attendance:${classId}:${date}` : 'state');
  try {
    const current = await getOrBootstrapState(env);
    if (action === 'saveAttendance') {
      const operationId = String(payload.operationId || id());
      const previousAttendance = await readAttendanceCore(env, classId, date);
      const previousByName = new Map((previousAttendance?.members || []).map(member => [String(member.name || '').toLocaleLowerCase('pt-PT'), member.status]));
      const attendance = {
        ok: true,
        classId,
        className: payload.className || '',
        date,
        members: Array.isArray(payload.members) ? payload.members.map(member => ({
          ...member,
          status: normaliseAttendanceStatus(member.status) === 'pending' && previousByName.has(String(member.name || '').toLocaleLowerCase('pt-PT'))
            ? normaliseAttendanceStatus(previousByName.get(String(member.name || '').toLocaleLowerCase('pt-PT')))
            : normaliseAttendanceStatus(member.status)
        })) : [],
        filled: true,
        operationId
      };
      await invalidateClassCaches(env, classId);
      await writeAttendanceCore(env, attendance);
      await writeValue(env, 'attendance:' + classId + ':' + date, attendance);
      await queueSheetsWrite(env, { ...payload, operationId });
      ctx.waitUntil(scheduleFlush(env));
      return jsonResponse({ ok: true, attendance }, 200, request, env);
    }

    const mutation = applyClassMutation(current, payload);
    if (!mutation.result.ok) return jsonResponse(mutation.result, 400, request, env);
    if (action === 'saveClasses') await invalidateAllAttendanceCaches(env);
    else await invalidateClassCaches(env, classId);
    if (action === 'saveClasses') await writeState(env, mutation.state);
    else if (action === 'removeClass') {
      await deleteClassCore(env, classId);
      await writeValue(env, STATE_KEY, normaliseState(mutation.state));
    } else {
      await writeClassCore(env, mutation.result.class);
      await writeValue(env, STATE_KEY, normaliseState(mutation.state));
    }
    await queueSheetsWrite(env, payload);
    ctx.waitUntil(scheduleFlush(env));
    return jsonResponse(mutation.result, 200, request, env);
  } finally {
    await releaseMutationLock(env, lock);
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return jsonResponse({}, 204, request, env);
    if (request.method === 'POST' && request.headers.get('Origin') !== env.ALLOWED_ORIGIN) {
      return jsonResponse({ ok: false, error: 'Origin not allowed' }, 403, request, env);
    }
    try {
      if (request.method === 'GET') return await handleGet(request, env, ctx);
      if (request.method === 'POST') return await handlePost(request, env, ctx);
      return jsonResponse({ ok: false, error: 'Method not allowed' }, 405, request, env);
    } catch (error) {
      console.error(error);
      return jsonResponse({ ok: false, error: String(error.message || error) }, 500, request, env);
    }
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(scheduleFlush(env));
  }
};
