const ALLOWED_HOSTS = new Set([
  'hansard-api.parliament.uk',
  'committees-api.parliament.uk',
  'questions-statements-api.parliament.uk',
  'members-api.parliament.uk',
]);

const corsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

export default {
  async fetch(req) {
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    if (req.method !== 'GET') {
      return new Response('GET only', { status: 405, headers: corsHeaders });
    }

    const url = new URL(req.url);
    const target = url.searchParams.get('u');
    if (!target) {
      return new Response('missing ?u=', { status: 400, headers: corsHeaders });
    }

    let upstream;
    try {
      upstream = new URL(target);
    } catch {
      return new Response('bad ?u=', { status: 400, headers: corsHeaders });
    }
    if (upstream.protocol !== 'https:' || !ALLOWED_HOSTS.has(upstream.hostname)) {
      return new Response('host not allowed', { status: 403, headers: corsHeaders });
    }

    const upstreamRes = await fetch(upstream.toString(), {
      headers: { Accept: 'application/json' },
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    const body = await upstreamRes.arrayBuffer();
    return new Response(body, {
      status: upstreamRes.status,
      headers: {
        ...corsHeaders,
        'content-type': upstreamRes.headers.get('content-type') || 'application/json',
        'cache-control': 'public, max-age=300',
      },
    });
  },
};
