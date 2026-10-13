// The SoraLab sign-in screen (from the brand design): illustration on the left, a glowing glass card on the right.
// The username and password go straight to Mirai Account (its /api/signin, from the browser), which signs you in
// there; then the usual single sign-on step brings you back here. "Sign in with Mirai Account" uses Mirai Account's
// own pages (needed for 2-Step Verification, or if you'd rather type your password there).
import { useState } from 'react';
import { useApp } from '../lib/app.jsx';
import { LogoLockup, Mark } from '../components/Brand.jsx';
import { Icon } from '../components/Icons.jsx';
import { Spinner } from '../components/ui.jsx';

const PETALS = Array.from({ length: 16 }, (_, i) => ({
  left: (i * 61) % 100, delay: (i * 1.7) % 12, dur: 11 + ((i * 7) % 9), size: 8 + ((i * 5) % 9), drift: ((i % 2) ? 1 : -1) * (30 + (i * 13) % 60),
}));

export default function SignIn() {
  const { config } = useApp();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const brand = config.brand || 'Mirai';
  const ret = location.pathname + location.search;
  const sso = () => { location.href = `/auth/login?return=${encodeURIComponent(ret)}&remember=${remember ? 1 : 0}`; };

  const submit = async (e) => {
    e.preventDefault();
    if (!username.trim() || !password) { setError('Enter your username and password.'); return; }
    setBusy(true); setError('');
    try {
      const r = await fetch(`${config.accounts_url}/api/signin`, {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.message || 'Couldn’t sign in.'); setBusy(false); return; }
      sso(); // signed in to Mirai Account (or 2-Step Verification is needed there): finish through single sign-on
    } catch {
      // Mirai Account isn't reachable from the browser this way (older suite): use its own sign-in page.
      sso();
    }
  };

  return (
    <div className="relative h-full overflow-hidden bg-[#070a1f] text-white">
      {/* scenery */}
      <img src="/sora/login-art.jpg" alt="" aria-hidden="true" className="absolute inset-y-0 left-0 h-full w-full lg:w-[58%] object-cover object-[20%_top] opacity-60 lg:opacity-100" />
      <div className="absolute inset-0 lg:left-[40%] bg-gradient-to-r from-transparent via-[#0a0d2a]/85 to-[#0a0d2a] hidden lg:block" />
      <img src="/sora/login-edge.jpg" alt="" aria-hidden="true" className="absolute inset-y-0 right-0 h-full w-[12%] object-cover opacity-70 hidden xl:block [mask-image:linear-gradient(to_right,transparent,black_60%)]" />
      <div className="absolute inset-0 lg:hidden bg-[#070a1f]/70" />
      <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(ellipse_at_70%_40%,rgba(139,124,255,.25),transparent_55%),radial-gradient(ellipse_at_85%_90%,rgba(255,120,200,.18),transparent_50%)]" />
      <div className="absolute inset-0 pointer-events-none overflow-hidden" aria-hidden="true">
        {PETALS.map((p, i) => (
          <span key={i} className="sl-petal" style={{ left: `${p.left}%`, width: p.size, height: p.size * 0.7, animationDelay: `-${p.delay}s`, animationDuration: `${p.dur}s`, '--drift': `${p.drift}px` }} />
        ))}
      </div>

      {/* corner mark (the tagline on the left is part of the illustration) */}
      <div className="absolute top-6 right-8 flex items-center gap-2 text-sm tracking-[0.2em] text-white/85"><Mark size={22} />SoraLab by Mirai</div>

      {/* the card */}
      <div className="relative h-full overflow-y-auto flex items-center justify-center lg:justify-end lg:pr-[11%] p-4">
        <div className="sl-card w-full max-w-[460px] my-8 rounded-[28px] px-8 sm:px-12 py-10">
          <div className="flex flex-col items-center text-center">
            <LogoLockup width={330} className="max-w-full" />
          </div>
          <form onSubmit={submit} className="mt-8 flex flex-col gap-4" noValidate>
            <label className="sl-field">
              <Icon name="user" size={18} />
              <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username or Email" autoComplete="username" autoCapitalize="none" spellCheck={false} aria-label="Username or email" />
            </label>
            <label className="sl-field">
              <Icon name="lock" size={18} />
              <input value={password} onChange={(e) => setPassword(e.target.value)} type={show ? 'text' : 'password'} placeholder="Password" autoComplete="current-password" aria-label="Password" />
              <button type="button" onClick={() => setShow(!show)} aria-label={show ? 'Hide password' : 'Show password'} className="text-white/70 hover:text-white"><Icon name={show ? 'eyeOff' : 'eye'} size={18} /></button>
            </label>
            <div className="flex items-center justify-between text-sm px-1">
              <label className="flex items-center gap-2 cursor-pointer text-white/85">
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="w-4 h-4 accent-[#7fb6ff]" />Remember me
              </label>
              <a href={`${config.accounts_url}/signin/recovery`} className="text-[#7fb6ff] hover:text-white">Forgot password?</a>
            </div>
            {error && <div role="alert" className="text-sm text-[#ffb3c7] bg-[#ff4d7a]/10 border border-[#ff4d7a]/30 rounded-xl px-4 py-2">{error}</div>}
            <button type="submit" disabled={busy} className="sl-primary h-13 py-3.5 rounded-full font-semibold text-[17px] flex items-center justify-center gap-2 disabled:opacity-70">
              {busy ? <Spinner size={18} /> : <Icon name="back" size={18} className="rotate-180" />} Sign In
            </button>
          </form>
          <div className="flex items-center gap-4 my-5 text-xs tracking-widest text-white/60"><span className="flex-1 h-px bg-white/15" />OR<span className="flex-1 h-px bg-white/15" /></div>
          <button type="button" onClick={sso} className="sl-outline w-full py-3.5 rounded-full flex items-center justify-center gap-3 text-[15px]">
            <Icon name="users" size={18} /> Sign in with {brand} Account
          </button>
          <div className="flex items-center gap-3 mt-8 text-[10px] tracking-[0.35em] text-white/50"><span className="flex-1 h-px bg-white/10" />A SORALAB BRAND BY MIRAI<span className="flex-1 h-px bg-white/10" /></div>
        </div>
      </div>
    </div>
  );
}
