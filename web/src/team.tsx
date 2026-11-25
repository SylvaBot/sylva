// The Team card on Settings: the owner adds people by their Twitch name and
// picks what each may do. The rules match crates/sylva-core/src/team.rs.

import { useEffect, useState } from 'react';
import { api, type TeamMember, type TeamView } from './api';
import { ROLE_NAMES, useChannel } from './channel';
import { Card } from './pages';
import { Avatar, errorText, Icon, useToast } from './ui';

const ROLES: { id: TeamMember['role']; what: string }[] = [
  { id: 'editor', what: 'Changes everything except the team and the overlay link' },
  { id: 'moderator', what: 'Runs the alert queue, points, the store queue, giveaways, quotes and counters' },
  { id: 'viewer', what: 'Sees every page and changes nothing' },
];

/** "an editor", "a moderator", "a viewer". */
const aRole = (r: TeamMember['role']) => (r === 'editor' ? 'an editor' : `a ${r}`);

export function TeamCard() {
  const ch = useChannel();
  const toast = useToast();
  const [view, setView] = useState<TeamView | null>(null);
  const [failed, setFailed] = useState(false);
  const [login, setLogin] = useState('');
  const [role, setRole] = useState<TeamMember['role']>('moderator');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    api.team(ch.key).then(setView).catch(() => setFailed(true));
  }, [ch.key]);

  const run = async (id: string, fn: () => Promise<TeamView>, ok: string | ((v: TeamView) => string)) => {
    setBusy(id);
    try {
      const v = await fn();
      setView(v);
      toast(typeof ok === 'string' ? ok : ok(v));
      return true;
    } catch (x) {
      toast(errorText(x), true);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const add = async () => {
    const name = login.trim().replace(/^@/, '');
    const shown = (v: TeamView) => v.team.find((m) => m.login === name.toLowerCase())?.name ?? name;
    if (await run('add', () => api.setTeammate(ch.key, name, role), (v) => `${shown(v)} is now ${aRole(role)}`)) setLogin('');
  };

  const full = !!view && view.team.length >= view.max;
  return (
    <Card
      id="team"
      title="Team"
      desc="People who help run your channel. Each signs in to Sylva with their own Twitch account and sees your channel next to theirs."
    >
      <ul className="role-key">
        {ROLES.map((r) => <li key={r.id}><b>{ROLE_NAMES[r.id]}</b>{r.what}</li>)}
      </ul>
      {failed && !view && <div className="card-body"><p className="card-text">Could not load your team. Refresh to try again.</p></div>}
      {view && (
        view.team.length === 0
          ? <p className="empty"><Icon id="users" />Nobody yet. Add a moderator or an editor below.</p>
          : (
            <ul className="types team-list">
              {view.team.map((m) => (
                <li key={m.id} className="type">
                  <div className="type-row">
                    <Avatar name={m.name} url={m.avatar} />
                    <div className="type-main">
                      <b>{m.name}</b>
                      <span>twitch.tv/{m.login}{m.joined ? '' : ' · Has not signed in to Sylva yet'}</span>
                    </div>
                    <label className="sr-only" htmlFor={`team-role-${m.id}`}>Role for {m.name}</label>
                    <select
                      id={`team-role-${m.id}`}
                      className="select team-role"
                      value={m.role}
                      disabled={busy !== null}
                      onChange={(e) => {
                        const r = e.target.value as TeamMember['role'];
                        void run(m.id, () => api.setTeammate(ch.key, m.login, r), `${m.name} is now ${aRole(r)}`);
                      }}
                    >
                      {ROLES.map((r) => <option key={r.id} value={r.id}>{ROLE_NAMES[r.id]}</option>)}
                    </select>
                    <button
                      className="btn sm ghost danger"
                      type="button"
                      disabled={busy !== null}
                      aria-label={`Remove ${m.name} from the team`}
                      onClick={() => void run(m.id, () => api.removeTeammate(ch.key, m.id), `${m.name} was removed. Add them again any time.`)}
                    >
                      Remove
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )
      )}
      <form className="card-body team-add" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <label className="field" htmlFor="team-login">
          Twitch name
          <input
            id="team-login"
            className="input"
            maxLength={26}
            autoComplete="off"
            spellCheck={false}
            placeholder="their_twitch_name"
            value={login}
            onChange={(e) => setLogin(e.target.value)}
          />
        </label>
        <label className="field" htmlFor="team-new-role">
          Role
          <select id="team-new-role" className="select" value={role} onChange={(e) => setRole(e.target.value as TeamMember['role'])}>
            {ROLES.map((r) => <option key={r.id} value={r.id}>{ROLE_NAMES[r.id]}</option>)}
          </select>
        </label>
        <button className="btn primary" type="submit" disabled={busy !== null || !login.trim() || full || !view}>
          {busy === 'add' ? 'Adding' : 'Add to team'}
        </button>
        {full && <p className="field-hint">A team can have up to {view?.max} people. Remove someone to add another.</p>}
      </form>
    </Card>
  );
}
