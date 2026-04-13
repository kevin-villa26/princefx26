// netlify/functions/exchange-token.js
// Exchanges OAuth authorization code for access token (PKCE flow)
// Must run server-side to avoid CORS and keep client_secret secure

const DERIV_TOKEN_ENDPOINT = 'https://oauth.deriv.com/oauth2/token';
const CLIENT_ID = '32P7P7Js60xbi0ISjpAyK';

exports.handler = async (event) => {
  // Allow CORS from our app
  const headers = {
    'Access-Control-Allow-Origin': 'https://princefx26.netlify.app',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { code, code_verifier, redirect_uri } = body;

  if (!code || !code_verifier || !redirect_uri) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Missing required fields: code, code_verifier, redirect_uri' })
    };
  }

  try {
    const formData = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      code_verifier,
      redirect_uri
    });

    const response = await fetch(DERIV_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString()
    });

    const tokenData = await response.json();

    if (!response.ok || tokenData.error) {
      console.error('Token exchange failed:', tokenData);
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: tokenData.error_description || tokenData.error || 'Token exchange failed' })
      };
    }

    // Return access token (never log it)
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        access_token: tokenData.access_token,
        expires_in: tokenData.expires_in,
        token_type: tokenData.token_type
      })
    };

  } catch (err) {
    console.error('Function error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal server error: ' + err.message })
    };
  }
};
