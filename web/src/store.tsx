// The public page viewers open at /s/{login}: a channel's rewards and its
// points leaderboard. Streamers manage rewards on the Points page.

import { useEffect, useState } from 'react';
import { api, type PublicStore } from './api';
import { Link } from './router';
import { SiteFooter, SiteHeader } from './site';
import { Icon, num, SkelRows } from './ui';

function wait(m: number): string {
  if (m === 0) return 'No wait';
  if (m % 1440 === 0) return m === 1440 ? '1 day' : m === 10080 ? '1 week' : `${m / 1440} days`;
  if (m % 60 === 0) return m === 60 ? '1 hour' : `${m / 60} hours`;
  return m === 1 ? '1 minute' : `${m} minutes`;
}

/** The public page at /s/{login}: anyone can see the rewards and the leaderboard. */
export function PublicStorePage({ login, signedIn }: { login: string; signedIn: boolean }) {
  const [data, setData] = useState<PublicStore | null | 'missing' | 'failed'>(null);
  const [who, setWho] = useState('');
  const [found, setFound] = useState<PublicStore['viewer'] | null>(null);
  const [looking, setLooking] = useState(false);

  useEffect(() => {
    api.publicStore(login)
      .then((d) => { setData(d); document.title = `${d.channel}’s ${d.pointsName} · Sylva`; })
      .catch((x) => { setData(x?.status === 404 ? 'missing' : 'failed'); document.title = 'Store · Sylva'; });
  }, [login]);

  const look = async () => {
    const q = who.trim().replace(/^@/, '');
    if (!q) return;
    setLooking(true);
    try {
      setFound((await api.publicStore(login, q)).viewer ?? null);
    } catch {
      setFound(null);
    } finally {
      setLooking(false);
    }
  };

  const header = (
    <SiteHeader>
      <span className="spacer" />
      {signedIn ? <Link className="btn" href="/app">Open dashboard</Link> : <Link className="btn" href="/">What is Sylva?</Link>}
    </SiteHeader>
  );

  if (data === null || data === 'missing' || data === 'failed') {
    return (
      <div className="site">
        {header}
        <main id="content" className="prose wrap">
          {data === null
            ? <SkelRows n={4} />
            : <>
                <h1>{data === 'missing' ? 'No points here' : 'Something went wrong'}</h1>
                <p className="prose-lede">
                  {data === 'missing'
                    ? `${login} does not have loyalty points on Sylva, or the link is mistyped.`
                    : 'Sylva could not be reached. Refresh to try again.'}
                </p>
              </>}
        </main>
        <SiteFooter />
      </div>
    );
  }

  const pts = data.pointsName;
  return (
    <div className="site">
      {header}
      <main id="content" className="wrap pub">
        <div className="pub-head">
          <p className="pub-eyebrow">twitch.tv/{login}</p>
          <h1>{data.channel}’s {pts}</h1>
          <p className="prose-lede">
            Earn {pts} by watching and chatting while {data.channel} is live. Type <code>!{pts.replace(/ /g, '')}</code> in chat to see yours.
          </p>
          <form className="pub-look" onSubmit={(e) => { e.preventDefault(); void look(); }}>
            <label className="sr-only" htmlFor="pub-who">Your Twitch name</label>
            <input id="pub-who" className="input" placeholder="Your Twitch name" maxLength={25} value={who} onChange={(e) => { setWho(e.target.value); setFound(null); }} />
            <button className="btn primary" type="submit" disabled={looking || !who.trim()}>Check {pts}</button>
          </form>
          <p className="pub-found" aria-live="polite">
            {found && (found.balance > 0
              ? <><b>{found.name}</b> has <b>{num(found.balance)}</b> {pts}, rank {num(found.rank)}.</>
              : <><b>{found.name}</b> has no {pts} yet.</>)}
          </p>
        </div>

        <div className="pub-grid">
          <section className="card" aria-labelledby="pub-rewards">
            <div className="card-head"><div><h2 id="pub-rewards">Rewards</h2>
              {data.items.length > 0 && <p>Type <code>!redeem</code> and the number in chat, such as <code>!redeem {data.items[0].number}</code>.</p>}
            </div></div>
            {data.items.length === 0
              ? <p className="empty"><Icon id="gift" />{data.storeOn ? 'No rewards yet. Check back soon.' : 'The store is closed right now.'}</p>
              : (
                <ul className="pub-items">
                  {data.items.map((i) => (
                    <li key={i.number} className={i.stock === 0 ? 'sold' : ''}>
                      <span className="pub-num">{i.number}</span>
                      <div className="pub-item">
                        <b>{i.name}</b>
                        {i.description && <span>{i.description}</span>}
                        <span className="pub-tags">
                          {[
                            i.stock === 0 ? 'Sold out' : i.stock != null ? `${num(i.stock)} left` : null,
                            i.cooldown ? `Once every ${wait(i.cooldown)}` : null,
                            i.input ? `Add a message: !redeem ${i.number} your message` : null,
                          ].filter(Boolean).join(' · ')}
                        </span>
                      </div>
                      <span className="pub-cost">{num(i.cost)}<span className="sr-only"> {pts}</span></span>
                    </li>
                  ))}
                </ul>
              )}
          </section>
          <section className="card" aria-labelledby="pub-top">
            <div className="card-head"><div><h2 id="pub-top">Leaderboard</h2><p>The viewers with the most {pts}.</p></div></div>
            {data.top.length === 0
              ? <p className="empty">Nobody has any {pts} yet.</p>
              : (
                <ol className="pub-top">
                  {data.top.map((v) => (
                    <li key={v.rank}>
                      <span className="pub-num">{v.rank}</span>
                      <b>{v.name}</b>
                      <span className="pub-cost">{num(v.balance)}</span>
                    </li>
                  ))}
                </ol>
              )}
          </section>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
