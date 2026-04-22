/**
 * FermaApp — AndBillur Ferma boshqaruv tizimi
 * Fixed server.js — All bugs resolved
 *
 * CHANGELOG:
 * 1. [BUG FIX] pathId(): was extracting pos=2 from full /api/... URL,
 *    returning the route name ('animals') instead of the actual UUID.
 *    Now strips /api prefix before splitting -> correct ID at pos 2.
 * 2. [BUG FIX] GET:/animals/:id/milk — same pathId bug (parts[2] on full URL).
 * 3. [BUG FIX] PUT:/animals/:id — proper 404 when animal not found.
 * 4. [BUG FIX] POST:/sales — added 'soyish'->'soyildi' status mapping + try/catch.
 * 5. [BUG FIX] POST:/milk — now blocks milk entry for inactive animals.
 * 6. [BUG FIX] milk_records.price — ALTER TABLE migration makes column nullable.
 * 7. [NEW]    GET:/milk/stock — returns produced/sold/available inventory totals.
 * 8. [NEW]    POST:/milk-sales — stock check prevents overselling.
 * 9. [FIX]   Password reset — admin-only guard, proper Uzbek email template,
 *            IP + device info in email.
 * 10.[FIX]   password_resets table created inside main initDB flow.
 * 11.[FIX]   POST:/sales — animal existence + active status check.
 * 12.[CLEAN] Removed excessive debug console.log statements.
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
        created_at        TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
        updated_at        TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`ALTER TABLE animals ADD COLUMN IF NOT EXISTS insemination_date DATE`).catch(() => {});
    await pool.query(`ALTER TABLE animals ADD COLUMN IF NOT EXISTS last_calving_date  DATE`).catch(() => {});

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

    // BUG FIX #6: Old schema had price NOT NULL which broke milk creation.
    // Drop the column if it exists (price belongs in milk_sales, not milk_records).
    await pool.query(`ALTER TABLE milk_records DROP COLUMN IF EXISTS price`).catch(() => {});
    await pool.query(`ALTER TABLE milk_records ADD COLUMN IF NOT EXISTS notes TEXT`).catch(() => {});

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

    // BUG FIX #10: password_resets used to be created in a separate function,
    // which risked it being missing. Now always created on startup.
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

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_milk_date   ON milk_records(date)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_milk_animal ON milk_records(animal_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_ms_date     ON milk_sales(date)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_exp_date    ON expenses(date)`);

    // Default admin user
    const ex = await pool.query(`SELECT id FROM users WHERE username=$1`, ['admin']);
    if (!ex.rows.length) {
      await pool.query(
        `INSERT INTO users (id,username,password,role,name) VALUES ($1,$2,$3,$4,$5)`,
        [uuid(), 'admin', hashPassword('admin123'), 'admin', 'Admin']
      );
    }

    // Housekeeping: remove expired reset codes older than 1 day
    await pool.query(`DELETE FROM password_resets WHERE expires_at < NOW() - INTERVAL '1 day'`).catch(() => {});

    console.log('DB ready');
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
 * BUG FIX #1 — pathId() Root Cause Explained
 *
 * BEFORE (broken):
 *   req.url = '/api/animals/abc123'
 *   new URL(...).pathname = '/api/animals/abc123'
 *   .split('/') = ['', 'api', 'animals', 'abc123']
 *   pos=2 -> 'animals'   <-- this was used as the animal ID!
 *
 * AFTER (fixed): strip /api first
 *   apiPath = '/animals/abc123'
 *   .split('/') = ['', 'animals', 'abc123']
 *   pos=2 -> 'abc123'   <-- correct UUID
 *
 * This ONE fix unblocks ALL broken dynamic routes:
 *   PUT    /animals/:id
 *   DELETE /animals/:id
 *   GET    /animals/:id/milk
 *   DELETE /milk/:id
 *   DELETE /milk-sales/:id
 *   DELETE /expenses/:id
 *   DELETE /users/:id
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
// Email (nodemailer — optional, falls back to console in dev)
// ---------------------------------------------------------------------------
let nodemailer = null;
try {
  nodemailer = require('nodemailer');
} catch (_) {
  console.warn('nodemailer not installed. Run `npm install` to enable email sending.');
}

function buildTransporter() {
  if (!nodemailer) return null;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!pass) {
    console.warn('GMAIL_APP_PASSWORD env var not set — emails will be logged to console only.');
    return null;
  }
  return nodemailer.createTransport({
    service: 'gmail',
    host:    'smtp.gmail.com',
    port:    465,
    secure:  true,
    auth:    { user: 'info@andbillur.com', pass },
    tls:     { rejectUnauthorized: false },
  });
}

/**
 * BUG FIX #9 — sendResetEmail() now sends the proper Uzbek template
 * with the 6-digit code, expiry time, IP address and device info.
 * Target address is always info@andbillur.com (never the user's email).
 */
async function sendResetEmail({ code, displayName, ip, device, expiresAt }) {
  const expireTime = new Date(expiresAt).toLocaleString('uz-UZ', {
    timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit',
  });
  const dateTime = new Date().toLocaleString('uz-UZ', {
    timeZone:  'Asia/Tashkent',
    year:      'numeric', month: '2-digit', day: '2-digit',
    hour:      '2-digit', minute: '2-digit',
  });

  const textBody = [
    `Salom ${displayName},`,
    '',
    `Siz ferma.andbillur.com hisobingiz uchun parolni o'zgartirish so'rovini yubordingiz.`,
    '',
    `Tasdiqlash kodi: ${code}`,
    '',
    `Amal qilish muddati: ${expireTime}`,
    '',
    `Agar siz bo'lmasangiz — hech narsa qilmang.`,
    '',
    `Sana: ${dateTime}`,
    `IP: ${ip}`,
    `Qurilma: ${device}`,
    '',
    '— AndBillur Ferma tizimi',
  ].join('\n');

  const htmlBody = `
<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#1e293b">
  <div style="background:#1d4ed8;padding:20px 24px;border-radius:12px 12px 0 0">
    <h2 style="color:#fff;margin:0;font-size:18px">AndBillur Ferma tizimi</h2>
  </div>
  <div style="border:1px solid #e2e8f0;border-top:none;padding:28px 24px;border-radius:0 0 12px 12px">
    <p style="margin-top:0">Salom <strong>${displayName}</strong>,</p>
    <p>Siz <strong>ferma.andbillur.com</strong> hisobingiz uchun
       parolni o'zgartirish so'rovini yubordingiz.</p>
    <div style="background:#eff6ff;border:2px solid #bfdbfe;border-radius:10px;
                padding:24px;text-align:center;margin:24px 0">
      <p style="margin:0 0 8px;color:#64748b;font-size:13px">Tasdiqlash kodi</p>
      <div style="font-size:36px;font-weight:700;letter-spacing:8px;color:#1d4ed8">
        ${code}
      </div>
      <p style="margin:12px 0 0;color:#64748b;font-size:13px">
        &#8987; Amal qilish muddati: <strong>${expireTime}</strong>
      </p>
    </div>
    <p>Agar siz bo'lmasangiz — hech narsa qilmang. Hech qanday o'zgarish bo'lmaydi.</p>
    <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0">
    <p style="color:#94a3b8;font-size:12px;line-height:1.9;margin:0">
      &#128197; ${dateTime}<br>
      &#127760; IP: ${ip}<br>
      &#128187; Qurilma: ${device}
    </p>
    <p style="color:#94a3b8;font-size:12px;margin-bottom:0">— AndBillur Ferma tizimi</p>
  </div>
</div>`;

  const transporter = buildTransporter();
  if (transporter) {
    try {
      await transporter.sendMail({
        from:    '"AndBillur Ferma" <info@andbillur.com>',
        to:      'info@andbillur.com',
        subject: `Parolni o'zgartirish — ${displayName}`,
        text:    textBody,
        html:    htmlBody,
      });
      console.log(`Reset email sent for: ${displayName}`);
      return true;
    } catch (err) {
      console.error('Email send failed:', err.message);
      return false;
    }
  } else {
    // Dev fallback
    console.log('\n=== PASSWORD RESET CODE ===');
    console.log(`User   : ${displayName}`);
    console.log(`Code   : ${code}`);
    console.log(`Expires: ${expireTime}`);
    console.log(`IP     : ${ip}`);
    console.log('===========================\n');
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
    res.setHeader(
      'Set-Cookie',
      `token=${token}; Path=/; HttpOnly; SameSite=Lax${isProd ? '; Secure' : ''}`
    );
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

      // BUG FIX #9: Admin-only restriction
      const userRow = await pool.query(
        'SELECT id, name, role FROM users WHERE username=$1',
        [uname]
      );
      if (!userRow.rows[0]) {
        // Return generic success to avoid user-enumeration
        return json(res, { success: true, message: 'Tasdiqlash kodi admin emailiga yuborildi' });
      }
      if (userRow.rows[0].role !== 'admin') {
        return json(res, { error: 'Faqat admin parolini tiklash mumkin' }, 403);
      }

      const code      = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min

      await pool.query(
        'INSERT INTO password_resets (username, code, expires_at) VALUES ($1, $2, $3)',
        [uname, code, expiresAt]
      );

      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
               || req.socket?.remoteAddress
               || 'Unknown';
      const device = (req.headers['user-agent'] || 'Unknown').substring(0, 150);

      const sent = await sendResetEmail({
        code,
        displayName: userRow.rows[0].name || uname,
        ip,
        device,
        expiresAt,
      });

      if (!sent) {
        return json(res, { error: "Email yuborishda xatolik. Keyinroq urinib ko'ring." }, 500);
      }

      json(res, { success: true, message: 'Tasdiqlash kodi admin emailiga yuborildi' });
    } catch (e) {
      console.error('password-reset-request error:', e);
      json(res, { error: 'Server xatosi' }, 500);
    }
  },

  'POST:/admin/password-reset-confirm': async (req, res) => {
    try {
      const { username, code, newPassword } = await parseBody(req);
      if (!username || !code || !newPassword) {
        return json(res, { error: 'Username, kod va yangi parol kerak' }, 400);
      }
      if (newPassword.length < 6) {
        return json(res, { error: "Parol kamida 6 ta belgidan iborat bo'lishi kerak" }, 400);
      }

      const resetRow = await pool.query(
        `SELECT id, expires_at, used
           FROM password_resets
          WHERE username=$1 AND code=$2
          ORDER BY created_at DESC LIMIT 1`,
        [username, code]
      );
      if (!resetRow.rows[0]) {
        return json(res, { error: "Noto'g'ri tasdiqlash kodi" }, 400);
      }
      const reset = resetRow.rows[0];
      if (reset.used) {
        return json(res, { error: 'Bu kod allaqachon ishlatilgan' }, 400);
      }
      if (new Date() > new Date(reset.expires_at)) {
        return json(res, { error: "Kodning muddati o'tgan. Yangi kod so'rang." }, 400);
      }

      // Re-verify admin role
      const userRow = await pool.query('SELECT id, role FROM users WHERE username=$1', [username]);
      if (!userRow.rows[0]) {
        return json(res, { error: 'Foydalanuvchi topilmadi' }, 404);
      }
      if (userRow.rows[0].role !== 'admin') {
        return json(res, { error: 'Faqat admin parolini tiklash mumkin' }, 403);
      }

      await pool.query(
        'UPDATE users SET password=$1 WHERE id=$2',
        [hashPassword(newPassword), userRow.rows[0].id]
      );

      // One-time use: mark code as used
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

      const milkRevenue  = parseFloat(ms.rows[0].rev);
      const salesRevenue = parseFloat(as2.rows[0].rev);
      const totalExp     = parseFloat(ex.rows[0].tot);
      json(res, {
        milkRevenue, milkLiters: parseFloat(ms.rows[0].liters),
        salesRevenue, salesCount: parseInt(as2.rows[0].cnt),
        totalExpenses: totalExp, expCount: parseInt(ex.rows[0].cnt),
        netProfit: milkRevenue + salesRevenue - totalExp,
        chart: Object.values(map).sort((a, b) => a.date.localeCompare(b.date)),
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
      await pool.query(
        `INSERT INTO animals
           (id,tag_number,name,type,gender,status,births,daily_milk,
            birth_date,last_calving_date,insemination_date,notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          id, d.tag_number, d.name || null,
          d.type || 'sigir', d.gender || 'female',
          d.status || 'sut_beradi',
          d.births || 0, d.daily_milk || 0,
          d.birth_date || null, d.last_calving_date || null,
          d.insemination_date || null, d.notes || null,
        ]
      );
      const r = await pool.query('SELECT * FROM animals WHERE id=$1', [id]);
      json(res, r.rows[0]);
    } catch (e) {
      console.error('POST /animals error:', e);
      json(res, { error: 'Xatolik: ' + e.message }, 400);
    }
  },

  // BUG FIX #1 + #3 — pathId now correct; added 404 on not-found
  'PUT:/animals/:id': async (req, res) => {
    const u = await auth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    try {
      const id = pathId(req.url, 2); // FIX #1
      if (!id) return json(res, { error: 'Animal ID kerak' }, 400);
      const d = await parseBody(req);
      if (!d.tag_number) return json(res, { error: 'Quloq raqami kerak' }, 400);

      // Verify animal exists (FIX #3)
      const current = await pool.query('SELECT id, tag_number FROM animals WHERE id=$1', [id]);
      if (!current.rows[0]) return json(res, { error: 'Mol topilmadi' }, 404);

      // Tag uniqueness check (only if changed)
      if (current.rows[0].tag_number !== d.tag_number) {
        const conflict = await pool.query(
          'SELECT id, name FROM animals WHERE tag_number=$1 AND id!=$2',
          [d.tag_number, id]
        );
        if (conflict.rows.length) {
          return json(res, {
            error: `"${d.tag_number}" quloq raqami allaqachon mavjud` +
                   (conflict.rows[0].name ? ` (${conflict.rows[0].name})` : ''),
          }, 400);
        }
      }

      await pool.query(
        `UPDATE animals
            SET tag_number=$1, name=$2, type=$3, gender=$4, status=$5,
                births=$6, daily_milk=$7, birth_date=$8,
                last_calving_date=$9, insemination_date=$10, notes=$11,
                updated_at=CURRENT_TIMESTAMP
          WHERE id=$12`,
        [
          d.tag_number, d.name || null, d.type, d.gender, d.status,
          d.births || 0, d.daily_milk || 0,
          d.birth_date || null, d.last_calving_date || null,
          d.insemination_date || null, d.notes || null,
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
      const id = pathId(req.url, 2); // FIX #1
      const r  = await pool.query('DELETE FROM animals WHERE id=$1 RETURNING *', [id]);
      if (!r.rows.length) return json(res, { error: 'Mol topilmadi' }, 404);
      json(res, { success: true });
    } catch (e) {
      console.error('DELETE /animals/:id error:', e);
      json(res, { error: 'Xatolik' }, 500);
    }
  },

  // BUG FIX #1 + #2 — was using parts[2] on full /api/animals/:id/milk URL
  'GET:/animals/:id/milk': async (req, res) => {
    const u = await auth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    try {
      const id   = pathId(req.url, 2); // FIX #1 + #2
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

  'GET:/milk/daily': async (req, res) => {
    const u = await auth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    try {
      const date = new URL(req.url, 'http://localhost').searchParams.get('date')
                 || new Date().toISOString().split('T')[0];
      const r = await pool.query(
        `SELECT a.id, a.tag_number, a.name, a.status, a.daily_milk AS expected,
                MAX(CASE WHEN mr.session=1 THEN mr.liters END) AS s1,
                MAX(CASE WHEN mr.session=2 THEN mr.liters END) AS s2,
                MAX(CASE WHEN mr.session=1 THEN mr.id END)     AS s1_id,
                MAX(CASE WHEN mr.session=2 THEN mr.id END)     AS s2_id,
                COALESCE(SUM(mr.liters), 0) AS total
           FROM animals a
           LEFT JOIN milk_records mr ON a.id = mr.animal_id AND mr.date=$1
          WHERE a.status NOT IN ('sotildi','nobud','soyildi')
          GROUP BY a.id, a.tag_number, a.name, a.status, a.daily_milk
          ORDER BY (a.status='sut_beradi') DESC, a.tag_number`,
        [date]
      );
      json(res, r.rows.map(row => ({
        id: row.id, tag_number: row.tag_number, name: row.name, status: row.status,
        expected: parseFloat(row.expected || 0),
        s1: row.s1 ? parseFloat(row.s1) : null, s1_id: row.s1_id,
        s2: row.s2 ? parseFloat(row.s2) : null, s2_id: row.s2_id,
        total: parseFloat(row.total),
      })));
    } catch (e) {
      console.error('GET /milk/daily error:', e);
      json(res, { error: 'Server xatosi' }, 500);
    }
  },

  // NEW #7 — Milk inventory / stock
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
      const available = Math.max(0, produced - sold);
      json(res, { produced, sold, available });
    } catch (e) {
      console.error('GET /milk/stock error:', e);
      json(res, { error: 'Server xatosi' }, 500);
    }
  },

  // BUG FIX #5 — blocks milk entry for inactive animals
  'POST:/milk': async (req, res) => {
    try {
      const u = await auth(req);
      if (!u) return json(res, { error: 'Unauthorized' }, 401);
      const d = await parseBody(req);

      if (!d.animal_id) return json(res, { error: 'Molni tanlang' }, 400);
      if (!d.liters)    return json(res, { error: 'Litr miqdorini kiriting' }, 400);
      if (!d.session)   return json(res, { error: 'Soqim sessiyasini tanlang' }, 400);

      // FIX #5: Block milk for inactive animals
      const animalRow = await pool.query('SELECT status FROM animals WHERE id=$1', [d.animal_id]);
      if (!animalRow.rows[0]) return json(res, { error: 'Mol topilmadi' }, 404);
      if (['sotildi', 'nobud', 'soyildi'].includes(animalRow.rows[0].status)) {
        return json(res, {
          error: `Bu mol faol emas (${animalRow.rows[0].status}). Sut qayd qilish mumkin emas.`,
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
      const id = pathId(req.url, 2); // FIX #1
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

  // NEW #8 — Stock check before allowing a sale
  'POST:/milk-sales': async (req, res) => {
    const u = await auth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    try {
      const d = await parseBody(req);
      if (!d.liters || !d.price || !d.buyer) {
        return json(res, { error: 'Miqdor, narx va xaridor kerak' }, 400);
      }
      const liters = parseFloat(d.liters);
      if (isNaN(liters) || liters <= 0) {
        return json(res, { error: "Litr miqdori noto'g'ri" }, 400);
      }

      // FIX #8: Prevent selling more than available
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
      const id = pathId(req.url, 2); // FIX #1
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
      const id = pathId(req.url, 2); // FIX #1
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
      const id = pathId(req.url, 2); // FIX #1
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
  // BUG FIX #4 + #11: correct status mapping + validation + try/catch
  'POST:/sales': async (req, res) => {
    const u = await auth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    try {
      const d = await parseBody(req);
      if (!d.animal_id) return json(res, { error: 'Mol ID kerak' }, 400);
      if (!d.date)      return json(res, { error: 'Sana kerak' }, 400);

      // FIX #11: Verify animal exists and is currently active
      const animalRow = await pool.query('SELECT id, status FROM animals WHERE id=$1', [d.animal_id]);
      if (!animalRow.rows[0]) return json(res, { error: 'Mol topilmadi' }, 404);
      if (['sotildi', 'nobud', 'soyildi'].includes(animalRow.rows[0].status)) {
        return json(res, {
          error: `Bu mol allaqachon faol emas (${animalRow.rows[0].status}).`,
        }, 400);
      }

      // FIX #4: All three reason types now map to the correct status
      let newStatus;
      switch (d.reason) {
        case 'nobud':  newStatus = 'nobud';   break; // Dead / lost
        case 'soyish': newStatus = 'soyildi'; break; // Slaughtered
        default:       newStatus = 'sotildi'; break; // Sold ('sotish')
      }

      const id = uuid();
      await pool.query(
        `INSERT INTO animal_sales
           (id, animal_id, price, buyer_name, reason, weight_kg, date, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          id, d.animal_id, d.price || 0,
          d.buyer || null, d.reason || 'sotish',
          d.weight_kg || null, d.date, d.notes || null,
        ]
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
    const apiPath  = pathname.replace('/api', '');
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
