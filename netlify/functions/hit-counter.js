// netlify/functions/hit-counter.js
//
// A minimal, dependency-free hit counter using Netlify Blobs -- deliberately
// NOT using the official @netlify/blobs npm package, since its compiled
// build pulls in @netlify/otel and @netlify/runtime-utils at require()
// time and needs Node >=22.12, neither of which could be verified safe for
// this drag-and-drop deploy (no npm install step runs). A failure in a
// shared dependency there would have broken every other function too.
//
// This version's protocol was confirmed by downloading the real
// @netlify/blobs package (v11.0.3) from npm and reading its compiled
// dist/main.cjs directly -- not guessed, and not re-guessed from an
// earlier, incorrect attempt. Two things that attempt got wrong:
//
//   1. siteID does NOT come from a NETLIFY_SITE_ID env var (that var isn't
//      set in this context at all) -- it comes from the incoming Lambda
//      event's `x-nf-site-id` header.
//   2. Lambda-compatible functions (this invocation style) get "edge"
//      access, not "API" access -- a single direct authenticated
//      request to the URL Netlify hands you in `event.blobs`, not the
//      two-step "get a signed URL, then fetch that" dance the API-access
//      mode uses. That two-step protocol is real, just for a different
//      access mode than this function actually gets.
//
// Source (connectLambda + Client#getFinalRequest, edge branch):
// https://github.com/netlify/blobs -- dist/main.cjs in the npm package.

const STORE_NAME = 'weather-history-probability-meta';
const KEY = 'hit-count';

function getBlobsAuth(event) {
  if (!event || !event.blobs || !event.headers) return {};
  try {
    const data = JSON.parse(Buffer.from(event.blobs, 'base64').toString('utf8'));
    return {
      siteID: event.headers['x-nf-site-id'],
      token: data.token,
      edgeURL: data.url,
    };
  } catch (err) {
    return {};
  }
}

async function blobsRequest(method, { siteID, token, edgeURL }, key, body) {
  const url = new URL(`/${siteID}/${STORE_NAME}/${key}`, edgeURL).toString();
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'text/plain' } : {}),
    },
    body,
  });

  if (res.status === 404) return null; // key doesn't exist yet (get) or fine to ignore (put)
  if (!res.ok) throw new Error(`Blobs ${method.toUpperCase()} failed (HTTP ${res.status})`);
  return method === 'get' ? res.text() : null;
}

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  try {
    const auth = getBlobsAuth(event);
    if (!auth.siteID || !auth.token || !auth.edgeURL) {
      // Fails harmlessly -- the front-end just won't show a count.
      return { statusCode: 200, headers, body: JSON.stringify({ count: null, note: 'Blobs auth unavailable in this function context' }) };
    }

    const current = await blobsRequest('get', auth, KEY);
    let count = current !== null ? parseInt(current, 10) : 0;
    if (isNaN(count)) count = 0;
    count += 1;

    await blobsRequest('put', auth, KEY, String(count));

    return { statusCode: 200, headers, body: JSON.stringify({ count }) };
  } catch (err) {
    return { statusCode: 200, headers, body: JSON.stringify({ count: null, error: err.message }) };
  }
};
