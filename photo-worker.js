const MAX_IMAGE_BYTES = 1024 * 1024;

function base64UrlDecode(value) {
  const text = String(value || '');
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

async function authKey(env) {
  if (!env.APP_AUTH_SECRET) throw new Error('APP_AUTH_SECRET not configured');
  return crypto.subtle.importKey('raw', new TextEncoder().encode(env.APP_AUTH_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
}

async function authenticated(request, env) {
  try {
    const authorization = request.headers.get('Authorization') || '';
    const token = authorization.startsWith('Bearer ')
      ? authorization.slice(7).trim()
      : new URL(request.url).searchParams.get('token');
    const [payload, signature] = String(token || '').split('.');
    if (!payload || !signature) return false;
    const valid = await crypto.subtle.verify('HMAC', await authKey(env), base64UrlDecode(signature), new TextEncoder().encode(payload));
    if (!valid) return false;
    const details = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)));
    return Number(details.expiresAt || 0) > Date.now();
  } catch {
    return false;
  }
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  if (!origin || origin !== env.ALLOWED_ORIGIN) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    Vary: 'Origin'
  };
}

function response(body, init, request, env) {
  const headers = new Headers(init && init.headers);
  Object.entries(corsHeaders(request, env)).forEach(([key, value]) => headers.set(key, value));
  return new Response(body, { ...init, headers });
}

function photoIds(pathname) {
  const match = pathname.match(/^\/photos\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)$/);
  return match ? { classId: match[1], memberId: match[2] } : null;
}

function isWebp(bytes) {
  const view = new Uint8Array(bytes);
  return view.length >= 12 && String.fromCharCode(...view.slice(0, 4)) === 'RIFF' && String.fromCharCode(...view.slice(8, 12)) === 'WEBP';
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return response(null, { status: 204 }, request, env);

    const ids = photoIds(new URL(request.url).pathname);
    if (!ids) return response(JSON.stringify({ ok: false, error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } }, request, env);

    if (!(await authenticated(request, env))) return response(JSON.stringify({ ok: false, error: 'Authentication required' }), { status: 401, headers: { 'Content-Type': 'application/json' } }, request, env);

    const key = `photos/${ids.classId}/${ids.memberId}.webp`;
    if (request.method === 'GET') {
      const object = await env.MEMBER_PHOTOS.get(key);
      if (!object) return response(JSON.stringify({ ok: false, error: 'Photo not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } }, request, env);
      const headers = {
        'Content-Type': object.httpMetadata?.contentType || 'image/webp',
        'Cache-Control': 'private, max-age=86400'
      };
      if (object.httpEtag) headers.ETag = object.httpEtag;
      return response(object.body, {
        headers
      }, request, env);
    }

    const action = new URL(request.url).searchParams.get('action');
    if (request.method === 'PUT' || (request.method === 'POST' && action !== 'delete')) {
      const contentType = String(request.headers.get('Content-Type') || '').split(';')[0].toLowerCase();
      if (contentType !== 'image/webp' && contentType !== 'text/plain') {
        return response(JSON.stringify({ ok: false, error: 'Only WebP images are accepted' }), { status: 415, headers: { 'Content-Type': 'application/json' } }, request, env);
      }
      const image = await request.arrayBuffer();
      if (image.byteLength === 0 || image.byteLength > MAX_IMAGE_BYTES || !isWebp(image)) {
        return response(JSON.stringify({ ok: false, error: 'Invalid image' }), { status: 400, headers: { 'Content-Type': 'application/json' } }, request, env);
      }
      await env.MEMBER_PHOTOS.put(key, image, { httpMetadata: { contentType: 'image/webp' } });
      return response(JSON.stringify({ ok: true, photoKey: key }), { status: 201, headers: { 'Content-Type': 'application/json' } }, request, env);
    }

    if (request.method === 'DELETE' || (request.method === 'POST' && action === 'delete')) {
      await env.MEMBER_PHOTOS.delete(key);
      return response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }, request, env);
    }

    return response(JSON.stringify({ ok: false, error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } }, request, env);
  }
};
