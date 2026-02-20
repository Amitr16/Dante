const express = require('express');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const DEV_NODB = process.env.DANTE_DEV_NODB === '1';
const DB_KIND = DEV_NODB ? 'mem' : (process.env.DANTE_DB || 'pg'); // mem|pg|sqlite

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

let pool = null;
let sqlite = null;

if (!DEV_NODB && DB_KIND === 'pg') {
  // Lazy-require pg so local DEV_NODB mode doesn't need DATABASE_URL
  // (still listed as a dependency for Render).
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false }
  });
}

if (!DEV_NODB && DB_KIND === 'sqlite') {
  const Database = require('better-sqlite3');
  const sqlitePath = process.env.DANTE_SQLITE_PATH || process.env.SQLITE_PATH || path.join(process.cwd(), 'dante.sqlite');
  sqlite = new Database(sqlitePath);
  // reasonable defaults
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
}

const DANTE_BOT_URL = process.env.DANTE_BOT_URL; // e.g. http://100.102.7.53:8787/chat
const DANTE_SHARED_SECRET = process.env.DANTE_SHARED_SECRET;

// In-memory store (DEV_NODB)
const mem = {
  users: new Set(),
  threads: new Map(), // threadId -> { thread_id, anon_user_id, title, created_at, updated_at }
  messages: new Map() // threadId -> [{ msg_id, role, content, created_at }]
};

// DB helpers (pg/sqlite)
function dbNow() {
  return new Date().toISOString();
}

async function dbHealth() {
  if (DEV_NODB) return { ok: true, db: false, devNoDb: true, kind: 'mem' };
  if (DB_KIND === 'pg') {
    const r = await pool.query('select 1 as ok');
    return { ok: true, db: r.rows[0].ok === 1, kind: 'pg' };
  }
  if (DB_KIND === 'sqlite') {
    // sanity query
    sqlite.prepare('select 1 as ok').get();
    return { ok: true, db: true, kind: 'sqlite', path: sqlite.name };
  }
  return { ok: false, db: false, kind: DB_KIND };
}

async function dbEnsureUser(anonUserId) {
  if (DEV_NODB) return;
  if (DB_KIND === 'pg') {
    await pool.query('insert into users(anon_user_id) values($1) on conflict do nothing', [anonUserId]);
    return;
  }
  if (DB_KIND === 'sqlite') {
    sqlite.prepare('insert or ignore into users(anon_user_id, created_at) values(?, ?)').run(anonUserId, dbNow());
    return;
  }
  throw new Error(`unsupported DB_KIND: ${DB_KIND}`);
}

async function dbCreateThread(threadId, anonUserId, title) {
  if (DEV_NODB) return;
  const cleanTitle = title || 'New chat';
  if (DB_KIND === 'pg') {
    await dbEnsureUser(anonUserId);
    await pool.query('insert into threads(thread_id, anon_user_id, title) values($1,$2,$3)', [threadId, anonUserId, cleanTitle]);
    return;
  }
  if (DB_KIND === 'sqlite') {
    await dbEnsureUser(anonUserId);
    const ts = dbNow();
    sqlite.prepare('insert into threads(thread_id, anon_user_id, title, created_at, updated_at) values(?,?,?,?,?)').run(threadId, anonUserId, cleanTitle, ts, ts);
    return;
  }
  throw new Error(`unsupported DB_KIND: ${DB_KIND}`);
}

async function dbListThreads(anonUserId) {
  if (DEV_NODB) return [];
  if (DB_KIND === 'pg') {
    const { rows } = await pool.query(
      'select thread_id, title, created_at, updated_at from threads where anon_user_id=$1 order by updated_at desc limit 100',
      [anonUserId]
    );
    return rows;
  }
  if (DB_KIND === 'sqlite') {
    return sqlite.prepare('select thread_id, title, created_at, updated_at from threads where anon_user_id=? order by updated_at desc limit 100').all(anonUserId);
  }
  throw new Error(`unsupported DB_KIND: ${DB_KIND}`);
}

async function dbThreadOwned(threadId, anonUserId) {
  if (DEV_NODB) return false;
  if (DB_KIND === 'pg') {
    const t = await pool.query('select 1 from threads where thread_id=$1 and anon_user_id=$2', [threadId, anonUserId]);
    return t.rowCount > 0;
  }
  if (DB_KIND === 'sqlite') {
    const r = sqlite.prepare('select 1 as ok from threads where thread_id=? and anon_user_id=?').get(threadId, anonUserId);
    return !!r;
  }
  throw new Error(`unsupported DB_KIND: ${DB_KIND}`);
}

async function dbRenameThread(threadId, anonUserId, title) {
  if (DEV_NODB) return;
  if (!(await dbThreadOwned(threadId, anonUserId))) {
    const err = new Error('thread not found');
    err.statusCode = 404;
    throw err;
  }

  if (DB_KIND === 'pg') {
    await pool.query('update threads set title=$1, updated_at=now() where thread_id=$2', [title, threadId]);
    return;
  }
  if (DB_KIND === 'sqlite') {
    sqlite.prepare('update threads set title=?, updated_at=? where thread_id=?').run(title, dbNow(), threadId);
    return;
  }
  throw new Error(`unsupported DB_KIND: ${DB_KIND}`);
}

async function dbInsertMessage(msgId, threadId, role, content) {
  if (DEV_NODB) return;
  if (DB_KIND === 'pg') {
    await pool.query('insert into messages(msg_id, thread_id, role, content) values($1,$2,$3,$4)', [msgId, threadId, role, content]);
    return;
  }
  if (DB_KIND === 'sqlite') {
    sqlite.prepare('insert into messages(msg_id, thread_id, role, content, created_at) values(?,?,?,?,?)').run(msgId, threadId, role, content, dbNow());
    return;
  }
  throw new Error(`unsupported DB_KIND: ${DB_KIND}`);
}

async function dbTouchThread(threadId) {
  if (DEV_NODB) return;
  if (DB_KIND === 'pg') {
    await pool.query('update threads set updated_at=now() where thread_id=$1', [threadId]);
    return;
  }
  if (DB_KIND === 'sqlite') {
    sqlite.prepare('update threads set updated_at=? where thread_id=?').run(dbNow(), threadId);
    return;
  }
  throw new Error(`unsupported DB_KIND: ${DB_KIND}`);
}

async function dbGetHistory(threadId) {
  if (DEV_NODB) return [];
  if (DB_KIND === 'pg') {
    const { rows } = await pool.query(
      'select msg_id, role, content, created_at from messages where thread_id=$1 order by created_at asc limit 500',
      [threadId]
    );
    return rows;
  }
  if (DB_KIND === 'sqlite') {
    return sqlite.prepare('select msg_id, role, content, created_at from messages where thread_id=? order by created_at asc limit 500').all(threadId);
  }
  throw new Error(`unsupported DB_KIND: ${DB_KIND}`);
}

async function migrate() {
  if (DEV_NODB) return;

  if (DB_KIND === 'pg') {
    const sql = `
    create table if not exists users (
      anon_user_id text primary key,
      created_at timestamptz not null default now()
    );

    create table if not exists threads (
      thread_id text primary key,
      anon_user_id text not null references users(anon_user_id) on delete cascade,
      title text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create index if not exists idx_threads_user_updated on threads(anon_user_id, updated_at desc);

    create table if not exists messages (
      msg_id text primary key,
      thread_id text not null references threads(thread_id) on delete cascade,
      role text not null check (role in ('user','assistant','system')),
      content text not null,
      created_at timestamptz not null default now()
    );
    create index if not exists idx_messages_thread_time on messages(thread_id, created_at asc);
    `;

    const client = await pool.connect();
    try {
      await client.query(sql);
    } finally {
      client.release();
    }
    return;
  }

  if (DB_KIND === 'sqlite') {
    // SQLite uses TEXT timestamps (ISO strings)
    const sql = `
    create table if not exists users (
      anon_user_id text primary key,
      created_at text not null
    );

    create table if not exists threads (
      thread_id text primary key,
      anon_user_id text not null,
      title text,
      created_at text not null,
      updated_at text not null,
      foreign key (anon_user_id) references users(anon_user_id) on delete cascade
    );
    create index if not exists idx_threads_user_updated on threads(anon_user_id, updated_at desc);

    create table if not exists messages (
      msg_id text primary key,
      thread_id text not null,
      role text not null,
      content text not null,
      created_at text not null,
      foreign key (thread_id) references threads(thread_id) on delete cascade
    );
    create index if not exists idx_messages_thread_time on messages(thread_id, created_at asc);
    `;

    sqlite.exec(sql);
    return;
  }

  throw new Error(`unsupported DB_KIND: ${DB_KIND}`);
}

function requireParam(v, name) {
  if (v === undefined || v === null || v === '') {
    const err = new Error(`missing ${name}`);
    err.statusCode = 400;
    throw err;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function memEnsureUser(anonUserId) {
  mem.users.add(anonUserId);
}

function memEnsureThreadOwned(threadId, anonUserId) {
  const t = mem.threads.get(threadId);
  if (!t || t.anon_user_id !== anonUserId) return null;
  return t;
}

app.get('/api/health', async (_req, res) => {
  try {
    const h = await dbHealth();
    res.json({ ok: true, ...h });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// List threads
app.get('/api/threads', async (req, res) => {
  try {
    const anonUserId = req.query.anonUserId;
    requireParam(anonUserId, 'anonUserId');

    if (DEV_NODB) {
      const threads = [];
      for (const t of mem.threads.values()) {
        if (t.anon_user_id === anonUserId) threads.push(t);
      }
      threads.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
      return res.json({ ok: true, threads: threads.slice(0, 100) });
    }

    const threads = await dbListThreads(anonUserId);
    res.json({ ok: true, threads });
  } catch (e) {
    res.status(e.statusCode || 500).json({ ok: false, error: e.message || String(e) });
  }
});

// Create a new thread
app.post('/api/threads', async (req, res) => {
  try {
    const { anonUserId, title } = req.body || {};
    requireParam(anonUserId, 'anonUserId');

    const threadId = uuidv4();

    if (DEV_NODB) {
      memEnsureUser(anonUserId);
      const ts = nowIso();
      mem.threads.set(threadId, {
        thread_id: threadId,
        anon_user_id: anonUserId,
        title: title || 'New chat',
        created_at: ts,
        updated_at: ts
      });
      mem.messages.set(threadId, []);
      return res.json({ ok: true, threadId });
    }

    await dbCreateThread(threadId, anonUserId, title);
    res.json({ ok: true, threadId });
  } catch (e) {
    res.status(e.statusCode || 500).json({ ok: false, error: e.message || String(e) });
  }
});

// Rename a thread title
app.patch('/api/threads/:threadId', async (req, res) => {
  try {
    const { threadId } = req.params;
    const { anonUserId, title } = req.body || {};
    requireParam(anonUserId, 'anonUserId');
    requireParam(threadId, 'threadId');
    requireParam(title, 'title');

    const cleanTitle = String(title).trim().slice(0, 80);
    if (!cleanTitle) return res.status(400).json({ ok: false, error: 'title empty' });

    if (DEV_NODB) {
      const t = memEnsureThreadOwned(threadId, anonUserId);
      if (!t) return res.status(404).json({ ok: false, error: 'thread not found' });
      t.title = cleanTitle;
      t.updated_at = nowIso();
      return res.json({ ok: true });
    }

    await dbRenameThread(threadId, anonUserId, cleanTitle);
    return res.json({ ok: true });
  } catch (e) {
    res.status(e.statusCode || 500).json({ ok: false, error: e.message || String(e) });
  }
});

// Get history
app.get('/api/history', async (req, res) => {
  try {
    const anonUserId = req.query.anonUserId;
    const threadId = req.query.threadId;
    requireParam(anonUserId, 'anonUserId');
    requireParam(threadId, 'threadId');

    if (DEV_NODB) {
      const t = memEnsureThreadOwned(threadId, anonUserId);
      if (!t) return res.status(404).json({ ok: false, error: 'thread not found' });
      const msgs = mem.messages.get(threadId) || [];
      return res.json({ ok: true, messages: msgs.slice(0, 500) });
    }

    // Ensure thread belongs to user
    if (!(await dbThreadOwned(threadId, anonUserId))) {
      return res.status(404).json({ ok: false, error: 'thread not found' });
    }

    const msgs = await dbGetHistory(threadId);
    res.json({ ok: true, messages: msgs });
  } catch (e) {
    res.status(e.statusCode || 500).json({ ok: false, error: e.message || String(e) });
  }
});

// Chat
app.post('/api/chat', async (req, res) => {
  try {
    const { anonUserId, threadId, text } = req.body || {};
    requireParam(anonUserId, 'anonUserId');
    requireParam(threadId, 'threadId');
    requireParam(text, 'text');

    if (!DANTE_BOT_URL || !DANTE_SHARED_SECRET) {
      return res.status(500).json({ ok: false, error: 'server not configured: missing DANTE_BOT_URL or DANTE_SHARED_SECRET' });
    }

    if (DEV_NODB) {
      const t = memEnsureThreadOwned(threadId, anonUserId);
      if (!t) return res.status(404).json({ ok: false, error: 'thread not found' });

      const userMsg = { msg_id: uuidv4(), role: 'user', content: text, created_at: nowIso() };
      mem.messages.get(threadId).push(userMsg);
      t.updated_at = nowIso();

      const r = await fetch(DANTE_BOT_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-dante-secret': DANTE_SHARED_SECRET
        },
        body: JSON.stringify({ anonUserId, threadId, text })
      });

      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) {
        const detail = j && (j.error || j.message) ? (j.error || j.message) : `HTTP ${r.status}`;
        throw new Error(`bot error: ${detail}`);
      }

      const reply = j.reply;
      const asstMsg = { msg_id: uuidv4(), role: 'assistant', content: reply, created_at: nowIso() };
      mem.messages.get(threadId).push(asstMsg);
      t.updated_at = nowIso();

      return res.json({ ok: true, reply });
    }

    // Ensure thread belongs to user
    if (!(await dbThreadOwned(threadId, anonUserId))) {
      return res.status(404).json({ ok: false, error: 'thread not found' });
    }

    const userMsgId = uuidv4();
    await dbInsertMessage(userMsgId, threadId, 'user', text);
    await dbTouchThread(threadId);

    // Call Mac relay
    let j;

    // In Render userspace-networking mode, normal TCP routing to tailnet IPs may not work.
    // Use tailscaled's SOCKS5 server + system curl (more portable than `tailscale curl`).
    if (process.env.TAILSCALE_SOCKS5) {
      const { execFile } = require('child_process');
      const payload = JSON.stringify({ anonUserId, threadId, text });
      const args = [
        '-sS',
        '--fail-with-body',
        '--socks5-hostname', process.env.TAILSCALE_SOCKS5.replace(/^https?:\/\//, ''),
        '-X', 'POST',
        '-H', 'Content-Type: application/json',
        '-H', `x-dante-secret: ${DANTE_SHARED_SECRET}`,
        '--data-binary', payload,
        DANTE_BOT_URL
      ];

      j = await new Promise((resolve, reject) => {
        execFile('curl', args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
          if (err) return reject(new Error(`tailscale proxy curl failed: ${stderr || err.message || String(err)}`));
          try {
            resolve(JSON.parse(stdout));
          } catch (e) {
            reject(new Error(`tailscale proxy curl non-json reply: ${String(stdout).slice(0, 400)}`));
          }
        });
      });

      if (!j || !j.ok) {
        const detail = j && (j.error || j.message) ? (j.error || j.message) : 'unknown bot error';
        throw new Error(`bot error: ${detail}`);
      }
    } else {
      const r = await fetch(DANTE_BOT_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-dante-secret': DANTE_SHARED_SECRET
        },
        body: JSON.stringify({ anonUserId, threadId, text })
      });

      j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) {
        const detail = j && (j.error || j.message) ? (j.error || j.message) : `HTTP ${r.status}`;
        throw new Error(`bot error: ${detail}`);
      }
    }

    const reply = j.reply;
    const asstMsgId = uuidv4();
    await dbInsertMessage(asstMsgId, threadId, 'assistant', reply);
    await dbTouchThread(threadId);

    res.json({ ok: true, reply });
  } catch (e) {
    res.status(e.statusCode || 500).json({ ok: false, error: e.message || String(e) });
  }
});

(async () => {
  await migrate();
  app.listen(PORT, () => console.log(`dante-web-render listening on :${PORT} (DEV_NODB=${DEV_NODB ? '1' : '0'})`));
})().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
