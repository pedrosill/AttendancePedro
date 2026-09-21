const MAX_IMAGE_BYTES = 1024 * 1024;

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  if (!origin || origin !== env.ALLOWED_ORIGIN) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Credentials': 'true',
    Vary: 'Origin'
  };
}

function response(body, init, request, env) {
  const headers = new Headers(init && init.headers);
  Object.entries(corsHeaders(request, env)).forEach(([key, value]) => headers.set(key, value));
  return new Response(body, { ...init, headers });
}

async function authorised(request, env, ctx) {
  const allowedEmails = String(env.ACCESS_EMAILS || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  let email = String(request.headers.get('Cf-Access-Authenticated-User-Email') || '').trim().toLowerCase();
  if (!email && ctx?.access?.getIdentity) {
    try {
      const identity = await ctx.access.getIdentity();
      email = String(identity?.email || '').trim().toLowerCase();
    } catch {
      email = '';
    }
  }
  return allowedEmails.length > 0 && allowedEmails.includes(email);
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

    // This Worker must be served only through a Cloudflare Access protected route.
    if (!(await authorised(request, env, ctx))) return response(JSON.stringify({ ok: false, error: 'Access denied' }), { status: 403, headers: { 'Content-Type': 'application/json' } }, request, env);

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

    if (request.method === 'PUT') {
      if (request.headers.get('Content-Type') !== 'image/webp') {
        return response(JSON.stringify({ ok: false, error: 'Only WebP images are accepted' }), { status: 415, headers: { 'Content-Type': 'application/json' } }, request, env);
      }
      const image = await request.arrayBuffer();
      if (image.byteLength === 0 || image.byteLength > MAX_IMAGE_BYTES || !isWebp(image)) {
        return response(JSON.stringify({ ok: false, error: 'Invalid image' }), { status: 400, headers: { 'Content-Type': 'application/json' } }, request, env);
      }
      await env.MEMBER_PHOTOS.put(key, image, { httpMetadata: { contentType: 'image/webp' } });
      return response(JSON.stringify({ ok: true, photoKey: key }), { status: 201, headers: { 'Content-Type': 'application/json' } }, request, env);
    }

    if (request.method === 'DELETE') {
      await env.MEMBER_PHOTOS.delete(key);
      return response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }, request, env);
    }

    return response(JSON.stringify({ ok: false, error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } }, request, env);
  }
};
