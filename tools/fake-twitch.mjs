// A small fake of the Twitch endpoints Sylva calls, for tests. Start the
// Worker with `npm run dev:test` so it talks to this instead of Twitch.
//
//   node tools/fake-twitch.mjs          # runs on :8788 until stopped
//   import { startFakeTwitch } from './fake-twitch.mjs'   # from a test
//
// It knows one streamer (FAKE_USER below). The authorize page approves at
// once and sends the browser back, so a test or a browser can sign in with no
// Twitch account. A test signs in as someone else by setting `state.as` to
// one of `state.users`.
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
export const MOD_SCOPES = ['moderator:manage:chat_messages', 'moderator:manage:banned_users'];
export const LOYALTY_SCOPES = ['moderator:read:chatters'];

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
    // Chat lines Sylva's bot sent.
    chatSent: [],
    // Scopes authorize may grant: what was asked for, limited to these.
    // Tests narrow it to check "scopes".
    grant: [...SCOPES, ...MOD_SCOPES, ...LOYALTY_SCOPES],
    refreshTokens: new Map(), // refresh token -> scopes
    // Seconds new user tokens last. A test sets 0 to make Sylva refresh.
    tokenTtl: 14000,
    // Deletes, timeouts and unbans, as Sylva asked for them.
    modActions: [],
    banned: new Set(),
    // Who is in each channel's chat: broadcaster id -> [{ user_id, user_login, user_name }].
    chatters: new Map(),
    // Twitch users besides FAKE_USER, found by login: login -> { id, login, display_name }.
    users: new Map(),
    // Who the next sign in is, when not FAKE_USER: one of `users`.
    as: null,
    tokenUsers: new Map(), // token -> user
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

  const issue = (scopes, user = FAKE_USER) => {
    const token = 'user-' + randomUUID();
    const refresh = 'refresh-' + randomUUID();
    state.userTokens.set(token, scopes);
    state.tokenUsers.set(token, user);
    state.refreshTokens.set(refresh, scopes);
    return { access_token: token, refresh_token: refresh, expires_in: state.tokenTtl,
             scope: scopes, token_type: 'bearer' };
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const auth = req.headers.authorization || '';
    const body = await readBody(req);

    // For browser runs, where the test cannot reach `state`: add a Twitch
    // user (?login=&id=) and sign in as them next, or ?login= alone to go
    // back to FAKE_USER.
    if (req.method === 'POST' && url.pathname === '/_test/as') {
      const login = (url.searchParams.get('login') || '').toLowerCase();
      const id = url.searchParams.get('id');
      if (id) state.users.set(login, { id, login, display_name: url.searchParams.get('name') || login, profile_image_url: '' });
      state.as = id ? state.users.get(login) : null;
      return json(res, 200, { as: state.as });
    }

    if (req.method === 'GET' && url.pathname === '/oauth2/authorize') {
      const redirect = new URL(url.searchParams.get('redirect_uri'));
      if (url.searchParams.get('client_id') !== CLIENT_ID) return json(res, 400, { message: 'bad client id' });
      const code = 'code-' + randomUUID();
      const asked = (url.searchParams.get('scope') || '').split(' ').filter(Boolean);
      state.codes.set(code, asked.filter((s) => state.grant.includes(s)));
      state.codeUsers = state.codeUsers || new Map();
      state.codeUsers.set(code, state.as || FAKE_USER);
      state.lastAuthorize = Object.fromEntries(url.searchParams);
      redirect.searchParams.set('code', code);
      redirect.searchParams.set('scope', state.codes.get(code).join(' '));
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
        return json(res, 200, issue(scopes, state.codeUsers.get(p.get('code'))));
      }
      if (p.get('grant_type') === 'refresh_token') {
        const scopes = state.refreshTokens.get(p.get('refresh_token'));
        if (!scopes) return json(res, 400, { status: 400, message: 'Invalid refresh token' });
        state.refreshTokens.delete(p.get('refresh_token'));
        return json(res, 200, issue(scopes));
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
      const user = state.tokenUsers.get(token) || FAKE_USER;
      return json(res, 200, { client_id: CLIENT_ID, login: user.login, scopes,
                              user_id: user.id, expires_in: 14000 });
    }

    // Helix: needs a Client-Id and a token Twitch knows.
    if (url.pathname.startsWith('/helix/')) {
      const token = auth.replace(/^Bearer /, '');
      if (req.headers['client-id'] !== CLIENT_ID) return json(res, 401, { message: 'bad client id' });
      const isApp = token === 'app-token';
      if (!isApp && !state.userTokens.has(token)) return json(res, 401, { message: 'invalid token' });
      const path = url.pathname.slice('/helix'.length);

      if (req.method === 'GET' && path === '/users') {
        const logins = url.searchParams.getAll('login').map((l) => l.toLowerCase());
        const ids = url.searchParams.getAll('id');
        if (!logins.length && !ids.length) {
          if (isApp) return json(res, 400, { message: 'login or id required' });
          return json(res, 200, { data: [state.tokenUsers.get(token) || FAKE_USER] });
        }
        const known = [FAKE_USER, ...state.users.values()];
        return json(res, 200, { data: known.filter((u) => logins.includes(u.login) || ids.includes(u.id)) });
      }
      if (req.method === 'GET' && path === '/chat/chatters') {
        if (isApp) return json(res, 401, { message: 'user token required' });
        if (!state.userTokens.get(token).includes(LOYALTY_SCOPES[0])) return json(res, 401, { message: 'missing scope ' + LOYALTY_SCOPES[0] });
        const q = Object.fromEntries(url.searchParams);
        if (!q.broadcaster_id || !q.moderator_id) return json(res, 400, { message: 'missing ids' });
        const all = state.chatters.get(q.broadcaster_id) || [];
        const first = Number(q.first || 100);
        const from = Number(q.after || 0);
        const data = all.slice(from, from + first);
        const next = from + first < all.length ? String(from + first) : undefined;
        return json(res, 200, { data, pagination: next ? { cursor: next } : {}, total: all.length });
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
      if (req.method === 'POST' && path === '/chat/messages') {
        // Sent with the app token, as Sylva's bot does.
        if (!isApp) return json(res, 400, { message: 'expected the app token' });
        const m = JSON.parse(body);
        if (!m.broadcaster_id || !m.sender_id || !m.message) return json(res, 400, { message: 'missing fields' });
        const id = randomUUID();
        state.chatSent.push({ ...m, message_id: id });
        return json(res, 200, { data: [{ message_id: id, is_sent: true }] });
      }
      if (path === '/moderation/chat' || path === '/moderation/bans') {
        // Moderation needs the moderator's own token with the right scope.
        if (isApp) return json(res, 401, { message: 'user token required' });
        const need = path === '/moderation/chat' ? MOD_SCOPES[0] : MOD_SCOPES[1];
        if (!state.userTokens.get(token).includes(need)) return json(res, 401, { message: 'missing scope ' + need });
        const q = Object.fromEntries(url.searchParams);
        if (!q.broadcaster_id || !q.moderator_id) return json(res, 400, { message: 'missing ids' });
        if (req.method === 'DELETE' && path === '/moderation/chat') {
          state.modActions.push({ type: 'delete', ...q });
          res.writeHead(204);
          return res.end();
        }
        if (req.method === 'POST') {
          const { data } = JSON.parse(body);
          if (!data?.user_id) return json(res, 400, { message: 'missing user_id' });
          state.banned.add(data.user_id);
          state.modActions.push({ type: 'timeout', ...q, ...data });
          return json(res, 200, { data: [{ broadcaster_id: q.broadcaster_id, moderator_id: q.moderator_id,
                                           user_id: data.user_id, created_at: new Date().toISOString(), end_time: null }] });
        }
        if (req.method === 'DELETE') {
          if (!state.banned.delete(q.user_id)) return json(res, 400, { status: 400, message: 'The user specified in the user_id field is not banned.' });
          state.modActions.push({ type: 'unban', ...q });
          res.writeHead(204);
          return res.end();
        }
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
