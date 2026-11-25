// A small fake of the Twitch endpoints Sylva calls, for tests. Start the
// Worker with `npm run dev:test` so it talks to this instead of Twitch.
//
//   node tools/fake-twitch.mjs          # runs on :8788 until stopped
//   import { startFakeTwitch } from './fake-twitch.mjs'   # from a test
//
// It knows one streamer (FAKE_USER below). The authorize page approves at
// once and sends the browser back, so a test or a browser can sign in with no
// Twitch account.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

export const FAKE_PORT = Number(process.env.FAKE_TWITCH_PORT || 8788);
export const FAKE_USER = {
  id: '424242', login: 'sylvatester', display_name: 'SylvaTester',
  profile_image_url: '',
};
const CLIENT_ID = 't9z14i1qdp044der47bq7lpu5w0eru';
const CLIENT_SECRET = 'local-dev-client-secret';
const SCOPES = ['moderator:read:followers', 'channel:read:subscriptions', 'bits:read',
                'user:read:chat', 'user:bot', 'channel:bot'];

export function startFakeTwitch(port = FAKE_PORT) {
  const state = {
    subscriptions: [],
    codes: new Map(),     // code -> scopes granted
    userTokens: new Map(), // token -> scopes
    tokenRequests: [],
    // Set to a status (such as 403) to make every subscription request fail.
    failSubscriptions: null,
    // Set to a status (such as 503) to make deleting subscriptions fail.
    failDeletes: null,
    revoked: [],
    // Scopes the next authorize grants. Tests narrow it to check "scopes".
    grant: SCOPES,
  };

  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) => new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => resolve(b));
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const auth = req.headers.authorization || '';
    const body = await readBody(req);

    if (req.method === 'GET' && url.pathname === '/oauth2/authorize') {
      const redirect = new URL(url.searchParams.get('redirect_uri'));
      if (url.searchParams.get('client_id') !== CLIENT_ID) return json(res, 400, { message: 'bad client id' });
      const code = 'code-' + randomUUID();
      state.codes.set(code, state.grant);
      state.lastAuthorize = Object.fromEntries(url.searchParams);
      redirect.searchParams.set('code', code);
      redirect.searchParams.set('scope', state.grant.join(' '));
      redirect.searchParams.set('state', url.searchParams.get('state'));
      res.writeHead(302, { Location: redirect.toString() });
      return res.end();
    }

    if (req.method === 'POST' && url.pathname === '/oauth2/token') {
      const p = new URLSearchParams(body);
      state.tokenRequests.push(Object.fromEntries(p));
      if (p.get('client_id') !== CLIENT_ID || p.get('client_secret') !== CLIENT_SECRET) {
        return json(res, 403, { status: 403, message: 'invalid client secret' });
      }
      if (p.get('grant_type') === 'client_credentials') {
        return json(res, 200, { access_token: 'app-token', expires_in: 5000000, token_type: 'bearer' });
      }
      if (p.get('grant_type') === 'authorization_code') {
        const scopes = state.codes.get(p.get('code'));
        if (!scopes) return json(res, 400, { status: 400, message: 'Invalid authorization code' });
        state.codes.delete(p.get('code'));
        const token = 'user-' + randomUUID();
        state.userTokens.set(token, scopes);
        return json(res, 200, { access_token: token, refresh_token: 'refresh-' + randomUUID(),
                                expires_in: 14000, scope: scopes, token_type: 'bearer' });
      }
      return json(res, 400, { message: 'unsupported grant' });
    }

    if (req.method === 'POST' && url.pathname === '/oauth2/revoke') {
      const p = new URLSearchParams(body);
      if (p.get('client_id') !== CLIENT_ID) return json(res, 400, { status: 400, message: 'Invalid client' });
      if (!state.userTokens.delete(p.get('token'))) return json(res, 400, { status: 400, message: 'Invalid token' });
      state.revoked.push(p.get('token'));
      res.writeHead(200);
      return res.end();
    }

    if (req.method === 'GET' && url.pathname === '/oauth2/validate') {
      const token = auth.replace(/^OAuth /, '');
      const scopes = state.userTokens.get(token);
      if (!scopes) return json(res, 401, { status: 401, message: 'invalid access token' });
      return json(res, 200, { client_id: CLIENT_ID, login: FAKE_USER.login, scopes,
                              user_id: FAKE_USER.id, expires_in: 14000 });
    }

    // Helix: needs a Client-Id and a token Twitch knows.
    if (url.pathname.startsWith('/helix/')) {
      const token = auth.replace(/^Bearer /, '');
      if (req.headers['client-id'] !== CLIENT_ID) return json(res, 401, { message: 'bad client id' });
      const isApp = token === 'app-token';
      if (!isApp && !state.userTokens.has(token)) return json(res, 401, { message: 'invalid token' });
      const path = url.pathname.slice('/helix'.length);

      if (req.method === 'GET' && path === '/users') {
        if (isApp && !url.searchParams.get('login')) return json(res, 400, { message: 'login required' });
        return json(res, 200, { data: [FAKE_USER] });
      }
      if (req.method === 'GET' && path === '/eventsub/conduits') {
        return json(res, 200, { data: [{ id: 'fake-conduit', shard_count: 1 }] });
      }
      if (req.method === 'POST' && path === '/eventsub/subscriptions') {
        if (!isApp) return json(res, 400, { message: 'conduits need an app token' });
        if (state.failSubscriptions) return json(res, state.failSubscriptions, { message: 'subscription missing proper authorization' });
        const s = JSON.parse(body);
        const same = state.subscriptions.find((x) => x.type === s.type
          && JSON.stringify(x.condition) === JSON.stringify(s.condition));
        if (same) return json(res, 409, { status: 409, message: 'subscription already exists' });
        const sub = { id: randomUUID(), status: 'enabled', type: s.type, version: s.version,
                      condition: s.condition, transport: s.transport, created_at: new Date().toISOString(), cost: 0 };
        state.subscriptions.push(sub);
        return json(res, 202, { data: [sub], total: state.subscriptions.length });
      }
      if (req.method === 'GET' && path === '/eventsub/subscriptions') {
        const uid = url.searchParams.get('user_id');
        const data = state.subscriptions.filter((s) => !uid || Object.values(s.condition).includes(uid));
        return json(res, 200, { data, total: data.length, pagination: {} });
      }
      if (req.method === 'DELETE' && path === '/eventsub/subscriptions') {
        if (!isApp) return json(res, 401, { message: 'app token required' });
        if (state.failDeletes) return json(res, state.failDeletes, { message: 'try again' });
        const i = state.subscriptions.findIndex((s) => s.id === url.searchParams.get('id'));
        if (i < 0) return json(res, 404, { message: 'subscription not found' });
        state.subscriptions.splice(i, 1);
        res.writeHead(204);
        return res.end();
      }
      return json(res, 404, { message: 'not faked: ' + path });
    }

    json(res, 404, { message: 'not found' });
  });

  return new Promise((resolve) => {
    server.listen(port, () => resolve({ state, close: () => new Promise((r) => server.close(r)) }));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await startFakeTwitch();
  console.log(`Fake Twitch on http://localhost:${FAKE_PORT} (user ${FAKE_USER.login}, id ${FAKE_USER.id})`);
}
