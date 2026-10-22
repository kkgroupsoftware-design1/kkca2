import { useState } from 'react';
import { api, ApiError, storeSession } from '../api';
import type { UserDto } from '../types';

export default function Login({ onLoggedIn }: { onLoggedIn: (user: UserDto) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await api.login(username.trim(), password);
      storeSession(res.token, res.user);
      onLoggedIn(res.user);
    } catch (err) {
      // The backend deliberately returns one generic message for unknown
      // user / wrong password / disabled account — show it as-is.
      setError(err instanceof ApiError ? err.message : 'Login failed. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="login-logo">M</div>
        <h1>Malik Team Connect</h1>
        <p className="login-sub">Private team app — authorized members only.</p>
        <label>
          Username
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
            placeholder="e.g. malik1"
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
            placeholder="Your password"
          />
        </label>
        {error && <div className="login-error" role="alert">{error}</div>}
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="login-note">
          There is no sign-up. Accounts are created by the team admin on the server (10 members max).
        </p>
      </form>
    </div>
  );
}
