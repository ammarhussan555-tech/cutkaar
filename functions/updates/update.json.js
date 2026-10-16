import { count, shouldCount } from '../_count.js';
// The app asks for this file when it starts, to look for updates. Each request is counted as one "app opened".
export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
  const asset = await env.ASSETS.fetch(request);
  const res = new Response(asset.body, asset);
  for (const [k, v] of Object.entries(cors())) res.headers.set(k, v);
  res.headers.set('Cache-Control', 'no-cache');
  if (asset.ok && request.method === 'GET') context.waitUntil(count(env, request, 'open'));
  return res;
}
function cors() {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': '*' };
}
