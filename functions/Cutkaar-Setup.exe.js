import { count, shouldCount } from './_count.js';
// Serves the installer exactly as before and counts the download in the background.
export async function onRequest(context) {
  const { request, env } = context;
  const res = await env.ASSETS.fetch(request);
  if (res.ok && shouldCount(request)) context.waitUntil(count(env, request, 'download'));
  return res;
}
