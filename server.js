/**
 * FermaApp — AndBillur Ferma boshqaruv tizimi
 * server.js v4 — Family Tree + Warehouse (Ombor) + Equipment (Texnika)
 *
 * CHANGELOG v3:
 * 1. [NEW] animals.father_id / mother_id — ota/ona FK (nullable)
 * 2. [NEW] animals.father_unknown / mother_unknown — suniy urug'lantirish yoki sotib olingan
 * 3. [NEW] animals.acquisition_type — 'born' | 'purchased'
 * 4. [NEW] animals.temp_no_milk — TEXT[] vaqtinchalik sut bermayapti sabablar
 * 5. [NEW] GET /animals/:id/family — oila daraxti (ota, ona, bolalar)
 * 6. [NEW] PUT /animals/:id/family — ota/ona va acquisition_type ni saqlash
 * 7. [NEW] PUT /animals/:id/temp-no-milk — vaqtinchalik sut bermayapti sabablar
 * 8. [FIX] GET /milk/daily — Buqa, Bozak, Sotilgan, Soyilgan, Nobud, va temp_no_milk
 *          mollarini sut ro'yxatidan chiqaradi
 * 9. All previous v2 bug fixes preserved
 */

'use strict';

const http     = require('http');
const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');
const { Pool } = require('pg');

const PORT       = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const SALT       = 'ferma-app-salt-2024';
const sessions   = {};

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// ---------------------------------------------------------------------------
// Database Initialisation
// ---------------------------------------------------------------------------
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id         VARCHAR(32)  PRIMARY KEY,
        username   VARCHAR(50)  UNIQUE NOT NULL,
        password   VARCHAR(64)  NOT NULL,
        role       VARCHAR(20)  DEFAULT 'user',
        name       VARCHAR(100),
        created_at TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS animals (
        id                VARCHAR(32)  PRIMARY KEY,
        tag_number        VARCHAR(50)  UNIQUE NOT NULL,
        name              VARCHAR(100),
        type              VARCHAR(20),
        gender            VARCHAR(20),
        status            VARCHAR(30),
        births            INTEGER      DEFAULT 0,
        daily_milk        DECIMAL(5,2) DEFAULT 0,
        birth_date        DATE,
        last_calving_date DATE,
        insemination_date DATE,
        notes             TEXT,
        -- Family tree
        father_id         VARCHAR(32)  REFERENCES animals(id) ON DELETE SET NULL,
        mother_id         VARCHAR(32)  REFERENCES animals(id) ON DELETE SET NULL,
        father_unknown    BOOLEAN      DEFAULT false,
        mother_unknown    BOOLEAN      DEFAULT false,
        acquisition_type  VARCHAR(20)  DEFAULT 'born',
        temp_no_milk      TEXT[],
        created_at        TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
        updated_at        TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Safe migration for existing DBs
    const safeAlter = async (sql) => pool.query(sql).catch(() => {});
    await safeAlter(`ALTER TABLE animals ADD COLUMN IF NOT EXISTS insemination_date    DATE`);
    await safeAlter(`ALTER TABLE animals ADD COLUMN IF NOT EXISTS last_calving_date    DATE`);
    await safeAlter(`ALTER TABLE animals ADD COLUMN IF NOT EXISTS updated_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP`);
    await safeAlter(`ALTER TABLE animals ADD COLUMN IF NOT EXISTS father_id            VARCHAR(32) REFERENCES animals(id) ON DELETE SET NULL`);
    await safeAlter(`ALTER TABLE animals ADD COLUMN IF NOT EXISTS mother_id            VARCHAR(32) REFERENCES animals(id) ON DELETE SET NULL`);
    await safeAlter(`ALTER TABLE animals ADD COLUMN IF NOT EXISTS father_unknown       BOOLEAN DEFAULT false`);
    await safeAlter(`ALTER TABLE animals ADD COLUMN IF NOT EXISTS mother_unknown       BOOLEAN DEFAULT false`);
    await safeAlter(`ALTER TABLE animals ADD COLUMN IF NOT EXISTS acquisition_type     VARCHAR(20) DEFAULT 'born'`);
    await safeAlter(`ALTER TABLE animals ADD COLUMN IF NOT EXISTS temp_no_milk         TEXT[]`);

    // milk_records — price is NOT stored here (production records only)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS milk_records (
        id         VARCHAR(32)  PRIMARY KEY,
        animal_id  VARCHAR(32)  REFERENCES animals(id) ON DELETE SET NULL,
        date       DATE         NOT NULL,
        session    INTEGER      NOT NULL,
        liters     DECIMAL(6,2),
        notes      TEXT,
        created_at TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await safeAlter(`ALTER TABLE milk_records DROP COLUMN IF EXISTS price`);
    await safeAlter(`ALTER TABLE milk_records ADD COLUMN IF NOT EXISTS notes TEXT`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS milk_sales (
        id         VARCHAR(32)   PRIMARY KEY,
        date       DATE          NOT NULL,
        liters     DECIMAL(6,2)  NOT NULL,
        price      DECIMAL(8,2)  NOT NULL,
        total      DECIMAL(10,2) NOT NULL,
        buyer      VARCHAR(100)  NOT NULL,
        phone      VARCHAR(20),
        notes      TEXT,
        created_at TIMESTAMP     DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS expenses (
        id          VARCHAR(32)   PRIMARY KEY,
        category    VARCHAR(50)   NOT NULL,
        amount      DECIMAL(10,2) NOT NULL,
        description TEXT,
        date        DATE          NOT NULL,
        created_at  TIMESTAMP     DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS animal_sales (
        id         VARCHAR(32)   PRIMARY KEY,
        animal_id  VARCHAR(32)   REFERENCES animals(id) ON DELETE SET NULL,
        price      DECIMAL(10,2) DEFAULT 0,
        buyer_name VARCHAR(100),
        reason     VARCHAR(30),
        weight_kg  DECIMAL(6,2),
        date       DATE          NOT NULL,
        notes      TEXT,
        created_at TIMESTAMP     DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await safeAlter(`ALTER TABLE animal_sales ADD COLUMN IF NOT EXISTS reason    VARCHAR(30)`);
    await safeAlter(`ALTER TABLE animal_sales ADD COLUMN IF NOT EXISTS weight_kg DECIMAL(6,2)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS password_resets (
        id         SERIAL    PRIMARY KEY,
        username   TEXT      NOT NULL,
        code       TEXT      NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        used       BOOLEAN   DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Indexes
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_milk_date     ON milk_records(date)`);
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_milk_animal   ON milk_records(animal_id)`);
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_ms_date       ON milk_sales(date)`);
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_exp_date      ON expenses(date)`);
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_animal_tag    ON animals(tag_number)`);
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_animal_status ON animals(status)`);
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_animal_father ON animals(father_id)`);
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_animal_mother ON animals(mother_id)`);
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_pw_reset_user ON password_resets(username)`);

    // Fix bad status values
    await pool.query(`UPDATE animals SET status='soyildi' WHERE status='soyish'`).catch(() => {});

    // Default admin user
    const ex = await pool.query(`SELECT id FROM users WHERE username=$1`, ['admin']);
    if (!ex.rows.length) {
      await pool.query(
        `INSERT INTO users (id,username,password,role,name) VALUES ($1,$2,$3,$4,$5)`,
        [uuid(), 'admin', hashPassword('admin123'), 'admin', 'Admin']
      );
    }

    await pool.query(`DELETE FROM password_resets WHERE expires_at < NOW() - INTERVAL '1 day'`).catch(() => {});


    // ── Warehouse & Equipment tables (v4 upgrade) ──────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS warehouse_items (
        id           VARCHAR(32)     PRIMARY KEY,
        name         TEXT            NOT NULL,
        category     VARCHAR(30)     DEFAULT 'boshqa',
        unit         VARCHAR(20)     DEFAULT 'kg',
        current_qty  DECIMAL(10,3)   DEFAULT 0,
        min_qty      DECIMAL(10,3)   DEFAULT 0,
        notes        TEXT,
        created_at   TIMESTAMP       DEFAULT CURRENT_TIMESTAMP,
        updated_at   TIMESTAMP       DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS warehouse_transactions (
        id         VARCHAR(32)   PRIMARY KEY,
        item_id    VARCHAR(32)   REFERENCES warehouse_items(id) ON DELETE SET NULL,
        type       VARCHAR(3)    NOT NULL CHECK (type IN ('in','out')),
        qty        DECIMAL(10,3) NOT NULL,
        date       DATE          DEFAULT CURRENT_DATE,
        price      DECIMAL(12,2) DEFAULT 0,
        notes      TEXT,
        created_at TIMESTAMP     DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS equipment (
        id           VARCHAR(32)  PRIMARY KEY,
        name         TEXT         NOT NULL,
        type         VARCHAR(30)  DEFAULT 'boshqa',
        status       VARCHAR(20)  DEFAULT 'working' CHECK (status IN ('working','repair','inactive')),
        last_service DATE,
        next_service DATE,
        notes        TEXT,
        created_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
        updated_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_wh_tx_item   ON warehouse_transactions(item_id)`);
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_wh_tx_date   ON warehouse_transactions(date)`);
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_equip_status ON equipment(status)`);

    console.log('DB ready (v4 — Warehouse + Equipment)');
  } catch (e) {
    console.error('DB init error:', e);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function uuid()          { return crypto.randomBytes(16).toString('hex'); }
function hashPassword(p) { return crypto.createHash('sha256').update(p + SALT).digest('hex'); }

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions[token] = { userId, at: Date.now() };
  return token;
}

function getSession(token) {
  if (!token) return null;
  const s = sessions[token];
  if (!s) return null;
  if (Date.now() - s.at > 86400000) { delete sessions[token]; return null; }
  return s;
}

function auth(req) {
  const token = req.headers['x-session-token'] || (req.cookies && req.cookies.token);
  const s = getSession(token);
  if (!s) return Promise.resolve(null);
  return pool.query('SELECT * FROM users WHERE id=$1', [s.userId])
    .then(r => r.rows[0] || null)
    .catch(() => null);
}

function adminAuth(req) {
  return auth(req).then(u => (u && u.role === 'admin') ? u : null);
}

function parseBody(req) {
  return new Promise(res => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => { try { res(JSON.parse(b)); } catch { res({}); } });
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type':                'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers':'Content-Type, x-session-token',
    'Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS',
  });
  res.end(JSON.stringify(data));
}

function serveStatic(res, filePath) {
  const ext   = path.extname(filePath);
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
    res.end(content);
  } catch { res.writeHead(404); res.end('Not found'); }
}

/**
 * pathId() — strips /api prefix before splitting so dynamic route IDs work
 * correctly.  See v2 BUG FIX #1 for full explanation.
 */
function pathId(url, pos) {
  const apiPath = new URL(url, 'http://localhost').pathname.replace('/api', '');
  return apiPath.split('/')[pos] || '';
}

function parseCookies(req) {
  return (req.headers.cookie || '').split(';').reduce((acc, c) => {
    const [k, ...v] = c.trim().split('=');
    if (k) acc[k.trim()] = v.join('=').trim();
    return acc;
  }, {});
}

// ---------------------------------------------------------------------------
// Statuses that can NEVER produce milk
// ---------------------------------------------------------------------------
const NEVER_MILK_STATUSES = ['sotildi', 'nobud', 'soyildi', 'buqa', 'bozak', 'sotib_olingan_bozak'];

// Statuses that CAN be in milk daily list but may be temporarily blocked
const ACTIVE_STATUSES_FOR_MILK = ['sut_beradi', 'kasal', 'bogoz'];

// ---------------------------------------------------------------------------
// Email (nodemailer — optional)
// ---------------------------------------------------------------------------
let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (_) {}

function buildTransporter() {
  if (!nodemailer) return null;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!pass) return null;
  return nodemailer.createTransport({
    service: 'gmail',
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: 'info@andbillur.com', pass },
    tls: { rejectUnauthorized: false },
  });
}

async function sendResetEmail({ code, displayName, ip, device, expiresAt }) {
  const expireTime = new Date(expiresAt).toLocaleString('uz-UZ', {
    timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit',
  });
  const dateTime = new Date().toLocaleString('uz-UZ', {
    timeZone: 'Asia/Tashkent',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });

  const htmlBody = `
<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#1e293b">
  <div style="background:#1d4ed8;padding:20px 24px;border-radius:12px 12px 0 0">
    <h2 style="color:#fff;margin:0;font-size:18px">AndBillur Ferma tizimi</h2>
  </div>
  <div style="border:1px solid #e2e8f0;border-top:none;padding:28px 24px;border-radius:0 0 12px 12px">
    <p>Salom <strong>${displayName}</strong>,</p>
    <p>Parolni o'zgartirish so'rovi.</p>
    <div style="background:#eff6ff;border:2px solid #bfdbfe;border-radius:10px;padding:24px;text-align:center;margin:24px 0">
      <div style="font-size:36px;font-weight:700;letter-spacing:8px;color:#1d4ed8">${code}</div>
      <p style="color:#64748b;font-size:13px">Amal qilish muddati: <strong>${expireTime}</strong></p>
    </div>
    <p style="color:#94a3b8;font-size:12px">${dateTime} | IP: ${ip} | ${device}</p>
  </div>
</div>`;

  const transporter = buildTransporter();
  if (transporter) {
    try {
      await transporter.sendMail({
        from: '"AndBillur Ferma" <info@andbillur.com>',
        to: 'info@andbillur.com',
        subject: `Parolni o'zgartirish — ${displayName}`,
        html: htmlBody,
      });
      return true;
    } catch (err) {
      console.error('Email send failed:', err.message);
      return false;
    }
  } else {
    console.log(`\n=== RESET CODE for ${displayName}: ${code} (expires ${expireTime}) ===\n`);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Route Handlers
// ---------------------------------------------------------------------------
const routes = {

  // ── Auth ───────────────────────────────────────────────────────────────────
  'POST:/login': async (req, res) => {
    const { username, password } = await parseBody(req);
    if (!username || !password) return json(res, { error: 'Login va parol kerak' }, 400);
    const r = await pool.query(
      'SELECT * FROM users WHERE username=$1 AND password=$2',
      [username, hashPassword(password)]
    );
    if (!r.rows[0]) return json(res, { error: "Noto'g'ri login yoki parol" }, 401);
    const user  = r.rows[0];
    const token = createSession(user.id);
    const isProd = process.env.NODE_ENV === 'production';
    res.setHeader('Set-Cookie', `token=${token}; Path=/; HttpOnly; SameSite=Lax${isProd ? '; Secure' : ''}`);
    json(res, { token, user: { id: user.id, username: user.username, role: user.role, name: user.name } });
  },

  'GET:/me': async (req, res) => {
    const u = await auth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    json(res, { id: u.id, username: u.username, role: u.role, name: u.name });
  },

  'POST:/logout': async (req, res) => {
    const token = req.headers['x-session-token'] || (req.cookies && req.cookies.token);
    if (token) delete sessions[token];
    res.setHeader('Set-Cookie', 'token=; Path=/; Max-Age=0');
    json(res, { success: true });
  },

  // ── Password Reset ─────────────────────────────────────────────────────────
  'POST:/admin/password-reset-request': async (req, res) => {
    try {
      const { username } = await parseBody(req);
      if (!username || username.trim().length < 2) {
        return json(res, { error: 'Username kerak (kamida 2 belgi)' }, 400);
      }
      const uname = username.trim();
      const userRow = await pool.query('SELECT id, name, role FROM users WHERE username=$1', [uname]);
      if (!userRow.rows[0]) return json(res, { success: true, message: 'Tasdiqlash kodi admin emailiga yuborildi' });
      if (userRow.rows[0].role !== 'admin') return json(res, { error: 'Faqat admin parolini tiklash mumkin' }, 403);

      const code      = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
      await pool.query('INSERT INTO password_resets (username, code, expires_at) VALUES ($1, $2, $3)', [uname, code, expiresAt]);

      const ip     = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'Unknown';
      const device = (req.headers['user-agent'] || 'Unknown').substring(0, 150);
      const sent   = await sendResetEmail({ code, displayName: userRow.rows[0].name || uname, ip, device, expiresAt });

      if (!sent) return json(res, { error: "Email yuborishda xatolik." }, 500);
      json(res, { success: true, message: 'Tasdiqlash kodi admin emailiga yuborildi' });
    } catch (e) {
      console.error('password-reset-request error:', e);
      json(res, { error: 'Server xatosi' }, 500);
    }
  },

  'POST:/admin/password-reset-confirm': async (req, res) => {
    try {
      const { username, code, newPassword } = await parseBody(req);
      if (!username || !code || !newPassword) return json(res, { error: 'Username, kod va yangi parol kerak' }, 400);
      if (newPassword.length < 6) return json(res, { error: "Parol kamida 6 belgidan iborat bo'lishi kerak" }, 400);

      const resetRow = await pool.query(
        `SELECT id, expires_at, used FROM password_resets WHERE username=$1 AND code=$2 ORDER BY created_at DESC LIMIT 1`,
        [username, code]
      );
      if (!resetRow.rows[0]) return json(res, { error: "Noto'g'ri tasdiqlash kodi" }, 400);
      const reset = resetRow.rows[0];
      if (reset.used) return json(res, { error: 'Bu kod allaqachon ishlatilgan' }, 400);
      if (new Date() > new Date(reset.expires_at)) return json(res, { error: "Kodning muddati o'tgan." }, 400);

      const userRow = await pool.query('SELECT id, role FROM users WHERE username=$1', [username]);
      if (!userRow.rows[0]) return json(res, { error: 'Foydalanuvchi topilmadi' }, 404);
      if (userRow.rows[0].role !== 'admin') return json(res, { error: 'Faqat admin parolini tiklash mumkin' }, 403);

      await pool.query('UPDATE users SET password=$1 WHERE id=$2', [hashPassword(newPassword), userRow.rows[0].id]);
      await pool.query('UPDATE password_resets SET used=true WHERE id=$1', [reset.id]);
      json(res, { success: true, message: "Parol muvaffaqiyatli o'zgartirildi" });
    } catch (e) {
      console.error('password-reset-confirm error:', e);
      json(res, { error: 'Server xatosi' }, 500);
    }
  },

  // ── Stats ──────────────────────────────────────────────────────────────────
  'GET:/stats/dashboard': async (req, res) => {
    const u = await auth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    try {
      const [aStats, milkToday, milk7, revToday, recentSales] = await Promise.all([
        pool.query(`
          SELECT
            COUNT(*) FILTER (WHERE status NOT IN ('sotildi','nobud','soyildi')) AS total,
            COUNT(*) FILTER (WHERE status='sut_beradi') AS sut,
            COUNT(*) FILTER (WHERE status='kasal')      AS kasal,
            COUNT(*) FILTER (WHERE status='bogoz')      AS bogoz,
            COUNT(*) FILTER (WHERE status='bozak')      AS bozak
          FROM animals
        `),
        pool.query(`SELECT COALESCE(SUM(liters),0) AS liters FROM milk_records WHERE date=CURRENT_DATE`),
        pool.query(`
          SELECT date::text, SUM(liters) AS liters
            FROM milk_records
           WHERE date >= CURRENT_DATE - INTERVAL '6 days'
           GROUP BY date ORDER BY date
        `),
        pool.query(`SELECT COALESCE(SUM(total),0) AS total FROM milk_sales WHERE date=CURRENT_DATE`),
        pool.query(`SELECT * FROM milk_sales ORDER BY date DESC, created_at DESC LIMIT 6`),
      ]);

      const last7 = [];
      for (let i = 6; i >= 0; i--) {
        const d  = new Date(); d.setDate(d.getDate() - i);
        const ds = d.toISOString().split('T')[0];
        const found = milk7.rows.find(r => r.date === ds);
        last7.push({ date: ds, liters: found ? parseFloat(found.liters) : 0 });
      }
      const s = aStats.rows[0];
      json(res, {
        todayLiters:  parseFloat(milkToday.rows[0].liters),
        todayRevenue: parseFloat(revToday.rows[0].total),
        last7,
        animalStats: {
          total: parseInt(s.total),
          sut:   parseInt(s.sut),
          kasal: parseInt(s.kasal),
          bogoz: parseInt(s.bogoz),
          bozak: parseInt(s.bozak),
        },
        recentMilk: recentSales.rows.map(r => ({
          ...r,
          liters: parseFloat(r.liters),
          price:  parseFloat(r.price),
          total:  parseFloat(r.total),
        })),
      });
    } catch (e) {
      console.error('dashboard error:', e);
      json(res, { error: 'Server xatosi' }, 500);
    }
  },

  'GET:/stats/finance': async (req, res) => {
    const u = await auth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    try {
      const { period = 'month' } = new URL(req.url, 'http://localhost').searchParams;
      let cond, grp;
      switch (period) {
        case 'day':   cond = "date=CURRENT_DATE";                       grp = "date::text"; break;
        case 'week':  cond = "date>=CURRENT_DATE-INTERVAL '6 days'";    grp = "date::text"; break;
        case 'month': cond = "date>=CURRENT_DATE-INTERVAL '29 days'";   grp = "date::text"; break;
        case 'year':  cond = "date>=CURRENT_DATE-INTERVAL '364 days'";  grp = "to_char(date,'YYYY-MM')"; break;
        default:      cond = "date>=CURRENT_DATE-INTERVAL '29 days'";   grp = "date::text";
      }
      const [ms, ex, as2, byCatR, msC, exC] = await Promise.all([
        pool.query(`SELECT COALESCE(SUM(total),0) AS rev, COALESCE(SUM(liters),0) AS liters FROM milk_sales   WHERE ${cond}`),
        pool.query(`SELECT COALESCE(SUM(amount),0) AS tot, COUNT(*) AS cnt              FROM expenses     WHERE ${cond}`),
        pool.query(`SELECT COALESCE(SUM(price),0)  AS rev, COUNT(*) AS cnt              FROM animal_sales WHERE ${cond}`),
        pool.query(`SELECT category, SUM(amount) AS tot FROM expenses WHERE ${cond} GROUP BY category ORDER BY tot DESC`),
        pool.query(`SELECT ${grp} AS d, COALESCE(SUM(total),0)  AS income  FROM milk_sales WHERE ${cond} GROUP BY d ORDER BY d`),
        pool.query(`SELECT ${grp} AS d, COALESCE(SUM(amount),0) AS expense FROM expenses  WHERE ${cond} GROUP BY d ORDER BY d`),
      ]);
      const map = {};
      msC.rows.forEach(r => { map[r.d] = { date: r.d, income: parseFloat(r.income), expense: 0 }; });
      exC.rows.forEach(r => {
        if (map[r.d]) map[r.d].expense = parseFloat(r.expense);
        else          map[r.d] = { date: r.d, income: 0, expense: parseFloat(r.expense) };
      });
      const byCat = {};
      byCatR.rows.forEach(r => { byCat[r.category] = parseFloat(r.tot); });

      json(res, {
        milkRevenue:  parseFloat(ms.rows[0].rev),
        milkLiters:   parseFloat(ms.rows[0].liters),
        salesRevenue: parseFloat(as2.rows[0].rev),
        salesCount:   parseInt(as2.rows[0].cnt),
        totalExpenses: parseFloat(ex.rows[0].tot),
        expCount:     parseInt(ex.rows[0].cnt),
        netProfit:    parseFloat(ms.rows[0].rev) + parseFloat(as2.rows[0].rev) - parseFloat(ex.rows[0].tot),
        chart:        Object.values(map).sort((a, b) => a.date.localeCompare(b.date)),
        byCat,
      });
    } catch (e) {
      console.error('finance error:', e);
      json(res, { error: 'Server xatosi' }, 500);
    }
  },

  // ── Animals ────────────────────────────────────────────────────────────────
  'GET:/animals': async (req, res) => {
    const u = await auth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    try {
      const sp     = new URL(req.url, 'http://localhost').searchParams;
      const search = sp.get('search'), status = sp.get('status');
      const page   = parseInt(sp.get('page') || '1');
      const limit  = parseInt(sp.get('limit') || '200');
      const conds  = [], params = [];
      if (search) {
        conds.push(`(tag_number ILIKE $${params.length + 1} OR name ILIKE $${params.length + 1})`);
        params.push(`%${search}%`);
      }
      if (status) { conds.push(`status=$${params.length + 1}`); params.push(status); }
      const where = conds.length ? ' WHERE ' + conds.join(' AND ') : '';
      params.push(limit, (page - 1) * limit);
      const r = await pool.query(
        `SELECT * FROM animals${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );
      json(res, r.rows);
    } catch (e) {
      console.error('GET /animals error:', e);
      json(res, { error: 'Server xatosi' }, 500);
    }
  },

  'POST:/animals': async (req, res) => {
    const u = await auth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    try {
      const d = await parseBody(req);
      if (!d.tag_number) return json(res, { error: 'Quloq raqami kerak' }, 400);
      const ex = await pool.query('SELECT id FROM animals WHERE tag_number=$1', [d.tag_number]);
      if (ex.rows.length) return json(res, { error: `"${d.tag_number}" quloq raqami allaqachon mavjud` }, 400);
      const id = uuid();

      // Validate father/mother IDs if provided
      if (d.father_id) {
        const fa = await pool.query('SELECT id FROM animals WHERE id=$1', [d.father_id]);
        if (!fa.rows.length) return json(res, { error: 'Ota mol topilmadi' }, 400);
      }
      if (d.mother_id) {
        const mo = await pool.query('SELECT id FROM animals WHERE id=$1', [d.mother_id]);
        if (!mo.rows.length) return json(res, { error: 'Ona mol topilmadi' }, 400);
      }

      await pool.query(
        `INSERT INTO animals
           (id, tag_number, name, type, gender, status, births, daily_milk,
            birth_date, last_calving_date, insemination_date, notes,
            father_id, mother_id, father_unknown, mother_unknown, acquisition_type, temp_no_milk)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [
          id, d.tag_number, d.name || null,
          d.type || 'sigir', d.gender || 'female',
          d.status || 'sut_beradi',
          d.births || 0, d.daily_milk || 0,
          d.birth_date || null, d.last_calving_date || null,
          d.insemination_date || null, d.notes || null,
          d.father_id || null, d.mother_id || null,
          d.father_unknown || false, d.mother_unknown || false,
          d.acquisition_type || 'born',
          d.temp_no_milk && d.temp_no_milk.length ? d.temp_no_milk : null,
        ]
      );
      const r = await pool.query('SELECT * FROM animals WHERE id=$1', [id]);
      json(res, r.rows[0]);
    } catch (e) {
      console.error('POST /animals error:', e);
      json(res, { error: 'Xatolik: ' + e.message }, 400);
    }
  },

  'PUT:/animals/:id': async (req, res) => {
    const u = await auth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    try {
      const id = pathId(req.url, 2);
      if (!id) return json(res, { error: 'Animal ID kerak' }, 400);
      const d = await parseBody(req);
      if (!d.tag_number) return json(res, { error: 'Quloq raqami kerak' }, 400);

      const current = await pool.query('SELECT id, tag_number FROM animals WHERE id=$1', [id]);
      if (!current.rows[0]) return json(res, { error: 'Mol topilmadi' }, 404);

      if (current.rows[0].tag_number !== d.tag_number) {
        const conflict = await pool.query('SELECT id, name FROM animals WHERE tag_number=$1 AND id!=$2', [d.tag_number, id]);
        if (conflict.rows.length) {
          return json(res, {
            error: `"${d.tag_number}" quloq raqami allaqachon mavjud` + (conflict.rows[0].name ? ` (${conflict.rows[0].name})` : ''),
          }, 400);
        }
      }

      // Prevent self-reference
      if (d.father_id === id) return json(res, { error: 'Mol o\'z otasi bo\'la olmaydi' }, 400);
      if (d.mother_id === id) return json(res, { error: 'Mol o\'z onasi bo\'la olmaydi' }, 400);

      await pool.query(
        `UPDATE animals
            SET tag_number=$1, name=$2, type=$3, gender=$4, status=$5,
                births=$6, daily_milk=$7, birth_date=$8,
                last_calving_date=$9, insemination_date=$10, notes=$11,
                father_id=$12, mother_id=$13, father_unknown=$14, mother_unknown=$15,
                acquisition_type=$16, temp_no_milk=$17,
                updated_at=CURRENT_TIMESTAMP
          WHERE id=$18`,
        [
          d.tag_number, d.name || null, d.type, d.gender, d.status,
          d.births || 0, d.daily_milk || 0,
          d.birth_date || null, d.last_calving_date || null,
          d.insemination_date || null, d.notes || null,
          d.father_id || null, d.mother_id || null,
          d.father_unknown || false, d.mother_unknown || false,
          d.acquisition_type || 'born',
          d.temp_no_milk && d.temp_no_milk.length ? d.temp_no_milk : null,
          id,
        ]
      );
      const r = await pool.query('SELECT * FROM animals WHERE id=$1', [id]);
      if (!r.rows[0]) return json(res, { error: 'Mol topilmadi' }, 404);
      json(res, r.rows[0]);
    } catch (e) {
      console.error('PUT /animals/:id error:', e);
      json(res, { error: 'Xatolik: ' + e.message }, 400);
    }
  },

  'DELETE:/animals/:id': async (req, res) => {
    const u = await adminAuth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    try {
      const id = pathId(req.url, 2);
      const r  = await pool.query('DELETE FROM animals WHERE id=$1 RETURNING *', [id]);
      if (!r.rows.length) return json(res, { error: 'Mol topilmadi' }, 404);
      json(res, { success: true });
    } catch (e) {
      console.error('DELETE /animals/:id error:', e);
      json(res, { error: 'Xatolik' }, 500);
    }
  },

  // ── NEW: Family Tree ───────────────────────────────────────────────────────

  /**
   * GET /animals/:id/family
   * Returns: { animal, father, mother, children[] }
   * - father/mother may be null (unknown) or have acquisition_type info
   * - children are animals whose father_id OR mother_id === this animal's id
   */
  'GET:/animals/:id/family': async (req, res) => {
    const u = await auth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    try {
      const id = pathId(req.url, 2);
      const animalR = await pool.query('SELECT * FROM animals WHERE id=$1', [id]);
      if (!animalR.rows[0]) return json(res, { error: 'Mol topilmadi' }, 404);
      const animal = animalR.rows[0];

      // Load father and mother if ID is set
      const [fatherR, motherR, childrenR] = await Promise.all([
        animal.father_id
          ? pool.query('SELECT id, tag_number, name, type, gender, status FROM animals WHERE id=$1', [animal.father_id])
          : Promise.resolve({ rows: [] }),
        animal.mother_id
          ? pool.query('SELECT id, tag_number, name, type, gender, status FROM animals WHERE id=$1', [animal.mother_id])
          : Promise.resolve({ rows: [] }),
        // Children: any animal that has this animal as father OR mother
        pool.query(
          `SELECT id, tag_number, name, type, gender, status, birth_date
             FROM animals
            WHERE father_id=$1 OR mother_id=$1
            ORDER BY birth_date DESC NULLS LAST, created_at DESC`,
          [id]
        ),
      ]);

      json(res, {
        animal,
        father:        fatherR.rows[0] || null,
        father_unknown: animal.father_unknown,
        mother:        motherR.rows[0] || null,
        mother_unknown: animal.mother_unknown,
        acquisition_type: animal.acquisition_type,
        children:      childrenR.rows,
      });
    } catch (e) {
      console.error('GET /animals/:id/family error:', e);
      json(res, { error: 'Server xatosi' }, 500);
    }
  },

  /**
   * PUT /animals/:id/family
   * Body: {
   *   father_id: string|null,      // ID of father animal (null = unknown/not set)
   *   father_unknown: bool,        // true = suniy urug'lantirish or otasi noma'lum
   *   mother_id: string|null,
   *   mother_unknown: bool,        // true = onasi noma'lum (sotib olingan)
   *   acquisition_type: 'born'|'purchased'
   * }
   * Only updates family fields; other fields unchanged.
   */
  'PUT:/animals/:id/family': async (req, res) => {
    const u = await auth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    try {
      const id = pathId(req.url, 2);
      const current = await pool.query('SELECT id FROM animals WHERE id=$1', [id]);
      if (!current.rows[0]) return json(res, { error: 'Mol topilmadi' }, 404);

      const d = await parseBody(req);

      // Validate referenced IDs exist
      if (d.father_id) {
        if (d.father_id === id) return json(res, { error: 'Mol o\'z otasi bo\'la olmaydi' }, 400);
        const fa = await pool.query('SELECT id FROM animals WHERE id=$1', [d.father_id]);
        if (!fa.rows.length) return json(res, { error: 'Ota mol topilmadi' }, 400);
      }
      if (d.mother_id) {
        if (d.mother_id === id) return json(res, { error: 'Mol o\'z onasi bo\'la olmaydi' }, 400);
        const mo = await pool.query('SELECT id FROM animals WHERE id=$1', [d.mother_id]);
        if (!mo.rows.length) return json(res, { error: 'Ona mol topilmadi' }, 400);
      }

      await pool.query(
        `UPDATE animals
            SET father_id=$1, mother_id=$2,
                father_unknown=$3, mother_unknown=$4,
                acquisition_type=$5,
                updated_at=CURRENT_TIMESTAMP
          WHERE id=$6`,
        [
          d.father_id || null,
          d.mother_id || null,
          d.father_unknown || false,
          d.mother_unknown || false,
          d.acquisition_type || 'born',
          id,
        ]
      );
      const r = await pool.query(
        `SELECT id, tag_number, name, father_id, mother_id,
                father_unknown, mother_unknown, acquisition_type
           FROM animals WHERE id=$1`,
        [id]
      );
      json(res, r.rows[0]);
    } catch (e) {
      console.error('PUT /animals/:id/family error:', e);
      json(res, { error: 'Server xatosi: ' + e.message }, 500);
    }
  },

  /**
   * PUT /animals/:id/temp-no-milk
   * Body: { reasons: string[] }
   * reasons can include: 'kasal', 'homilador', 'boshqa'
   * Empty array = vaqtinchalik to'siq olib tashlash
   *
   * Note: Only applies to animals whose base status allows milk
   * (sut_beradi, kasal, bogoz). For Buqa/Bozak/Sotilgan etc — already blocked.
   */
  'PUT:/animals/:id/temp-no-milk': async (req, res) => {
    const u = await auth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    try {
      const id = pathId(req.url, 2);
      const animalR = await pool.query('SELECT id, status FROM animals WHERE id=$1', [id]);
      if (!animalR.rows[0]) return json(res, { error: 'Mol topilmadi' }, 404);

      if (NEVER_MILK_STATUSES.includes(animalR.rows[0].status)) {
        return json(res, {
          error: `Bu mol (${animalR.rows[0].status}) sut bermaydi. Vaqtinchalik to'siq shart emas.`,
        }, 400);
      }

      const d = await parseBody(req);
      const reasons = Array.isArray(d.reasons) ? d.reasons.filter(r => r) : [];
      const allowed = ['kasal', 'homilador', 'boshqa'];
      const invalid = reasons.filter(r => !allowed.includes(r));
      if (invalid.length) return json(res, { error: `Noto'g'ri sabab: ${invalid.join(', ')}` }, 400);

      await pool.query(
        `UPDATE animals SET temp_no_milk=$1, updated_at=CURRENT_TIMESTAMP WHERE id=$2`,
        [reasons.length ? reasons : null, id]
      );
      json(res, { success: true, temp_no_milk: reasons });
    } catch (e) {
      console.error('PUT /animals/:id/temp-no-milk error:', e);
      json(res, { error: 'Server xatosi' }, 500);
    }
  },

  'GET:/animals/:id/milk': async (req, res) => {
    const u = await auth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    try {
      const id   = pathId(req.url, 2);
      const days = parseInt(new URL(req.url, 'http://localhost').searchParams.get('days') || '30');
      const r    = await pool.query(
        `SELECT date::text,
                SUM(liters) AS total,
                MAX(CASE WHEN session=1 THEN liters END) AS s1,
                MAX(CASE WHEN session=2 THEN liters END) AS s2
           FROM milk_records
          WHERE animal_id=$1 AND date >= CURRENT_DATE - ($2 || ' days')::interval
          GROUP BY date ORDER BY date`,
        [id, days]
      );
      json(res, r.rows.map(row => ({
        date:  row.date,
        total: parseFloat(row.total),
        s1:    row.s1 ? parseFloat(row.s1) : null,
        s2:    row.s2 ? parseFloat(row.s2) : null,
      })));
    } catch (e) {
      console.error('GET /animals/:id/milk error:', e);
      json(res, { error: 'Server xatosi' }, 500);
    }
  },

  // ── Milk Records ───────────────────────────────────────────────────────────
  'GET:/milk': async (req, res) => {
    const u = await auth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    try {
      const sp    = new URL(req.url, 'http://localhost').searchParams;
      const date  = sp.get('date');
      const limit = parseInt(sp.get('limit') || '60');
      let q = `SELECT mr.*, a.tag_number, a.name AS animal_name
                 FROM milk_records mr
                 LEFT JOIN animals a ON mr.animal_id = a.id`;
      const params = [];
      if (date) {
        q += ' WHERE mr.date=$1 ORDER BY a.tag_number, mr.session';
        params.push(date);
      } else {
        q += ' ORDER BY mr.date DESC, mr.created_at DESC LIMIT $1';
        params.push(limit);
      }
      const r = await pool.query(q, params);
      json(res, r.rows);
    } catch (e) {
      console.error('GET /milk error:', e);
      json(res, { error: 'Server xatosi' }, 500);
    }
  },

  /**
   * GET /milk/daily?date=YYYY-MM-DD
   * Returns only animals that CAN currently produce milk:
   *   - status NOT IN NEVER_MILK_STATUSES (sotildi, nobud, soyildi, buqa, bozak, sotib_olingan_bozak)
   *   - AND (temp_no_milk IS NULL OR temp_no_milk = '{}')
   * Also returns animals that have temp_no_milk set (separately flagged) so UI can show them.
   */
  'GET:/milk/daily': async (req, res) => {
    const u = await auth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    try {
      const date = new URL(req.url, 'http://localhost').searchParams.get('date')
                 || new Date().toISOString().split('T')[0];
      const neverList = NEVER_MILK_STATUSES.map((s, i) => `$${i + 2}`).join(',');
      const r = await pool.query(
        `SELECT a.id, a.tag_number, a.name, a.status, a.daily_milk AS expected,
                a.temp_no_milk,
                MAX(CASE WHEN mr.session=1 THEN mr.liters END) AS s1,
                MAX(CASE WHEN mr.session=2 THEN mr.liters END) AS s2,
                MAX(CASE WHEN mr.session=1 THEN mr.id END)     AS s1_id,
                MAX(CASE WHEN mr.session=2 THEN mr.id END)     AS s2_id,
                COALESCE(SUM(mr.liters), 0) AS total
           FROM animals a
           LEFT JOIN milk_records mr ON a.id = mr.animal_id AND mr.date=$1
          WHERE a.status NOT IN (${neverList})
          GROUP BY a.id, a.tag_number, a.name, a.status, a.daily_milk, a.temp_no_milk
          ORDER BY (a.status='sut_beradi') DESC, a.tag_number`,
        [date, ...NEVER_MILK_STATUSES]
      );
      json(res, r.rows.map(row => ({
        id:          row.id,
        tag_number:  row.tag_number,
        name:        row.name,
        status:      row.status,
        expected:    parseFloat(row.expected || 0),
        temp_no_milk: row.temp_no_milk || [],
        // can_add_milk: true only if no temp_no_milk reasons
        can_add_milk: !row.temp_no_milk || row.temp_no_milk.length === 0,
        s1:    row.s1 ? parseFloat(row.s1) : null, s1_id: row.s1_id,
        s2:    row.s2 ? parseFloat(row.s2) : null, s2_id: row.s2_id,
        total: parseFloat(row.total),
      })));
    } catch (e) {
      console.error('GET /milk/daily error:', e);
      json(res, { error: 'Server xatosi' }, 500);
    }
  },

  'GET:/milk/stock': async (req, res) => {
    const u = await auth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    try {
      const [prodR, soldR] = await Promise.all([
        pool.query(`SELECT COALESCE(SUM(liters), 0) AS total FROM milk_records`),
        pool.query(`SELECT COALESCE(SUM(liters), 0) AS total FROM milk_sales`),
      ]);
      const produced  = parseFloat(prodR.rows[0].total);
      const sold      = parseFloat(soldR.rows[0].total);
      json(res, { produced, sold, available: Math.max(0, produced - sold) });
    } catch (e) {
      console.error('GET /milk/stock error:', e);
      json(res, { error: 'Server xatosi' }, 500);
    }
  },

  'POST:/milk': async (req, res) => {
    try {
      const u = await auth(req);
      if (!u) return json(res, { error: 'Unauthorized' }, 401);
      const d = await parseBody(req);

      if (!d.animal_id) return json(res, { error: 'Molni tanlang' }, 400);
      if (!d.liters)    return json(res, { error: 'Litr miqdorini kiriting' }, 400);
      if (!d.session)   return json(res, { error: 'Soqim sessiyasini tanlang' }, 400);

      const animalRow = await pool.query('SELECT status, temp_no_milk FROM animals WHERE id=$1', [d.animal_id]);
      if (!animalRow.rows[0]) return json(res, { error: 'Mol topilmadi' }, 404);
      const { status, temp_no_milk } = animalRow.rows[0];

      // Hard block for never-milk statuses
      if (NEVER_MILK_STATUSES.includes(status)) {
        return json(res, {
          error: `Bu mol faol emas (${status}). Sut qayd qilish mumkin emas.`,
        }, 400);
      }

      // Soft block for temp_no_milk
      if (temp_no_milk && temp_no_milk.length > 0) {
        const labels = {
          kasal:      'Kasal',
          homilador:  'Homilador',
          boshqa:     'Boshqa sabab',
        };
        const reasons = temp_no_milk.map(r => labels[r] || r).join(', ');
        return json(res, {
          error: `Bu mol vaqtinchalik sut bermayapti: ${reasons}.`,
        }, 400);
      }

      // Duplicate session guard
      const dup = await pool.query(
        'SELECT id FROM milk_records WHERE animal_id=$1 AND date=$2 AND session=$3',
        [d.animal_id, d.date, d.session]
      );
      if (dup.rows.length) {
        return json(res, { error: `Bu mol uchun ${d.session}-soqim allaqachon qayd qilingan` }, 400);
      }

      const id = uuid();
      await pool.query(
        `INSERT INTO milk_records (id, animal_id, date, session, liters, notes)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, d.animal_id, d.date, d.session, d.liters, d.notes || null]
      );
      const r = await pool.query(
        `SELECT mr.*, a.tag_number, a.name AS animal_name
           FROM milk_records mr
           LEFT JOIN animals a ON mr.animal_id = a.id
          WHERE mr.id=$1`,
        [id]
      );
      json(res, r.rows[0]);
    } catch (e) {
      console.error('POST /milk error:', e);
      json(res, { error: 'Server xatosi: ' + e.message }, 500);
    }
  },

  'DELETE:/milk/:id': async (req, res) => {
    const u = await auth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    try {
      const id = pathId(req.url, 2);
      const r  = await pool.query('DELETE FROM milk_records WHERE id=$1 RETURNING *', [id]);
      if (!r.rows.length) return json(res, { error: 'Qayd topilmadi' }, 404);
      json(res, { success: true });
    } catch (e) {
      console.error('DELETE /milk/:id error:', e);
      json(res, { error: 'Xatolik' }, 500);
    }
  },

  // ── Milk Sales ─────────────────────────────────────────────────────────────
  'GET:/milk-sales': async (req, res) => {
    const u = await auth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    try {
      const sp    = new URL(req.url, 'http://localhost').searchParams;
      const date  = sp.get('date');
      const limit = parseInt(sp.get('limit') || '60');
      let q = 'SELECT * FROM milk_sales';
      const params = [];
      if (date) {
        q += ' WHERE date=$1 ORDER BY created_at DESC';
        params.push(date);
      } else {
        q += ' ORDER BY date DESC, created_at DESC LIMIT $1';
        params.push(limit);
      }
      json(res, (await pool.query(q, params)).rows);
    } catch (e) {
      console.error('GET /milk-sales error:', e);
      json(res, { error: 'Server xatosi' }, 500);
    }
  },

  'POST:/milk-sales': async (req, res) => {
    const u = await auth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    try {
      const d = await parseBody(req);
      if (!d.liters || !d.price || !d.buyer) return json(res, { error: 'Miqdor, narx va xaridor kerak' }, 400);
      const liters = parseFloat(d.liters);
      if (isNaN(liters) || liters <= 0) return json(res, { error: "Litr miqdori noto'g'ri" }, 400);

      const stockR = await pool.query(`
        SELECT
          COALESCE((SELECT SUM(liters) FROM milk_records),0) -
          COALESCE((SELECT SUM(liters) FROM milk_sales),0) AS available
      `);
      const available = parseFloat(stockR.rows[0].available);
      if (liters > available) {
        return json(res, {
          error: `Omborda yetarli sut yo'q. Mavjud: ${available.toFixed(1)} L, so'ralgan: ${liters.toFixed(1)} L`,
        }, 400);
      }

      const id    = uuid();
      const total = liters * parseFloat(d.price);
      await pool.query(
        `INSERT INTO milk_sales (id, date, liters, price, total, buyer, phone, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, d.date, liters, d.price, total, d.buyer, d.phone || null, d.notes || null]
      );
      json(res, (await pool.query('SELECT * FROM milk_sales WHERE id=$1', [id])).rows[0]);
    } catch (e) {
      console.error('POST /milk-sales error:', e);
      json(res, { error: 'Server xatosi: ' + e.message }, 500);
    }
  },

  'DELETE:/milk-sales/:id': async (req, res) => {
    const u = await auth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    try {
      const id = pathId(req.url, 2);
      const r  = await pool.query('DELETE FROM milk_sales WHERE id=$1 RETURNING *', [id]);
      if (!r.rows.length) return json(res, { error: 'Sotuv topilmadi' }, 404);
      json(res, { success: true });
    } catch (e) {
      console.error('DELETE /milk-sales/:id error:', e);
      json(res, { error: 'Xatolik' }, 500);
    }
  },

  // ── Expenses ───────────────────────────────────────────────────────────────
  'GET:/expenses': async (req, res) => {
    const u = await auth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    try {
      const limit = parseInt(new URL(req.url, 'http://localhost').searchParams.get('limit') || '60');
      json(res, (await pool.query(
        'SELECT * FROM expenses ORDER BY date DESC, created_at DESC LIMIT $1', [limit]
      )).rows);
    } catch (e) {
      console.error('GET /expenses error:', e);
      json(res, { error: 'Server xatosi' }, 500);
    }
  },

  'POST:/expenses': async (req, res) => {
    const u = await auth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    try {
      const d = await parseBody(req);
      if (!d.amount) return json(res, { error: 'Miqdor kerak' }, 400);
      const id = uuid();
      await pool.query(
        `INSERT INTO expenses (id, category, amount, description, date) VALUES ($1, $2, $3, $4, $5)`,
        [id, d.category || 'boshqa', d.amount, d.description || null, d.date]
      );
      json(res, (await pool.query('SELECT * FROM expenses WHERE id=$1', [id])).rows[0]);
    } catch (e) {
      console.error('POST /expenses error:', e);
      json(res, { error: 'Xatolik: ' + e.message }, 400);
    }
  },

  'DELETE:/expenses/:id': async (req, res) => {
    const u = await auth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    try {
      const id = pathId(req.url, 2);
      const r  = await pool.query('DELETE FROM expenses WHERE id=$1 RETURNING *', [id]);
      if (!r.rows.length) return json(res, { error: 'Harajat topilmadi' }, 404);
      json(res, { success: true });
    } catch (e) {
      console.error('DELETE /expenses/:id error:', e);
      json(res, { error: 'Xatolik' }, 500);
    }
  },

  // ── Users ──────────────────────────────────────────────────────────────────
  'GET:/users': async (req, res) => {
    const u = await adminAuth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    try {
      json(res, (await pool.query(
        'SELECT id, username, role, name, created_at FROM users ORDER BY created_at DESC'
      )).rows);
    } catch (e) {
      console.error('GET /users error:', e);
      json(res, { error: 'Server xatosi' }, 500);
    }
  },

  'POST:/users': async (req, res) => {
    const u = await adminAuth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    try {
      const d = await parseBody(req);
      if (!d.username || !d.password) return json(res, { error: 'Username va parol kerak' }, 400);
      const ex = await pool.query('SELECT id FROM users WHERE username=$1', [d.username]);
      if (ex.rows.length) return json(res, { error: `"${d.username}" allaqachon mavjud` }, 400);
      const id = uuid();
      await pool.query(
        `INSERT INTO users (id, username, password, role, name) VALUES ($1, $2, $3, $4, $5)`,
        [id, d.username, hashPassword(d.password), d.role || 'worker', d.name || d.username]
      );
      json(res, (await pool.query(
        'SELECT id, username, role, name, created_at FROM users WHERE id=$1', [id]
      )).rows[0]);
    } catch (e) {
      console.error('POST /users error:', e);
      json(res, { error: 'Xatolik: ' + e.message }, 400);
    }
  },

  'DELETE:/users/:id': async (req, res) => {
    const u = await adminAuth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    try {
      const id = pathId(req.url, 2);
      if (id === u.id) return json(res, { error: "O'z o'zingizni o'chira olmaysiz" }, 400);
      const r = await pool.query('DELETE FROM users WHERE id=$1 RETURNING *', [id]);
      if (!r.rows.length) return json(res, { error: 'Foydalanuvchi topilmadi' }, 404);
      json(res, { success: true });
    } catch (e) {
      console.error('DELETE /users/:id error:', e);
      json(res, { error: 'Xatolik' }, 500);
    }
  },

  // ── Animal Sales (Sell / Slaughter / Dead) ─────────────────────────────────
  'POST:/sales': async (req, res) => {
    const u = await auth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    try {
      const d = await parseBody(req);
      if (!d.animal_id) return json(res, { error: 'Mol ID kerak' }, 400);
      if (!d.date)      return json(res, { error: 'Sana kerak' }, 400);

      const animalRow = await pool.query('SELECT id, status FROM animals WHERE id=$1', [d.animal_id]);
      if (!animalRow.rows[0]) return json(res, { error: 'Mol topilmadi' }, 404);
      if (['sotildi', 'nobud', 'soyildi'].includes(animalRow.rows[0].status)) {
        return json(res, {
          error: `Bu mol allaqachon faol emas (${animalRow.rows[0].status}).`,
        }, 400);
      }

      let newStatus;
      switch (d.reason) {
        case 'nobud':  newStatus = 'nobud';   break;
        case 'soyish': newStatus = 'soyildi'; break;
        default:       newStatus = 'sotildi'; break;
      }

      const id = uuid();
      await pool.query(
        `INSERT INTO animal_sales
           (id, animal_id, price, buyer_name, reason, weight_kg, date, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, d.animal_id, d.price || 0, d.buyer || null, d.reason || 'sotish', d.weight_kg || null, d.date, d.notes || null]
      );
      await pool.query(
        'UPDATE animals SET status=$1, updated_at=CURRENT_TIMESTAMP WHERE id=$2',
        [newStatus, d.animal_id]
      );
      json(res, { success: true, newStatus });
    } catch (e) {
      console.error('POST /sales error:', e);
      json(res, { error: 'Server xatosi: ' + e.message }, 500);
    }
  },

  // ── Warehouse Items ────────────────────────────────────────────────────────
  'GET:/warehouse/items': async (req, res) => {
    const u = await auth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    try {
      const r = await pool.query(
        'SELECT * FROM warehouse_items ORDER BY category, name'
      );
      json(res, r.rows);
    } catch (e) {
      console.error('GET /warehouse/items error:', e);
      json(res, { error: 'Server xatosi' }, 500);
    }
  },

  'POST:/warehouse/items': async (req, res) => {
    const u = await auth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    try {
      const d = await parseBody(req);
      if (!d.name) return json(res, { error: 'Mahsulot nomi kerak' }, 400);
      const id = uuid();
      await pool.query(
        `INSERT INTO warehouse_items (id, name, category, unit, current_qty, min_qty, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, d.name, d.category||'boshqa', d.unit||'kg',
         d.current_qty||0, d.min_qty||0, d.notes||null]
      );
      json(res, (await pool.query('SELECT * FROM warehouse_items WHERE id=$1', [id])).rows[0]);
    } catch (e) {
      console.error('POST /warehouse/items error:', e);
      json(res, { error: 'Xatolik: ' + e.message }, 400);
    }
  },

  'PUT:/warehouse/items/:id': async (req, res) => {
    const u = await auth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    try {
      const id = pathId(req.url, 3);
      const d  = await parseBody(req);
      if (!d.name) return json(res, { error: 'Mahsulot nomi kerak' }, 400);
      const r = await pool.query(
        `UPDATE warehouse_items
            SET name=$1, category=$2, unit=$3, current_qty=$4, min_qty=$5, notes=$6,
                updated_at=CURRENT_TIMESTAMP
          WHERE id=$7 RETURNING *`,
        [d.name, d.category||'boshqa', d.unit||'kg',
         d.current_qty||0, d.min_qty||0, d.notes||null, id]
      );
      if (!r.rows.length) return json(res, { error: 'Mahsulot topilmadi' }, 404);
      json(res, r.rows[0]);
    } catch (e) {
      console.error('PUT /warehouse/items/:id error:', e);
      json(res, { error: 'Xatolik: ' + e.message }, 400);
    }
  },

  'DELETE:/warehouse/items/:id': async (req, res) => {
    const u = await auth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    try {
      const id = pathId(req.url, 3);
      const r  = await pool.query('DELETE FROM warehouse_items WHERE id=$1 RETURNING *', [id]);
      if (!r.rows.length) return json(res, { error: 'Mahsulot topilmadi' }, 404);
      json(res, { success: true });
    } catch (e) {
      console.error('DELETE /warehouse/items/:id error:', e);
      json(res, { error: 'Xatolik' }, 500);
    }
  },

  // ── Warehouse Transactions ─────────────────────────────────────────────────
  'GET:/warehouse/transactions': async (req, res) => {
    const u = await auth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    try {
      const limit = parseInt(new URL(req.url, 'http://localhost').searchParams.get('limit') || '50');
      const r = await pool.query(
        `SELECT wt.*, wi.name AS item_name, wi.unit
           FROM warehouse_transactions wt
           LEFT JOIN warehouse_items wi ON wt.item_id = wi.id
          ORDER BY wt.date DESC, wt.created_at DESC
          LIMIT $1`,
        [limit]
      );
      json(res, r.rows);
    } catch (e) {
      console.error('GET /warehouse/transactions error:', e);
      json(res, { error: 'Server xatosi' }, 500);
    }
  },

  'POST:/warehouse/transactions': async (req, res) => {
    const u = await auth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    try {
      const d = await parseBody(req);
      if (!d.item_id) return json(res, { error: 'Mahsulot kerak' }, 400);
      if (!d.qty || parseFloat(d.qty) <= 0) return json(res, { error: "Miqdor 0 dan katta bo'lishi kerak" }, 400);
      if (!['in','out'].includes(d.type)) return json(res, { error: "Tur 'in' yoki 'out' bo'lishi kerak" }, 400);

      const itemR = await pool.query('SELECT * FROM warehouse_items WHERE id=$1', [d.item_id]);
      if (!itemR.rows[0]) return json(res, { error: 'Mahsulot topilmadi' }, 404);

      const qty = parseFloat(d.qty);
      const currentQty = parseFloat(itemR.rows[0].current_qty);

      if (d.type === 'out' && qty > currentQty) {
        return json(res, {
          error: `Yetarli mahsulot yo'q. Mavjud: ${currentQty} ${itemR.rows[0].unit}, so'ralgan: ${qty}`
        }, 400);
      }

      const newQty = d.type === 'in' ? currentQty + qty : currentQty - qty;
      const id = uuid();

      await pool.query(
        `INSERT INTO warehouse_transactions (id, item_id, type, qty, date, price, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, d.item_id, d.type, qty, d.date||new Date().toISOString().split('T')[0], d.price||0, d.notes||null]
      );
      await pool.query(
        'UPDATE warehouse_items SET current_qty=$1, updated_at=CURRENT_TIMESTAMP WHERE id=$2',
        [newQty, d.item_id]
      );

      json(res, {
        success: true,
        transaction: (await pool.query('SELECT * FROM warehouse_transactions WHERE id=$1', [id])).rows[0],
        new_qty: newQty,
      });
    } catch (e) {
      console.error('POST /warehouse/transactions error:', e);
      json(res, { error: 'Server xatosi: ' + e.message }, 500);
    }
  },

  // ── Equipment / Texnika ────────────────────────────────────────────────────
  'GET:/equipment': async (req, res) => {
    const u = await auth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    try {
      json(res, (await pool.query(
        'SELECT * FROM equipment ORDER BY status, name'
      )).rows);
    } catch (e) {
      console.error('GET /equipment error:', e);
      json(res, { error: 'Server xatosi' }, 500);
    }
  },

  'POST:/equipment': async (req, res) => {
    const u = await auth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    try {
      const d = await parseBody(req);
      if (!d.name) return json(res, { error: 'Texnika nomi kerak' }, 400);
      const id = uuid();
      await pool.query(
        `INSERT INTO equipment (id, name, type, status, last_service, next_service, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, d.name, d.type||'boshqa', d.status||'working',
         d.last_service||null, d.next_service||null, d.notes||null]
      );
      json(res, (await pool.query('SELECT * FROM equipment WHERE id=$1', [id])).rows[0]);
    } catch (e) {
      console.error('POST /equipment error:', e);
      json(res, { error: 'Xatolik: ' + e.message }, 400);
    }
  },

  'PUT:/equipment/:id': async (req, res) => {
    const u = await auth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    try {
      const id = pathId(req.url, 2);
      const d  = await parseBody(req);
      if (!d.name) return json(res, { error: 'Texnika nomi kerak' }, 400);
      const r = await pool.query(
        `UPDATE equipment
            SET name=$1, type=$2, status=$3, last_service=$4, next_service=$5, notes=$6,
                updated_at=CURRENT_TIMESTAMP
          WHERE id=$7 RETURNING *`,
        [d.name, d.type||'boshqa', d.status||'working',
         d.last_service||null, d.next_service||null, d.notes||null, id]
      );
      if (!r.rows.length) return json(res, { error: 'Texnika topilmadi' }, 404);
      json(res, r.rows[0]);
    } catch (e) {
      console.error('PUT /equipment/:id error:', e);
      json(res, { error: 'Xatolik: ' + e.message }, 400);
    }
  },

  'DELETE:/equipment/:id': async (req, res) => {
    const u = await auth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    try {
      const id = pathId(req.url, 2);
      const r  = await pool.query('DELETE FROM equipment WHERE id=$1 RETURNING *', [id]);
      if (!r.rows.length) return json(res, { error: 'Texnika topilmadi' }, 404);
      json(res, { success: true });
    } catch (e) {
      console.error('DELETE /equipment/:id error:', e);
      json(res, { error: 'Xatolik' }, 500);
    }
  },

};

// ---------------------------------------------------------------------------
// Dynamic Route Matcher
// ---------------------------------------------------------------------------
function matchPath(pattern, requestPath) {
  const pp = pattern.split('/'), rp = requestPath.split('/');
  if (pp.length !== rp.length) return false;
  return pp.every((part, i) => part.startsWith(':') || part === rp[i]);
}

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const method   = req.method;
  const url      = req.url;
  const pathname = new URL(url, 'http://localhost').pathname;
  req.cookies    = parseCookies(req);

  if (method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Headers': 'Content-Type, x-session-token',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    });
    return res.end();
  }

  if (pathname.startsWith('/api/')) {
    const apiPath   = pathname.replace('/api', '');
    const directKey = `${method}:${apiPath}`;
    let handler = routes[directKey];

    if (!handler) {
      for (const [pat, h] of Object.entries(routes)) {
        if (pat.startsWith(method + ':')) {
          const patPath = pat.substring(method.length + 1);
          if (matchPath(patPath, apiPath)) { handler = h; break; }
        }
      }
    }

    if (handler) {
      try { await handler(req, res); }
      catch (e) { console.error('Unhandled route error:', e); json(res, { error: 'Server xatosi' }, 500); }
    } else {
      json(res, { error: 'Route topilmadi' }, 404);
    }
    return;
  }

  if (pathname === '/') serveStatic(res, path.join(PUBLIC_DIR, 'index.html'));
  else                  serveStatic(res, path.join(PUBLIC_DIR, pathname));
});

initDB().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`FermaApp running on port ${PORT}`);
  });
}).catch(e => { console.error('Failed to start:', e); process.exit(1); });
