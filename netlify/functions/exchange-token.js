// netlify/functions/exchange-token.js
// Exchanges OAuth2 authorization code for access token using PKCE
// PKCE public clients do NOT need a client_secret — the code_verifier IS the proof

const DERIV_TOKEN_URL = 'https://auth.deriv.com/oauth2/token';
const CLIENT_ID       = '32P7P7Js60xbi0ISjpAyK';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',               // Allow from Netlify domain
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  /* Pre-flight */
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  /* Parse body */
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { code, code_verifier, redirect_uri } = body;

  if (!code) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Missing "code" field' }) };
  }

  /* Build form body — PKCE public flow (no client_secret) */
  const form = new URLSearchParams();
  form.set('grant_type',   'authorization_code');
  form.set('client_id',    CLIENT_ID);
  form.set('code',         code);
  form.set('redirect_uri', redirect_uri || 'https://princefx26.netlify.app/callback');
  if (code_verifier) form.set('code_verifier', code_verifier);

  console.log('[exchange-token] Requesting token from Deriv…');

  let resp;
  try {
    resp = await fetch(DERIV_TOKEN_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    form.toString(),
    });
  } catch (err) {
    console.error('[exchange-token] Fetch error:', err.message);
    return {
      statusCode: 502,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Could not reach Deriv token endpoint: ' + err.message }),
    };
  }

  let tokenData;
  try {
    tokenData = await resp.json();
  } catch {
    const text = await resp.text().catch(() => '');
    console.error('[exchange-token] Non-JSON response:', text);
    return {
      statusCode: 502,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Non-JSON response from Deriv', raw: text.slice(0, 300) }),
    };
  }

  console.log('[exchange-token] Deriv responded with status', resp.status);

  if (!resp.ok || tokenData.error) {
    const msg = tokenData.error_description || tokenData.error || ('HTTP ' + resp.status);
    console.error('[exchange-token] Error from Deriv:', msg);
    return {
      statusCode: resp.ok ? 400 : resp.status,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: msg }),
    };
  }

  if (!tokenData.access_token) {
    console.error('[exchange-token] No access_token in response:', JSON.stringify(tokenData));
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Deriv returned success but no access_token', raw: JSON.stringify(tokenData) }),
    };
  }

  /* Success — return only what the client needs */
  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({
      access_token: tokenData.access_token,
      expires_in:   tokenData.expires_in   || 3600,
      token_type:   tokenData.token_type   || 'Bearer',
      scope:        tokenData.scope        || '',
    }),
  };
};
