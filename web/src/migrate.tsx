// Settings > Import from another service: one place to move to Sylva from
// StreamElements, Streamlabs, Nightbot, Fossabot or any bot that exports a
// spreadsheet. StreamElements keeps its own card (import.tsx). Nightbot and
// Fossabot publish each channel's commands, so they need only the channel
// name; everything else comes from a CSV file read here in the browser.

import { useState, type ChangeEvent } from 'react';
import { api, type MigrateBody, type MigrateResult } from './api';
import { useChannel } from './channel';
import { Select } from './dropdown';
import { ImportCard } from './import';
import { errorText, Row, Sect, useToast } from './ui';

type Service = 'streamelements' | 'streamlabs' | 'nightbot' | 'fossabot' | 'other';

const SERVICES: { value: Service; label: string }[] = [
  { value: 'streamelements', label: 'StreamElements' },
  { value: 'streamlabs', label: 'Streamlabs' },
  { value: 'nightbot', label: 'Nightbot' },
  { value: 'fossabot', label: 'Fossabot' },
  { value: 'other', label: 'Another bot (Moobot, Wizebot and others)' },
];

// What each service lets Sylva read, said plainly.
const HONEST: Record<Exclude<Service, 'streamelements'>, { comes: string; stays: string }> = {
  streamlabs: {
    comes: 'Past tips, loyalty points and watch time, and commands, from CSV files you download from Streamlabs. Tips land in Stats; points and watch time go to each viewer.',
    stays: 'Streamlabs does not let other apps read your Cloudbot, so nothing comes over on its own. Cloudbot commands and timers have no export: add those by hand in Bot. Alerts, overlays and Prime perks stay with Streamlabs.',
  },
  nightbot: {
    comes: 'Every command, with who can use it and its cooldown. All Sylva needs is your channel name, because Nightbot shows commands publicly.',
    stays: 'Timers, spam filters and song requests. Nightbot only shows those to you after you sign in there, and it has no loyalty points.',
  },
  fossabot: {
    comes: 'Every custom command, with its aliases and who can use it. All Sylva needs is your channel name, because Fossabot shows commands publicly.',
    stays: 'Cooldowns, timers and counters. Fossabot leaves those out of its public list, so set cooldowns again in Bot.',
  },
  other: {
    comes: 'Anything your old bot can save as a CSV file: commands, loyalty points, watch time or tip history. Sylva reads the column names and works out the rest.',
    stays: 'Moobot, Wizebot and most other bots have no way for other apps to read your settings. If yours has no export, add commands by hand in Bot.',
  },
};

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** Rows of a CSV or TSV file. Handles quotes and picks the separator. */
export function parseCsv(text: string): string[][] {
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  const sep = [',', ';', '\t'].reduce((a, b) => (first.split(b).length > first.split(a).length ? b : a), ',');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

const key = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');
const col = (head: string[], names: string[]) => {
  const k = head.map(key);
  for (const n of names) { const i = k.indexOf(n); if (i >= 0) return i; }
  for (const n of names) { const i = k.findIndex((h) => h.includes(n)); if (i >= 0) return i; }
  return -1;
};
const number = (s: string | undefined) => {
  const n = parseFloat((s ?? '').replace(/[^0-9.,-]/g, '').replace(/,(?=\d{3}\b)/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
};
const when = (s: string | undefined) => {
  const t = (s ?? '').trim();
  if (/^\d{9,13}$/.test(t)) { const n = Number(t); return n < 1e12 ? n * 1000 : n; }
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : NaN;
};
const level = (s: string | undefined): MigrateBody['commands'][number]['level'] => {
  const t = (s ?? '').toLowerCase();
  if (t.includes('owner') || t.includes('broadcaster') || t.includes('streamer') || t.includes('editor')) return 'broadcaster';
  if (t.includes('mod')) return 'moderator';
  if (t.includes('vip')) return 'vip';
  if (t.includes('sub') || t.includes('regular')) return 'subscriber';
  return 'everyone';
};

type Found = Pick<MigrateBody, 'commands' | 'points' | 'watchtime' | 'tips'>;

/** Work out what a file holds from its column names. */
export function readFile(rows: string[][]): Found {
  const out: Found = { commands: [], points: [], watchtime: [], tips: [] };
  const [head, ...body] = rows;
  if (!head) return out;
  const who = col(head, ['username', 'login', 'user', 'viewer', 'donorname', 'donor', 'from', 'displayname', 'name']);
  const amount = col(head, ['amount', 'donationamount', 'tipamount', 'total']);
  const date = col(head, ['createdat', 'date', 'datetime', 'timestamp', 'time', 'created']);
  const trigger = col(head, ['command', 'trigger', 'cmd']);
  const reply = col(head, ['response', 'reply', 'output', 'message', 'text']);
  const points = col(head, ['points', 'balance', 'loyalty', 'pts', 'currency']);
  const hours = col(head, ['hours', 'watchhours', 'hourswatched']);
  const minutes = col(head, ['minutes', 'watchtime', 'watchminutes']);
  if (amount >= 0 && date >= 0) {
    for (const r of body) {
      const a = number(r[amount]);
      const at = when(r[date]);
      if (a > 0 && at > 0) out.tips.push({ name: who >= 0 ? (r[who] ?? '').trim() : '', amount: Math.round(a * 100) / 100, at });
    }
    return out;
  }
  const name = trigger >= 0 ? trigger : reply >= 0 && points < 0 ? who : -1;
  if (name >= 0 && reply >= 0) {
    const perm = col(head, ['permission', 'userlevel', 'level', 'access', 'role']);
    const cd = col(head, ['cooldown', 'globalcooldown']);
    const ucd = col(head, ['usercooldown']);
    const alias = col(head, ['aliases', 'alias']);
    for (const r of body) {
      const n = (r[name] ?? '').trim().replace(/^!/, '');
      const text = (r[reply] ?? '').trim();
      if (!n || !text) continue;
      out.commands.push({
        name: n,
        reply: text,
        level: level(perm >= 0 ? r[perm] : ''),
        cooldown: Math.max(0, Math.round(number(cd >= 0 ? r[cd] : '0') || 0)),
        userCooldown: Math.max(0, Math.round(number(ucd >= 0 ? r[ucd] : '0') || 0)),
        aliases: alias >= 0 ? (r[alias] ?? '').split(/[\s,|]+/).map((a) => a.replace(/^!/, '')).filter(Boolean) : [],
        enabled: true,
      });
    }
    return out;
  }
  if (who < 0) return out;
  for (const r of body) {
    const login = (r[who] ?? '').trim().replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9_]{1,25}$/.test(login)) continue;
    const p = points >= 0 ? number(r[points]) : NaN;
    if (p > 0) out.points.push({ login, n: Math.round(p) });
    const m = minutes >= 0 ? number(r[minutes]) : hours >= 0 ? number(r[hours]) * 60 : NaN;
    if (m > 0) out.watchtime.push({ login, n: Math.round(m) });
  }
  return out;
}

const empty = (f: Found) => !(f.commands.length || f.points.length || f.watchtime.length || f.tips.length);

function summary(f: { commands: number; points: number; watchtime: number; tips: number }) {
  const parts = [
    f.commands && plural(f.commands, 'command'),
    f.points && `points for ${plural(f.points, 'viewer')}`,
    f.watchtime && `watch time for ${plural(f.watchtime, 'viewer')}`,
    f.tips && plural(f.tips, 'past tip'),
  ].filter(Boolean) as string[];
  if (parts.length === 0) return 'Nothing new';
  const text = parts.length === 1 ? parts[0] : parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
  return text[0].toUpperCase() + text.slice(1);
}

export function MigrateCard() {
  const [service, setService] = useState<Service>('streamelements');
  return (
    <div className="stack">
      <Sect title="Moving from" foot="Run an import as often as you like. Commands Sylva already has are left alone, and viewers keep whichever balance is higher, so nothing doubles.">
        <Row title="Service" htmlFor="migrate-service">
          <Select id="migrate-service" label="Service" value={service} options={SERVICES} onChange={setService} />
        </Row>
      </Sect>
      {service === 'streamelements' ? <ImportCard /> : <OtherImport key={service} service={service} />}
    </div>
  );
}

function OtherImport({ service }: { service: Exclude<Service, 'streamelements'> }) {
  const ch = useChannel();
  const toast = useToast();
  const label = SERVICES.find((s) => s.value === service)!.label.split(' (')[0];
  const byName = service === 'nightbot' || service === 'fossabot';
  const [login, setLogin] = useState(ch.login);
  const [files, setFiles] = useState<{ name: string; found: Found }[]>([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<MigrateResult | null>(null);
  const honest = HONEST[service];

  const pick = async (e: ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files ?? []);
    e.target.value = '';
    const read = await Promise.all(list.map(async (f) => ({ name: f.name, found: readFile(parseCsv(await f.text())) })));
    const bad = read.filter((r) => empty(r.found));
    if (bad.length) toast(`Sylva found nothing it knows in ${bad.map((b) => b.name).join(', ')}. It needs columns such as Username and Points, Command and Response, or Name, Amount and Date.`, true);
    setFiles((was) => [...was.filter((w) => !read.some((r) => r.name === w.name)), ...read.filter((r) => !empty(r.found))]);
    setDone(null);
  };

  const all: Found = {
    commands: files.flatMap((f) => f.found.commands),
    points: files.flatMap((f) => f.found.points),
    watchtime: files.flatMap((f) => f.found.watchtime),
    tips: files.flatMap((f) => f.found.tips),
  };

  const run = async () => {
    setBusy(true);
    try {
      const body: MigrateBody = byName
        ? { source: service, label, login: login.trim(), commands: [], points: [], watchtime: [], tips: [] }
        : { source: 'file', label, login: '', ...all };
      const r = await api.importOther(ch.key, body);
      setDone(r);
      setFiles([]);
      toast(`Brought over from ${label}`);
    } catch (x) {
      toast(errorText(x), true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Sect title={`What ${label} gives Sylva`}>
        <Row title="Comes over" desc={honest.comes} />
        <Row title="Stays behind" desc={honest.stays} />
      </Sect>
      {byName ? (
        <Sect title={`Your channel on ${label}`} foot="Usually the same as your Twitch name.">
          <form className="gr" onSubmit={(e) => { e.preventDefault(); void run(); }}>
            <label className="sr-only" htmlFor="migrate-login">{`Channel name on ${label}`}</label>
            <input id="migrate-login" className="input" autoComplete="off" spellCheck={false} placeholder="Channel name" value={login} onChange={(e) => setLogin(e.target.value)} style={{ flex: 1, minWidth: 0 }} />
            <button className="btn primary" type="submit" disabled={busy || !login.trim()}>{busy ? 'Bringing it over' : 'Import commands'}</button>
          </form>
        </Sect>
      ) : (
        <Sect
          title="Your exported files"
          foot={service === 'streamlabs'
            ? 'Tip history: download it as CSV from your Streamlabs dashboard. Points and watch time: export them from Streamlabs Chatbot and save the sheet as CSV. Sylva reads the files here and sends only the rows it found.'
            : 'Save each export as CSV. Sylva reads the files here and sends only the rows it found.'}
        >
          <div className="gr">
            <div className="gr-main">
              <div className="t1">{files.length ? summary({ commands: all.commands.length, points: all.points.length, watchtime: all.watchtime.length, tips: all.tips.length }) + ' found' : 'No files yet'}</div>
              <div className="t2">{files.length ? files.map((f) => f.name).join(', ') : 'CSV files with a header row. Add several at once.'}</div>
            </div>
            <div className="gr-ctl">
              <label className="btn">
                Choose files
                <input className="sr-only" type="file" accept=".csv,.tsv,.txt,text/csv" multiple onChange={(e) => void pick(e)} />
              </label>
              <button className="btn primary" type="button" disabled={busy || empty(all)} onClick={() => void run()}>{busy ? 'Bringing it over' : 'Import'}</button>
            </div>
          </div>
        </Sect>
      )}
      {done && (
        <Sect title="Brought over">
          <div className="gr" aria-live="polite">
            <div className="gr-main">
              <div className="t1">{summary(done)}</div>
              {done.tips > 0 && <div className="t2">Past tips show on Home and in Stats. They keep the amount from the file as it was.</div>}
            </div>
          </div>
          {done.skipped.map((s, i) => <Row key={i} title={s.what} desc={s.why} />)}
        </Sect>
      )}
    </>
  );
}
