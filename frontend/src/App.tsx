import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useState } from "react";

interface User {
  id: string;
  name: string;
  email: string;
  avatar: string | null;
  slackConnected: boolean;
}

interface EmailRecord {
  id: string;
  recipient: string;
  sender: string;
  subject: string;
  scheduledAt: string;
  sentAt: string | null;
  status: "scheduled" | "sending" | "sent" | "failed";
  error: string | null;
}

type Tab = "scheduled" | "sent";

function extractAddresses(text: string) {
  const found = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
  return [...new Set(found.map((address) => address.toLowerCase()))];
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers }
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error || `Request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("scheduled");
  const [emails, setEmails] = useState<EmailRecord[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [composeOpen, setComposeOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const loadUser = useCallback(async () => {
    try {
      const result = await api<{ user: User | null }>("/api/me");
      setUser(result.user);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load account");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadEmails = useCallback(async () => {
    if (!user) return;
    setListLoading(true);
    try {
      const status = tab === "scheduled" ? "scheduled" : "sent";
      const params = new URLSearchParams({ status });
      if (search.trim()) params.set("q", search.trim());
      const result = await api<{ emails: EmailRecord[] }>(`/api/emails?${params}`);
      setEmails(result.emails);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load emails");
    } finally {
      setListLoading(false);
    }
  }, [user, tab, search]);

  useEffect(() => { void loadUser(); }, [loadUser]);
  useEffect(() => { void loadEmails(); }, [loadEmails]);

  const showNotice = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 4000);
  };

  async function logout() {
    await api("/auth/logout", { method: "POST" });
    setUser(null);
  }

  async function disconnectSlack() {
    try {
      await api("/api/slack", { method: "DELETE" });
      await loadUser();
      showNotice("Slack disconnected");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not disconnect Slack");
    }
  }

  const scheduledCount = useMemo(
    () => emails.filter((email) => email.status === "scheduled" || email.status === "sending").length,
    [emails]
  );

  if (loading) return <main className="center-state">Loading your workspace…</main>;
  if (!user) {
    return (
      <main className="login-page">
        <section className="login-card">
          <div className="brand-mark">R</div>
          <span className="eyebrow">OUTBOX LABS</span>
          <h1>Make every send count.</h1>
          <p>Schedule, track, and manage your email campaigns from one place.</p>
          {error && <p className="form-error">{error}</p>}
          <a className="button primary full-width" href="/auth/google">Continue with Google</a>
          <small>Secure sign-in powered by Google OAuth</small>
        </section>
        <span className="login-foot">REACHINBOX · EMAIL SCHEDULER</span>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/">
          <span className="brand-mark small">R</span>
          <span>reachinbox</span>
        </a>
        <div className="workspace-label">WORKSPACE</div>
        <nav className="side-nav">
          <button className="nav-item active"><span>▦</span> Overview</button>
          <button className={`nav-item ${tab === "scheduled" ? "selected" : ""}`} onClick={() => setTab("scheduled")}><span>◷</span> Scheduled <i>{scheduledCount}</i></button>
          <button className={`nav-item ${tab === "sent" ? "selected" : ""}`} onClick={() => setTab("sent")}><span>↗</span> Sent emails</button>
        </nav>
        <div className="sidebar-bottom">
          <div className="workspace-label">INTEGRATIONS</div>
          {user.slackConnected ? (
            <button className="integration connected" onClick={() => void disconnectSlack()}><span className="slack-mark">✳</span> Slack <span className="connected-dot">Connected · Disconnect</span></button>
          ) : (
            <a className="integration" href="/auth/slack"><span className="slack-mark">✳</span> Connect Slack <span className="integration-arrow">↗</span></a>
          )}
          <a className="integration" href="/admin/queues" target="_blank" rel="noreferrer"><span>☷</span> Queue monitor <span className="integration-arrow">↗</span></a>
          <div className="profile">
            {user.avatar ? <img src={user.avatar} alt="" /> : <span className="avatar-fallback">{user.name[0]}</span>}
            <span className="profile-copy"><strong>{user.name}</strong><small>{user.email}</small></span>
            <button className="logout" onClick={() => void logout()} title="Log out">↗</button>
          </div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumbs">Workspace <span>/</span> {tab === "scheduled" ? "Scheduled emails" : "Sent emails"}</div>
          <div className="top-user">
            {user.avatar && <img src={user.avatar} alt="" />}
            <span>{user.name}</span>
            <button onClick={() => void logout()}>Log out</button>
          </div>
        </header>
        <section className="content">
          <div className="page-heading">
            <div>
              <span className="eyebrow">EMAIL CAMPAIGNS</span>
              <h1>{tab === "scheduled" ? "Scheduled emails" : "Sent emails"}</h1>
              <p>{tab === "scheduled" ? "Keep track of every email in your queue." : "A record of emails sent from your workspace."}</p>
            </div>
            <button className="button primary" onClick={() => setComposeOpen(true)}><span>＋</span> Compose new email</button>
          </div>

          <div className="stats-row">
            <div className="stat-card"><span className="stat-icon purple">◷</span><div><small>Scheduled</small><strong>{tab === "scheduled" ? emails.length : "—"}</strong></div></div>
            <div className="stat-card"><span className="stat-icon green">↗</span><div><small>Sent successfully</small><strong>{tab === "sent" ? emails.filter((e) => e.status === "sent").length : "—"}</strong></div></div>
            <div className="stat-card"><span className="stat-icon amber">◎</span><div><small>Showing</small><strong>{emails.length} emails</strong></div></div>
          </div>

          <div className="list-card">
            <div className="list-toolbar">
              <div className="tabs">
                <button className={tab === "scheduled" ? "tab active-tab" : "tab"} onClick={() => setTab("scheduled")}>Scheduled</button>
                <button className={tab === "sent" ? "tab active-tab" : "tab"} onClick={() => setTab("sent")}>Sent</button>
              </div>
              <label className="search-box"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search emails" /></label>
            </div>
            <div className="table-scroll">
              <table>
                <thead><tr><th>RECIPIENT</th><th>SUBJECT</th><th>{tab === "scheduled" ? "SCHEDULED TIME" : "SENT TIME"}</th><th>STATUS</th></tr></thead>
                <tbody>
                  {listLoading ? <tr><td colSpan={4}><div className="table-state">Loading emails…</div></td></tr> :
                    emails.length === 0 ? <tr><td colSpan={4}><div className="empty-state"><span className="empty-icon">✉</span><strong>No {tab} emails yet</strong><span>{tab === "scheduled" ? "Compose a campaign to see it here." : "Emails you send will appear here."}</span></div></td></tr> :
                      emails.map((email) => <tr key={email.id}>
                        <td><span className="recipient-avatar">{email.recipient[0].toUpperCase()}</span><span className="recipient">{email.recipient}</span></td>
                        <td><span className="subject">{email.subject}</span><small className="sender">From {email.sender}</small></td>
                        <td>{formatDate(tab === "scheduled" ? email.scheduledAt : email.sentAt)}</td>
                        <td><span className={`status ${email.status}`}>{email.status}</span>{email.error && <small className="row-error" title={email.error}>See error</small>}</td>
                      </tr>)}
                </tbody>
              </table>
            </div>
            <footer className="table-footer">Showing {emails.length} {tab} emails <button onClick={() => void loadEmails()}>↻ Refresh</button></footer>
          </div>
          {error && <div className="inline-error">{error}<button onClick={() => setError("")}>×</button></div>}
        </section>
      </main>
      {composeOpen && <ComposeModal onClose={() => setComposeOpen(false)} onScheduled={(count) => {
        setComposeOpen(false);
        setTab("scheduled");
        setSearch("");
        showNotice(`${count} email${count === 1 ? "" : "s"} scheduled`);
        void loadEmails();
      }} onError={setError} />}
      {notice && <div className="toast">{notice}</div>}
    </div>
  );
}

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function ComposeModal({ onClose, onScheduled, onError }: {
  onClose: () => void;
  onScheduled: (count: number) => void;
  onError: (message: string) => void;
}) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sender, setSender] = useState("");
  const [addresses, setAddresses] = useState<string[]>([]);
  const [startAt, setStartAt] = useState(() => {
    const date = new Date(Date.now() + 5 * 60_000);
    date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
    return date.toISOString().slice(0, 16);
  });
  const [delaySeconds, setDelaySeconds] = useState(2);
  const [hourlyLimit, setHourlyLimit] = useState(100);
  const [submitting, setSubmitting] = useState(false);

  async function readFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      setAddresses(extractAddresses(await file.text()));
    } catch {
      onError("Could not read that file. Please use a CSV or text file.");
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!addresses.length) {
      onError("Upload a CSV or text file containing at least one email address.");
      return;
    }
    setSubmitting(true);
    try {
      const result = await api<{ scheduled: number }>("/api/emails/schedule", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          sender,
          subject,
          body,
          startAt: new Date(startAt).toISOString(),
          delayBetweenEmailsMs: delaySeconds * 1000,
          hourlyLimit,
          recipients: addresses
        })
      });
      onScheduled(result.scheduled);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : "Could not schedule emails");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="compose-modal">
        <header className="modal-header"><div><span className="eyebrow">NEW CAMPAIGN</span><h2>Compose email</h2></div><button className="close-button" onClick={onClose}>×</button></header>
        <form onSubmit={(event) => void submit(event)}>
          <label className="field">From<input type="email" required value={sender} onChange={(event) => setSender(event.target.value)} placeholder="you@example.com" /></label>
          <label className="field">Subject<input required maxLength={998} value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="A quick note for you" /></label>
          <label className="field">Email body<textarea required rows={5} value={body} onChange={(event) => setBody(event.target.value)} placeholder="Write your email…" /></label>
          <label className="field">Email leads <input type="file" accept=".csv,.txt,text/plain,text/csv" onChange={(event) => void readFile(event)} /></label>
          <div className="detected">{addresses.length ? `✓ ${addresses.length} unique email address${addresses.length === 1 ? "" : "es"} detected` : "Upload a CSV or text file with email addresses"}</div>
          <div className="form-grid">
            <label className="field">Start time<input type="datetime-local" required value={startAt} onChange={(event) => setStartAt(event.target.value)} /></label>
            <label className="field">Delay between emails (seconds)<input type="number" min="0" max="86400" value={delaySeconds} onChange={(event) => setDelaySeconds(Number(event.target.value))} /></label>
            <label className="field">Emails per hour<input type="number" min="1" value={hourlyLimit} onChange={(event) => setHourlyLimit(Number(event.target.value))} /><small>Maximum is controlled by your workspace configuration.</small></label>
          </div>
          <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button type="submit" className="button primary" disabled={submitting}>{submitting ? "Scheduling…" : `Schedule ${addresses.length || ""} emails`}</button></div>
        </form>
      </section>
    </div>
  );
}
