const STATE_KEY = 'state';
const STATE_SYNC_KEY = 'state:last-sync';
const CACHE_MAX_AGE_MS = 60 * 1000;
const MAX_OUTBOX_ATTEMPTS = 5;
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

async function readValue(env, key) {
  const row = await env.DB.prepare('SELECT value FROM kv WHERE key = ?').bind(key).first();
  return row ? JSON.parse(row.value) : null;
}

async function writeValue(env, key, value) {
  await env.DB.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .bind(key, JSON.stringify(value), now()).run();
}

async function readState(env) { return readValue(env, STATE_KEY); }
async function writeState(env, state) { return writeValue(env, STATE_KEY, normaliseState(state)); }

async function sheetsRequest(env, action, init = {}) {
  const separator = env.SHEETS_API_URL.includes('?') ? '&' : '?';
  const url = action ? env.SHEETS_API_URL + separator + 'action=' + encodeURIComponent(action) : env.SHEETS_API_URL;
  const response = await fetch(url, {
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
  try { await importStateFromSheets(env); }
  catch (error) { console.error('Background state sync failed:', error); }
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
  const response = await fetch(env.SHEETS_API_URL + separator + params.toString(), { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error('Sheets HTTP ' + response.status);
  const result = await response.json();
  if (!result || result.ok !== true) throw new Error(result?.error || 'Sheets returned an error');
  return action === 'attendance' ? normaliseAttendanceResult(result) : result;
}

async function claimOutboxRow(env) {
  const lockToken = id();
  const lockedUntil = now() + 60 * 1000;
  const row = await env.DB.prepare('SELECT id, payload, attempts FROM outbox WHERE attempts < ? AND (locked_until IS NULL OR locked_until < ?) ORDER BY created_at, id LIMIT 1')
    .bind(MAX_OUTBOX_ATTEMPTS, now()).first();
  if (!row) return null;
  const claimed = await env.DB.prepare('UPDATE outbox SET locked_until = ?, lock_token = ? WHERE id = ? AND attempts < ? AND (locked_until IS NULL OR locked_until < ?)')
    .bind(lockedUntil, lockToken, row.id, MAX_OUTBOX_ATTEMPTS, now()).run();
  if (Number(claimed?.meta?.changes || 0) !== 1) return null;
  return { ...row, lockToken };
}

async function flushOutbox(env) {
  for (let index = 0; index < 10; index += 1) {
    const row = await claimOutboxRow(env);
    if (!row) break;
    try {
      await sheetsRequest(env, '', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: row.payload
      });
      await env.DB.prepare('DELETE FROM outbox WHERE id = ? AND lock_token = ?').bind(row.id, row.lockToken).run();
    } catch (error) {
      await env.DB.prepare('UPDATE outbox SET attempts = attempts + 1, last_error = ?, locked_until = NULL, lock_token = NULL WHERE id = ? AND lock_token = ?')
        .bind(String(error), row.id, row.lockToken).run();
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
  await env.DB.prepare('INSERT INTO outbox (payload, created_at) VALUES (?, ?)').bind(JSON.stringify(payload), now()).run();
}

async function deleteCacheKeys(env, matches) {
  const rows = await env.DB.prepare('SELECT key FROM kv').all();
  const keys = (rows.results || [])
    .map(row => String(row.key || ''))
    .filter(key => matches.some(prefix => key.startsWith(prefix)));
  if (!keys.length) return;
  await env.DB.batch(keys.map(key => env.DB.prepare('DELETE FROM kv WHERE key = ?').bind(key)));
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
    await writeValue(env, cacheKey, result);
    await writeValue(env, syncKey, now());
  } catch (error) {
    console.error('Background attendance sync failed:', error);
  }
}

async function handleGet(request, env, ctx) {
  const url = new URL(request.url);
  const action = url.searchParams.get('action') || 'state';
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
  const cached = await readValue(env, cacheKey);
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

  const current = await getOrBootstrapState(env);
  if (action === 'saveAttendance') {
    const classId = String(payload.classId || '');
    const date = String(payload.date || '');
    const attendance = {
      ok: true,
      classId,
      className: payload.className || '',
      date,
      members: Array.isArray(payload.members) ? payload.members.map(member => ({
        ...member,
        status: normaliseAttendanceStatus(member.status)
      })) : [],
      filled: true
    };
    await invalidateClassCaches(env, classId);
    await writeValue(env, 'attendance:' + classId + ':' + date, attendance);
    await queueSheetsWrite(env, payload);
    ctx.waitUntil(scheduleFlush(env));
    return jsonResponse({ ok: true, attendance }, 200, request, env);
  }

  const mutation = applyClassMutation(current, payload);
  if (!mutation.result.ok) return jsonResponse(mutation.result, 400, request, env);
  if (action === 'saveClasses') await invalidateAllAttendanceCaches(env);
  else await invalidateClassCaches(env, String(payload.classId || payload.class?.id || ''));
  await writeState(env, mutation.state);
  await queueSheetsWrite(env, payload);
  ctx.waitUntil(scheduleFlush(env));
  return jsonResponse(mutation.result, 200, request, env);
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return jsonResponse({}, 204, request, env);
    try {
      if (request.method === 'GET') return await handleGet(request, env, ctx);
      if (request.method === 'POST') return await handlePost(request, env, ctx);
      return jsonResponse({ ok: false, error: 'Method not allowed' }, 405, request, env);
    } catch (error) {
      console.error(error);
      return jsonResponse({ ok: false, error: String(error.message || error) }, 500, request, env);
    }
  }
};
