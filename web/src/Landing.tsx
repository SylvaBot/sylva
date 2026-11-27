// The public home page: what Sylva is and how to start. The look follows
// the landing design doc: a near black page lit by a moving moss glow
// (glow.ts), Geist type, mono section tags and blank product frames until
// the dashboard is remade.

import { useEffect, useRef } from 'react';
import { startGlow } from './glow';
import './landing.css';

const START = '/auth/twitch/start';

/** Where the Sylva Control download buttons point: the latest GitHub
 * Release, which lists the installer for each system. */
const DESKTOP_DOWNLOAD = 'https://github.com/SylvaBot/sylva-control/releases/latest';

export function Landing({ signedIn, error, notice, notFound }: {
  signedIn: boolean; error: string | null; notice: string | null; notFound: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const home = signedIn ? '/app' : START;

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const stops = [...el.querySelectorAll<HTMLCanvasElement>('canvas.lp-glow')].map(startGlow);
    return () => stops.forEach((stop) => stop());
  }, [notFound]);

  useEffect(() => {
    document.title = notFound ? 'Page not found \u00b7 Sylva' : 'Sylva \u00b7 Alerts, chat bot and tips for Twitch';
  }, [notFound]);

  const header = (
    <header style={{ position: 'absolute', top: '0', left: '0', right: '0', zIndex: '5', paddingTop: '16px' }}>
        <div className="lp-wrap" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px' }}>
          <a href="/" aria-label="Sylva home" style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#fff', fontWeight: '600', fontSize: '20px', letterSpacing: '-0.02em' }}>
            <svg width="34" height="34" style={{ width: '34px', height: '34px' }} viewBox="17 10 30 42" aria-hidden="true"><path d="M32 12c-9 8-13 17-13 25a13 13 0 0 0 26 0c0-8-4-17-13-25z" fill="#d6efc2"></path><path d="M32 22v30M32 38l-7-6M32 44l7-6" stroke="#121211" strokeWidth="2.6" strokeLinecap="round" fill="none"></path></svg>
            Sylva
          </a>
          <nav className="lp-hide-m" aria-label="Sections" style={{ display: 'flex', gap: '2px', padding: '5px', borderRadius: '999px', background: 'rgba(255,255,255,.045)', boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.07)', backdropFilter: 'blur(14px)' }}>
            <a className="lp-navlink" href="#features">Features</a>
            <a className="lp-navlink" href="#tips">Tips</a>
            <a className="lp-navlink" href="#desktop">Apps</a>
            <a className="lp-navlink" href="#switching">Switching</a>
            <a className="lp-navlink" href="#faq">FAQ</a>
          </nav>
          <a className="lp-navlink" href={home} style={{ padding: '12px 18px', background: 'rgba(255,255,255,.045)', boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.07)', backdropFilter: 'blur(14px)' }}>{signedIn ? 'Dashboard' : 'Sign in'}</a>
        </div>
      </header>
  );

  if (notFound) {
    return (
      <div className="lp" ref={root}>
        <section style={{ position: 'relative', background: '#121211', minHeight: '100vh', display: 'flex', alignItems: 'center' }}>
          <div aria-hidden="true" style={{ position: 'absolute', inset: '0', overflow: 'hidden' }}>
            <canvas className="lp-glow" data-base="#121211"></canvas>
          </div>
          {header}
          <div className="lp-wrap" style={{ position: 'relative', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <h1 className="lp-h1" style={{ fontSize: '56px', lineHeight: '62px', fontWeight: 500, letterSpacing: '-0.035em' }}>Page not found</h1>
            <p style={{ marginTop: '16px', fontSize: '17px', color: '#c9c9c4' }}>That page does not exist. It may have moved.</p>
            <a className="lp-btn lp-btn-sage" href={signedIn ? '/app' : '/'} style={{ marginTop: '28px' }}>{signedIn ? 'Go to your dashboard' : 'Go to the home page'}</a>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="lp" ref={root} style={{ position: 'relative', width: '100%', overflow: 'hidden' }}>

    {/* ============ HERO ============ */}
    <section style={{ position: 'relative', background: '#121211', padding: '120px 0 0' }}>
      <div aria-hidden="true" style={{ position: 'absolute', inset: '0', overflow: 'hidden' }}>
        <div className="lp-blob lp-b3" style={{ width: '1400px', height: '620px', left: '50%', marginLeft: '-700px', bottom: '-260px', background: 'radial-gradient(closest-side, rgba(84,116,62,.85), rgba(84,116,62,0))' }}></div>
        <div className="lp-blob lp-b1" style={{ width: '900px', height: '520px', left: '-220px', bottom: '40px', background: 'radial-gradient(closest-side, rgba(128,166,98,.55), rgba(128,166,98,0))' }}></div>
        <div className="lp-blob lp-b2" style={{ width: '760px', height: '480px', right: '-180px', bottom: '120px', background: 'radial-gradient(closest-side, rgba(176,214,148,.5), rgba(176,214,148,0))' }}></div>
        <div className="lp-blob lp-b4" style={{ width: '420px', height: '260px', left: '58%', bottom: '300px', background: 'radial-gradient(closest-side, rgba(220,244,200,.32), rgba(220,244,200,0))' }}></div>
        <canvas className="lp-glow" data-base="#121211"></canvas>
        <div style={{ position: 'absolute', inset: '0', background: 'linear-gradient(180deg, #0c0c0b 0%, rgba(12,12,11,.85) 22%, rgba(12,12,11,0) 55%)' }}></div>
      </div>

      {/* Nav */}
      {header}

      <div className="lp-wrap" style={{ position: 'relative', zIndex: '2', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <h1 className="lp-h1" style={{ margin: '0', fontSize: '60px', lineHeight: '64px', fontWeight: '500', letterSpacing: '-0.035em', maxWidth: '760px' }}>Your alerts, bot and community in one place.</h1>
        <p style={{ margin: '22px 0 0', fontSize: '18px', lineHeight: '28px', color: '#c9c9c4', maxWidth: '620px' }}>Sylva brings your alerts, overlays, chat bot and tips together, so you can stop juggling tools and get back to your stream.</p>
        <div className="lp-stack-m" style={{ marginTop: '32px', display: 'flex', gap: '10px', alignItems: 'center', justifyContent: 'center' }}>
          <a className="lp-btn lp-btn-sage" href={home}>
            <svg className="lp-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 2H3v16h5v4l4-4h5l4-4V2zm-10 9V7m5 4V7"></path></svg>
            {signedIn ? 'Open dashboard' : 'Continue with Twitch'}
          </a>
          <a className="lp-btn lp-btn-dark" href="#desktop">
            <svg className="lp-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"></rect><path d="M8 21h8M12 17v4"></path></svg>
            Get Sylva Control
          </a>
        </div>
        <p className="lp-faint" style={{ margin: '16px 0 0', fontSize: '13px' }}>Free, always. Sign in with Twitch to get started.</p>
        {error && <p className="lp-alert" role="alert">{error}</p>}
        {notice && <p className="lp-note" role="status">{notice}</p>}
      </div>

      {/* Dashboard mockup */}
      <div className="lp-wrap" style={{ position: 'relative', zIndex: '2', marginTop: '64px', maxWidth: '1180px' }}>
        {/* dotted leaf */}
        <svg className="lp-shimmer lp-hide-m" aria-hidden="true" viewBox="17 10 30 42" style={{ position: 'absolute', right: '-40px', top: '-150px', width: '260px', height: '364px', zIndex: '0' }}>
          <defs>
            <pattern id="sylvaDots" width="1.3" height="1.3" patternUnits="userSpaceOnUse"><circle cx=".65" cy=".65" r=".42" fill="#d6efc2"></circle></pattern>
            <radialGradient id="sylvaFade" cx="40%" cy="35%" r="70%"><stop offset="0" stopColor="#fff"></stop><stop offset="1" stopColor="#fff" stopOpacity=".15"></stop></radialGradient>
            <mask id="sylvaLeaf"><path d="M32 12c-9 8-13 17-13 25a13 13 0 0 0 26 0c0-8-4-17-13-25z" fill="url(#sylvaFade)"></path><path d="M32 22v30M32 38l-7-6M32 44l7-6" stroke="#000" strokeWidth="2.2" strokeLinecap="round" fill="none"></path></mask>
          </defs>
          <rect x="17" y="10" width="30" height="42" fill="url(#sylvaDots)" mask="url(#sylvaLeaf)"></rect>
        </svg>

        <div aria-label="Product preview, coming soon" style={{ position: 'relative', zIndex: '1', borderRadius: '16px', background: 'rgba(16,16,15,.9)', border: '1px solid rgba(255,255,255,.1)', boxShadow: '0 40px 120px -30px rgba(0,0,0,.8), 0 0 0 6px rgba(255,255,255,.025)', overflow: 'hidden' }}>
          <div style={{ height: '44px', borderBottom: '1px solid rgba(255,255,255,.07)' }}></div>
          <div className="lp-blank-hero" style={{ height: '560px' }}></div>
        </div>
      </div>
      <div style={{ height: '96px' }}></div>
    </section>

    {/* ============ FEATURES ============ */}
    <section id="features" className="lp-sec" style={{ background: '#121211', padding: '96px 0 104px', borderTop: '1px solid rgba(255,255,255,.06)' }}>
      <div className="lp-wrap">
        <span className="lp-tag">/features</span>
        <h2 className="lp-h2" style={{ margin: '18px 0 0', fontSize: '40px', lineHeight: '46px', fontWeight: '500', letterSpacing: '-0.03em', maxWidth: '620px' }}>Everything your stream runs on.</h2>
        <p className="lp-muted" style={{ margin: '14px 0 0', fontSize: '17px', lineHeight: '27px', maxWidth: '560px' }}>Alerts, chat, community and support in one place, designed to stay out of your way while you are live.</p>

        <div className="lp-g2 lp-bento" style={{ marginTop: '48px', borderTop: '1px solid rgba(255,255,255,.08)', borderBottom: '1px solid rgba(255,255,255,.08)' }}>
          {/* Alerts */}
          <div style={{ padding: '36px 32px 32px' }}>
            <div style={{ height: '230px', position: 'relative', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '10px', maxWidth: '380px', margin: '0 auto' }}>
              <div style={{ padding: '14px 16px', borderRadius: '12px', background: 'rgba(155,123,247,.16)', border: '1px solid rgba(155,123,247,.4)', display: 'flex', alignItems: 'center', gap: '12px' }}><span className="lp-mono" style={{ fontSize: '10.5px', color: '#c9b8fb', letterSpacing: '.06em' }}>NOW</span><span style={{ fontSize: '15px', fontWeight: '500' }}>Rowan resubscribed, 6 months</span></div>
              <div className="lp-card" style={{ padding: '12px 16px', display: 'flex', gap: '12px', opacity: '.8' }}><span className="lp-mono lp-faint" style={{ fontSize: '10.5px', letterSpacing: '.06em' }}>NEXT</span><span style={{ fontSize: '14px' }}>Hazel cheered 500 bits</span></div>
              <div className="lp-card" style={{ padding: '12px 16px', display: 'flex', gap: '12px', opacity: '.55' }}><span className="lp-mono lp-faint" style={{ fontSize: '10.5px', letterSpacing: '.06em' }}>NEXT</span><span style={{ fontSize: '14px' }}>Birch raided with 42</span></div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '18px' }}><svg className="lp-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0"></path></svg><h3 style={{ margin: '0', fontSize: '18px', fontWeight: '500' }}>Alerts and overlays</h3></div><p className="lp-muted" style={{ margin: '8px 0 0 28px', fontSize: '15px', lineHeight: '23px', maxWidth: '420px' }}>Add one link to OBS and your alerts, chat and goals are on screen.</p>
          </div>
          {/* Bot */}
          <div style={{ padding: '36px 32px 32px' }}>
            <div className="lp-card lp-mono" style={{ height: '230px', padding: '18px 20px', fontSize: '13px', lineHeight: '2', maxWidth: '400px', margin: '0 auto', background: 'rgba(0,0,0,.35)' }}>
              <div><span style={{ color: '#5b8def' }}>maple_tree</span><span className="lp-faint">:</span> !followage</div>
              <div><span style={{ color: '#d6efc2' }}>Sylva_Bot</span><span className="lp-faint">:</span> maple_tree has followed for 2 years, 3 months</div>
              <div><span style={{ color: '#ec5c9e' }}>hazelnut</span><span className="lp-faint">:</span> !uptime</div>
              <div><span style={{ color: '#d6efc2' }}>Sylva_Bot</span><span className="lp-faint">:</span> Live for 1 hour 42 minutes</div>
              <div><span style={{ color: '#2bbfae' }}>birch</span><span className="lp-faint">:</span> !discord</div>
              <div><span style={{ color: '#d6efc2' }}>Sylva_Bot</span><span className="lp-faint">:</span> Join us at discord.gg/juniper</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '18px' }}><svg className="lp-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="8" width="18" height="12" rx="2"></rect><path d="M12 8V4H8M2 14h2M20 14h2M15 13v2M9 13v2"></path></svg><h3 style={{ margin: '0', fontSize: '18px', fontWeight: '500' }}>A chat bot from day one</h3></div><p className="lp-muted" style={{ margin: '8px 0 0 28px', fontSize: '15px', lineHeight: '23px', maxWidth: '420px' }}>Commands, timers and quotes your community already knows, ready the moment you sign in.</p>
          </div>
          {/* Moderation */}
          <div style={{ padding: '36px 32px 32px' }}>
            <div style={{ height: '230px', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '8px', maxWidth: '400px', margin: '0 auto' }}>
              <div className="lp-card" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 14px' }}><span style={{ fontSize: '14px' }}>Links</span><span style={{ width: '36px', height: '20px', borderRadius: '999px', background: '#d6efc2', position: 'relative' }}><span style={{ position: 'absolute', right: '2px', top: '2px', width: '16px', height: '16px', borderRadius: '50%', background: '#11160e' }}></span></span></div>
              <div className="lp-card" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 14px' }}><span style={{ fontSize: '14px' }}>Caps</span><span style={{ width: '36px', height: '20px', borderRadius: '999px', background: '#d6efc2', position: 'relative' }}><span style={{ position: 'absolute', right: '2px', top: '2px', width: '16px', height: '16px', borderRadius: '50%', background: '#11160e' }}></span></span></div>
              <div className="lp-card" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 14px' }}><span style={{ fontSize: '14px' }}>Banned words</span><span style={{ width: '36px', height: '20px', borderRadius: '999px', background: '#d6efc2', position: 'relative' }}><span style={{ position: 'absolute', right: '2px', top: '2px', width: '16px', height: '16px', borderRadius: '50%', background: '#11160e' }}></span></span></div>
              <div style={{ display: 'flex', gap: '6px', marginTop: '6px', flexWrap: 'wrap' }}>
                <span className="lp-mono" style={{ fontSize: '12px', padding: '5px 10px', borderRadius: '6px', background: 'rgba(255,255,255,.05)', color: '#d4d4cf' }}>1 warn</span>
                <span className="lp-mono" style={{ fontSize: '12px', padding: '5px 10px', borderRadius: '6px', background: 'rgba(232,177,58,.12)', color: '#f0c46a' }}>2 timeout 10s</span>
                <span className="lp-mono" style={{ fontSize: '12px', padding: '5px 10px', borderRadius: '6px', background: 'rgba(240,104,106,.14)', color: '#f59496' }}>3 timeout 10m</span>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '18px' }}><svg className="lp-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"></path></svg><h3 style={{ margin: '0', fontSize: '18px', fontWeight: '500' }}>Moderation with backup</h3></div><p className="lp-muted" style={{ margin: '8px 0 0 28px', fontSize: '15px', lineHeight: '23px', maxWidth: '420px' }}>Spam, links and walls of caps get handled before your mods have to step in.</p>
          </div>
          {/* Games */}
          <div style={{ padding: '36px 32px 32px' }}>
            <div style={{ height: '230px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '14px' }}>
              <div style={{ display: 'flex', gap: '10px' }}>
                <span className="lp-card" style={{ width: '76px', height: '92px', display: 'grid', placeItems: 'center', background: 'rgba(214,239,194,.08)', borderColor: 'rgba(214,239,194,.3)' }}><svg width="34" height="34" style={{ width: '34px', height: '34px' }} viewBox="0 0 64 64" aria-hidden="true"><path d="M32 12c-9 8-13 17-13 25a13 13 0 0 0 26 0c0-8-4-17-13-25z" fill="#d6efc2"></path><path d="M32 22v30M32 38l-7-6M32 44l7-6" stroke="#1d2a17" strokeWidth="3" strokeLinecap="round" fill="none"></path></svg></span>
                <span className="lp-card" style={{ width: '76px', height: '92px', display: 'grid', placeItems: 'center', background: 'rgba(214,239,194,.08)', borderColor: 'rgba(214,239,194,.3)' }}><svg width="34" height="34" style={{ width: '34px', height: '34px' }} viewBox="0 0 64 64" aria-hidden="true"><path d="M32 12c-9 8-13 17-13 25a13 13 0 0 0 26 0c0-8-4-17-13-25z" fill="#d6efc2"></path><path d="M32 22v30M32 38l-7-6M32 44l7-6" stroke="#1d2a17" strokeWidth="3" strokeLinecap="round" fill="none"></path></svg></span>
                <span className="lp-card" style={{ width: '76px', height: '92px', display: 'grid', placeItems: 'center', background: 'rgba(214,239,194,.08)', borderColor: 'rgba(214,239,194,.3)' }}><svg width="34" height="34" style={{ width: '34px', height: '34px' }} viewBox="0 0 64 64" aria-hidden="true"><path d="M32 12c-9 8-13 17-13 25a13 13 0 0 0 26 0c0-8-4-17-13-25z" fill="#d6efc2"></path><path d="M32 22v30M32 38l-7-6M32 44l7-6" stroke="#1d2a17" strokeWidth="3" strokeLinecap="round" fill="none"></path></svg></span>
              </div>
              <div className="lp-mono" style={{ fontSize: '13px', textAlign: 'center' }}><span className="lp-faint">birch played !slots 200.</span> <span style={{ color: '#d6efc2' }}>Three leaves, +1,000 points</span></div>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'center' }}>
                <span className="lp-mono lp-faint" style={{ fontSize: '11.5px', padding: '4px 9px', borderRadius: '6px', border: '1px solid rgba(255,255,255,.1)' }}>!gamble</span>
                <span className="lp-mono lp-faint" style={{ fontSize: '11.5px', padding: '4px 9px', borderRadius: '6px', border: '1px solid rgba(255,255,255,.1)' }}>!roulette</span>
                <span className="lp-mono lp-faint" style={{ fontSize: '11.5px', padding: '4px 9px', borderRadius: '6px', border: '1px solid rgba(255,255,255,.1)' }}>!blackjack</span>
                <span className="lp-mono lp-faint" style={{ fontSize: '11.5px', padding: '4px 9px', borderRadius: '6px', border: '1px solid rgba(255,255,255,.1)' }}>!duel</span>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '18px' }}><svg className="lp-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 3h12l4 6-10 13L2 9ZM11 3 8 9l4 13 4-13-3-6M2 9h20"></path></svg><h3 style={{ margin: '0', fontSize: '18px', fontWeight: '500' }}>Reward your regulars</h3></div><p className="lp-muted" style={{ margin: '8px 0 0 28px', fontSize: '15px', lineHeight: '23px', maxWidth: '420px' }}>Viewers earn points for hanging out and spend them on games and rewards you choose.</p>
          </div>
          {/* Giveaways */}
          <div style={{ padding: '36px 32px 32px' }}>
            <div className="lp-card" style={{ height: '230px', padding: '20px', maxWidth: '400px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><span style={{ fontSize: '15px', fontWeight: '500' }}>Giveaway: 1 month sub</span><span className="lp-mono" style={{ fontSize: '11px', color: '#3ecf74' }}>148 entered</span></div>
              <div><div className="lp-mono lp-faint" style={{ fontSize: '10.5px', letterSpacing: '.06em' }}>PROOF OF A FAIR DRAW</div><div className="lp-mono" style={{ fontSize: '12.5px', marginTop: '4px', color: '#d4d4cf', overflowWrap: 'anywhere' }}>9f2c 41ae 7b90 d3e1 5c08 aa62 e4f7 1b3d</div></div>
              <div style={{ marginTop: 'auto', padding: '12px 14px', borderRadius: '10px', background: 'rgba(214,239,194,.1)', border: '1px solid rgba(214,239,194,.3)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><span style={{ fontSize: '15px' }}><span className="lp-faint">Winner</span> <b style={{ fontWeight: '600' }}>hazelnut</b></span><span className="lp-mono" style={{ fontSize: '11.5px', color: '#d6efc2' }}>verified</span></div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '18px' }}><svg className="lp-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0zM17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"></path></svg><h3 style={{ margin: '0', fontSize: '18px', fontWeight: '500' }}>Giveaways people trust</h3></div><p className="lp-muted" style={{ margin: '8px 0 0 28px', fontSize: '15px', lineHeight: '23px', maxWidth: '420px' }}>Every draw can be checked by anyone, so no one has to wonder if it was fair.</p>
          </div>
          {/* Stats */}
          <div style={{ padding: '36px 32px 32px' }}>
            <div className="lp-card" style={{ height: '230px', padding: '20px', maxWidth: '400px', margin: '0 auto', display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}><span style={{ fontSize: '15px', fontWeight: '500' }}>Followers, 90 days</span><span className="lp-mono" style={{ fontSize: '11px', padding: '3px 8px', borderRadius: '6px', background: 'rgba(255,255,255,.06)', color: '#d4d4cf' }}>vs last 90 days</span></div>
              <svg viewBox="0 0 320 130" style={{ width: '100%', flex: '1', marginTop: '12px' }} aria-hidden="true">
                <path d="M0 110 C30 104 50 100 70 96 S110 92 130 84 S170 78 190 66 S240 50 260 40 S300 26 320 18 L320 130 L0 130 Z" fill="rgba(214,239,194,.08)"></path>
                <path d="M0 110 C30 104 50 100 70 96 S110 92 130 84 S170 78 190 66 S240 50 260 40 S300 26 320 18" fill="none" stroke="#d6efc2" strokeWidth="2"></path>
                <path d="M0 118 C40 114 70 110 100 108 S160 100 200 96 S270 86 320 80" fill="none" stroke="rgba(255,255,255,.28)" strokeWidth="1.5" strokeDasharray="4 4"></path>
              </svg>
              <div className="lp-mono" style={{ display: 'flex', gap: '16px', fontSize: '11.5px', marginTop: '8px' }}><span style={{ color: '#d6efc2' }}>this period</span><span className="lp-faint">period before</span></div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '18px' }}><svg className="lp-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 3v18h18M7 15l4-4 3 3 5-6"></path></svg><h3 style={{ margin: '0', fontSize: '18px', fontWeight: '500' }}>See what is working</h3></div><p className="lp-muted" style={{ margin: '8px 0 0 28px', fontSize: '15px', lineHeight: '23px', maxWidth: '420px' }}>Find out which streams grew your channel and how this month compares to the last.</p>
          </div>
        </div>

      </div>
    </section>

    {/* ============ TIPS ============ */}
    <section id="tips" className="lp-sec" style={{ padding: '104px 0', background: '#0a0a0a' }}>
      <div className="lp-wrap" style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <span className="lp-tag">/tips</span>
        <h2 className="lp-h2" style={{ margin: '18px 0 0', fontSize: '40px', lineHeight: '46px', fontWeight: '500', letterSpacing: '-0.03em' }}>Get tipped without the fine print.</h2>
        <p className="lp-muted" style={{ margin: '14px 0 0', fontSize: '17px', lineHeight: '27px', maxWidth: '600px' }}>Viewers tip from your own page and the money goes straight to your Stripe account. Sylva never takes a cut.</p>
      </div>
      <div className="lp-wrap lp-g2" style={{ marginTop: '56px', gap: '20px', alignItems: 'stretch' }}>
        {/* tip page mock */}
        <div aria-hidden="true" className="lp-card" style={{ padding: '28px', background: 'linear-gradient(180deg, rgba(214,239,194,.07), rgba(255,255,255,.02))', borderColor: 'rgba(214,239,194,.18)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}><span style={{ width: '44px', height: '44px', borderRadius: '50%', background: 'linear-gradient(135deg, #6b8c55, #2b3a22)' }}></span><div><div style={{ fontWeight: '500' }}>Tip Juniper</div><div className="lp-faint" style={{ fontSize: '13px' }}>Shown on stream with your message</div></div></div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: '8px', marginTop: '22px' }}>
            <span className="lp-card" style={{ textAlign: 'center', padding: '11px 0', fontSize: '14px' }}>$5</span>
            <span style={{ textAlign: 'center', padding: '11px 0', fontSize: '14px', borderRadius: '12px', background: '#d6efc2', color: '#11160e', fontWeight: '500' }}>$10</span>
            <span className="lp-card" style={{ textAlign: 'center', padding: '11px 0', fontSize: '14px' }}>$25</span>
            <span className="lp-card lp-faint" style={{ textAlign: 'center', padding: '11px 0', fontSize: '14px' }}>Other</span>
          </div>
          <div className="lp-faint" style={{ fontSize: '12.5px', marginTop: '18px' }}>Message</div>
          <div style={{ marginTop: '6px', height: '44px', padding: '0 14px', display: 'flex', alignItems: 'center', borderRadius: '10px', border: '1px solid rgba(255,255,255,.1)', background: 'rgba(0,0,0,.3)', fontSize: '14px' }}>That clutch was unreal, keep it up</div>
          <span className="lp-btn lp-btn-sage" style={{ width: '100%', marginTop: '24px' }}>Send $10.00</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', borderTop: '1px solid rgba(255,255,255,.08)' }}>
          <div style={{ display: 'flex', gap: '16px', padding: '24px 0', borderBottom: '1px solid rgba(255,255,255,.08)' }}><svg className="lp-ico" style={{ marginTop: '3px' }} viewBox="0 0 24 24" fill="none" stroke="#d6efc2" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"></path></svg><div><h3 style={{ margin: '0', fontSize: '17px', fontWeight: '500' }}>Protected from chargebacks</h3><p className="lp-muted" style={{ margin: '6px 0 0', fontSize: '15px', lineHeight: '23px' }}>Risky payments are held until you approve them, and if a tip is disputed, the paperwork is filed for you.</p></div></div>
          <div style={{ display: 'flex', gap: '16px', padding: '24px 0', borderBottom: '1px solid rgba(255,255,255,.08)' }}><svg className="lp-ico" style={{ marginTop: '3px' }} viewBox="0 0 24 24" fill="none" stroke="#d6efc2" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3"></path></svg><div><h3 style={{ margin: '0', fontSize: '17px', fontWeight: '500' }}>Read aloud on stream</h3><p className="lp-muted" style={{ margin: '6px 0 0', fontSize: '15px', lineHeight: '23px' }}>Every tip message is read out loud on your overlay, right after the alert sound.</p></div></div>
          <div style={{ display: 'flex', gap: '16px', padding: '24px 0', borderBottom: '1px solid rgba(255,255,255,.08)' }}><svg className="lp-ico" style={{ marginTop: '3px' }} viewBox="0 0 24 24" fill="none" stroke="#d6efc2" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"></path></svg><div><h3 style={{ margin: '0', fontSize: '17px', fontWeight: '500' }}>Your stream, your rules</h3><p className="lp-muted" style={{ margin: '6px 0 0', fontSize: '15px', lineHeight: '23px' }}>Filter words, cap message length and decide exactly how and when messages are read.</p></div></div>
        </div>
      </div>
    </section>

    {/* ============ DESKTOP ============ */}
    <section id="desktop" className="lp-sec" style={{ padding: '104px 0', background: '#121211', borderTop: '1px solid rgba(255,255,255,.06)' }}>
      <div className="lp-wrap lp-g2" style={{ gap: '56px', alignItems: 'center' }}>
        <div>
          <span className="lp-tag">/apps</span>
          <h2 className="lp-h2" style={{ margin: '18px 0 0', fontSize: '40px', lineHeight: '46px', fontWeight: '500', letterSpacing: '-0.03em' }}>Sylva Control. A companion for when you are live.</h2>
          <p className="lp-muted" style={{ margin: '14px 0 0', fontSize: '17px', lineHeight: '27px' }}>Sylva runs in your browser. Sylva Control is an optional companion that sits next to your game, so you can see who just showed up and handle alerts without alt tabbing.</p>
          <div className="lp-stack-m" style={{ display: 'flex', gap: '10px', marginTop: '32px' }}>
            <a className="lp-btn lp-btn-sage" href={DESKTOP_DOWNLOAD}><svg className="lp-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"></path></svg>Download for Windows</a>
            <a className="lp-btn lp-btn-dark" href={DESKTOP_DOWNLOAD}>macOS and Linux</a>
          </div>
          <p className="lp-faint" style={{ margin: '24px 0 0', fontSize: '14px', lineHeight: '22px' }}>Sylva Chat, a light Twitch chat app with mod tools built in, is coming soon.</p>
        </div>
        <div style={{ position: 'relative' }}>
          <div aria-hidden="true" className="lp-blob lp-b2" style={{ width: '520px', height: '360px', left: '50%', top: '50%', margin: '-180px 0 0 -260px', background: 'radial-gradient(closest-side, rgba(128,166,98,.35), rgba(128,166,98,0))' }}></div>
          <div aria-label="Sylva Control preview, coming soon" style={{ position: 'relative', borderRadius: '14px', background: '#10100f', border: '1px solid rgba(255,255,255,.1)', boxShadow: '0 30px 90px -30px rgba(0,0,0,.85)', overflow: 'hidden', maxWidth: '440px', margin: '0 auto' }}>
            <div style={{ height: '40px', borderBottom: '1px solid rgba(255,255,255,.07)' }}></div>
            <div className="lp-blank-desk" style={{ height: '380px' }}></div>
          </div>
        </div>
      </div>
    </section>

    {/* ============ SWITCHING ============ */}
    <section id="switching" className="lp-sec" style={{ padding: '104px 0', background: '#0a0a0a' }}>
      <div className="lp-wrap" style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <span className="lp-tag">/switching</span>
        <h2 className="lp-h2" style={{ margin: '18px 0 0', fontSize: '40px', lineHeight: '46px', fontWeight: '500', letterSpacing: '-0.03em' }}>Switching takes one click.</h2>
        <p className="lp-muted" style={{ margin: '14px 0 0', fontSize: '17px', lineHeight: '27px', maxWidth: '560px' }}>Coming from StreamElements? Bring your commands, timers, loyalty points and stream history with you, and pick up right where you left off.</p>
        <div className="lp-card lp-mono" style={{ marginTop: '44px', width: '100%', maxWidth: '640px', textAlign: 'left', padding: '8px', background: 'rgba(0,0,0,.4)', fontSize: '13px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,.06)' }}><span className="lp-faint">Importing from StreamElements</span><span style={{ color: '#d6efc2' }}>complete</span></div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '10px 14px' }}><span><span style={{ color: '#d6efc2' }}>ok</span>  commands</span><span className="lp-faint">42 imported</span></div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '10px 14px' }}><span><span style={{ color: '#d6efc2' }}>ok</span>  timers</span><span className="lp-faint">6 imported</span></div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '10px 14px' }}><span><span style={{ color: '#d6efc2' }}>ok</span>  loyalty points</span><span className="lp-faint">1,000 viewers</span></div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '10px 14px' }}><span><span style={{ color: '#d6efc2' }}>ok</span>  stream history</span><span className="lp-faint">214 streams</span></div>
        </div>
      </div>
    </section>

    {/* ============ FAQ ============ */}
    <section id="faq" className="lp-sec" style={{ padding: '104px 0', background: '#0a0a0a', borderTop: '1px solid rgba(255,255,255,.06)' }}>
      <div className="lp-wrap lp-g2" style={{ gap: '48px', alignItems: 'start' }}>
        <div>
          <span className="lp-tag">/faq</span>
          <h2 className="lp-h2" style={{ margin: '18px 0 0', fontSize: '40px', lineHeight: '46px', fontWeight: '500', letterSpacing: '-0.03em' }}>Questions, answered.</h2>
        </div>
        <div className="lp-faq" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <details className="lp-card" open><summary>Is Sylva free?<svg className="lp-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg></summary><p>Yes, and it stays free.</p></details>
          <details className="lp-card"><summary>Does Sylva take a cut of my tips?<svg className="lp-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg></summary><p>No. Tips go straight to your Stripe account. Only Stripe's standard processing fees apply.</p></details>
          <details className="lp-card"><summary>Do I need to download anything?<svg className="lp-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg></summary><p>No. Sylva runs in your browser and works with OBS or any streaming software that supports browser sources. Sylva Control is optional.</p></details>
          <details className="lp-card"><summary>Which platforms does Sylva support?<svg className="lp-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg></summary><p>Twitch, with more on the way.</p></details>
          <details className="lp-card"><summary>Can my moderators help run things?<svg className="lp-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg></summary><p>Yes. Invite them and choose what each person can see and change.</p></details>
          <details className="lp-card"><summary>Can I bring my StreamElements setup?<svg className="lp-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg></summary><p>Yes. Commands, timers, loyalty points and stream history come over in one step.</p></details>
        </div>
      </div>
    </section>

    {/* ============ CLOSING ============ */}
    <section style={{ position: 'relative', padding: '120px 0 64px', background: '#0a0a0a', overflow: 'hidden' }}>
      <div aria-hidden="true" style={{ position: 'absolute', inset: '0', overflow: 'hidden' }}>
        <div className="lp-blob lp-b3" style={{ width: '1300px', height: '560px', left: '50%', marginLeft: '-650px', bottom: '-300px', background: 'radial-gradient(closest-side, rgba(84,116,62,.8), rgba(84,116,62,0))' }}></div>
        <div className="lp-blob lp-b1" style={{ width: '700px', height: '380px', left: '8%', bottom: '-120px', background: 'radial-gradient(closest-side, rgba(176,214,148,.4), rgba(176,214,148,0))' }}></div>
        <canvas className="lp-glow" data-base="#0a0a0a"></canvas>
      </div>
      <div aria-hidden="true" className="lp-wordmark" style={{ position: 'absolute', left: '0', right: '0', top: '40px', textAlign: 'center', fontSize: '300px', lineHeight: '1', fontWeight: '600', letterSpacing: '-0.06em', color: 'rgba(255,255,255,.035)' }}>Sylva</div>
      <div className="lp-wrap" style={{ position: 'relative', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <h2 className="lp-h2" style={{ margin: '60px 0 0', fontSize: '44px', lineHeight: '50px', fontWeight: '500', letterSpacing: '-0.03em' }}>Your whole stream, in one calm place.</h2>
        <p className="lp-muted" style={{ margin: '14px 0 0', fontSize: '17px' }}>Sign in with Twitch and have Sylva running on your stream in minutes.</p>
        <a className="lp-btn lp-btn-sage" href={home} style={{ marginTop: '28px' }}><svg className="lp-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 2H3v16h5v4l4-4h5l4-4V2zm-10 9V7m5 4V7"></path></svg>{signedIn ? 'Open dashboard' : 'Continue with Twitch'}</a>
      </div>

      {/* Footer */}
      <footer className="lp-wrap" style={{ position: 'relative', marginTop: '120px' }}>
        <div style={{ borderRadius: '16px', background: 'rgba(12,12,11,.82)', border: '1px solid rgba(255,255,255,.08)', backdropFilter: 'blur(16px)', padding: '32px' }}>
          <div className="lp-g4" style={{ gap: '32px' }}>
            <div>
              <svg width="30" height="30" style={{ width: '30px', height: '30px' }} viewBox="17 10 30 42" aria-hidden="true"><path d="M32 12c-9 8-13 17-13 25a13 13 0 0 0 26 0c0-8-4-17-13-25z" fill="#d6efc2"></path><path d="M32 22v30M32 38l-7-6M32 44l7-6" stroke="#0c0c0b" strokeWidth="2.6" strokeLinecap="round" fill="none"></path></svg>
              <p className="lp-muted" style={{ margin: '14px 0 0', fontSize: '14px', lineHeight: '22px', maxWidth: '240px' }}>The streamer toolkit for Twitch, on the web and on your desktop.</p>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '14px' }}><span style={{ fontWeight: '600' }}>Product</span><a href="#features" style={{ color: '#a3a39e' }}>Features</a><a href="#tips" style={{ color: '#a3a39e' }}>Tips</a><a href="#desktop" style={{ color: '#a3a39e' }}>Apps</a><a href="#switching" style={{ color: '#a3a39e' }}>Switching</a></div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '14px' }}><span style={{ fontWeight: '600' }}>Account</span><a href={home} style={{ color: '#a3a39e' }}>Sign in</a><a href="/app" style={{ color: '#a3a39e' }}>Dashboard</a></div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '14px' }}><span style={{ fontWeight: '600' }}>Legal</span><a href="/privacy" style={{ color: '#a3a39e' }}>Privacy</a></div>
          </div>
          <div className="lp-faint" style={{ marginTop: '32px', paddingTop: '20px', borderTop: '1px solid rgba(255,255,255,.07)', fontSize: '13px', display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}><span>© 2026 Sylva.</span><span>Not affiliated with Twitch.</span></div>
        </div>
      </footer>
    </section>

    </div>
  );
}
