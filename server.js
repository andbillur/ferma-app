const http = require('http');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const PORT       = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const SALT       = 'ferma-app-salt-2024';
const sessions   = {};

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function initDB() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(32) PRIMARY KEY, username VARCHAR(50) UNIQUE NOT NULL,
      password VARCHAR(64) NOT NULL, role VARCHAR(20) DEFAULT 'user',
      name VARCHAR(100), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);

    await pool.query(`CREATE TABLE IF NOT EXISTS animals (
      id VARCHAR(32) PRIMARY KEY, tag_number VARCHAR(50) UNIQUE NOT NULL,
      name VARCHAR(100), type VARCHAR(20), gender VARCHAR(20), status VARCHAR(30),
      births INTEGER DEFAULT 0, daily_milk DECIMAL(5,2) DEFAULT 0,
      birth_date DATE, last_calving_date DATE, insemination_date DATE,
      notes TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);

    await pool.query(`ALTER TABLE animals ADD COLUMN IF NOT EXISTS insemination_date DATE`).catch(()=>{});
    await pool.query(`ALTER TABLE animals ADD COLUMN IF NOT EXISTS last_calving_date DATE`).catch(()=>{});

    await pool.query(`CREATE TABLE IF NOT EXISTS milk_records (
      id VARCHAR(32) PRIMARY KEY,
      animal_id VARCHAR(32) REFERENCES animals(id) ON DELETE SET NULL,
      date DATE NOT NULL, session INTEGER NOT NULL, liters DECIMAL(6,2) NOT NULL,
      notes TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);

    await pool.query(`CREATE TABLE IF NOT EXISTS milk_sales (
      id VARCHAR(32) PRIMARY KEY, date DATE NOT NULL,
      liters DECIMAL(6,2) NOT NULL, price DECIMAL(8,2) NOT NULL,
      total DECIMAL(10,2) NOT NULL, buyer VARCHAR(100) NOT NULL,
      phone VARCHAR(20), notes TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);

    await pool.query(`CREATE TABLE IF NOT EXISTS expenses (
      id VARCHAR(32) PRIMARY KEY, category VARCHAR(50) NOT NULL,
      amount DECIMAL(10,2) NOT NULL, description TEXT, date DATE NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);

    await pool.query(`CREATE TABLE IF NOT EXISTS animal_sales (
      id VARCHAR(32) PRIMARY KEY,
      animal_id VARCHAR(32) REFERENCES animals(id) ON DELETE SET NULL,
      price DECIMAL(10,2) DEFAULT 0, buyer_name VARCHAR(100),
      reason VARCHAR(30), weight_kg DECIMAL(6,2), date DATE NOT NULL,
      notes TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_milk_date    ON milk_records(date)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_milk_animal  ON milk_records(animal_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_ms_date      ON milk_sales(date)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_exp_date     ON expenses(date)`);

    const ex = await pool.query(`SELECT id FROM users WHERE username=$1`, ['admin']);
    if (!ex.rows.length) {
      await pool.query(
        `INSERT INTO users (id,username,password,role,name) VALUES ($1,$2,$3,$4,$5)`,
        [uuid(), 'admin', hashPassword('admin123'), 'admin', 'Admin']
      );
    }
    console.log('DB ready');
  } catch(e) { console.error('DB init error:', e); }
}

function uuid()           { return crypto.randomBytes(16).toString('hex'); }
function hashPassword(p)  { return crypto.createHash('sha256').update(p + SALT).digest('hex'); }
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
    .then(r => r.rows[0] || null).catch(() => null);
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
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-session-token',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
  });
  res.end(JSON.stringify(data));
}
// Password reset verification system
const passwordResetCodes = new Map();

function generateVerificationCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

// Create admin password resets table if not exists
async function createPasswordResetTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS password_resets (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL,
        code TEXT NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        used BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('Password resets table created or already exists');
  } catch (error) {
    console.error('Error creating password reset table:', error);
  }
}

// Email configuration (optional)
let transporter = null;
try {
  const nodemailer = require('nodemailer');
  transporter = nodemailer.createTransporter({
    service: 'gmail',
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: 'info@andbillur.com',
      pass: process.env.GMAIL_APP_PASSWORD || 'your-app-password' // Use environment variable
    },
    tls: {
      rejectUnauthorized: false
    }
  });
  console.log('✅ Nodemailer loaded successfully with Gmail service');
} catch (error) {
  console.log('⚠️  Nodemailer not available, using console.log fallback');
}

async function sendAdminResetEmail(code, username) {
  try {
    if (transporter) {
      const mailOptions = {
        from: 'info@andbillur.com',
        to: 'info@andbillur.com',
        subject: 'Password Reset Code',
        text: `Password reset code for user "${username}": ${code}`,
        html: `<h2>Password Reset Code</h2><p>Reset code for user <strong>${username}</strong>: <h3>${code}</h3></p><p>This code expires in 10 minutes.</p>`
      };
      
      const result = await transporter.sendMail(mailOptions);
      console.log(`✅ Email sent successfully to admin for user: ${username}, code: ${code}`);
      console.log(`Message ID: ${result.messageId}`);
      return true;
    } else {
      // Fallback: Just log to console
      console.log(`⚠️  Nodemailer not available - using console fallback`);
      console.log(`=== PASSWORD RESET CODE ===`);
      console.log(`User: ${username}`);
      console.log(`Code: ${code}`);
      console.log(`Email would be sent to: info@andbillur.com`);
      console.log(`=======================`);
      return true;
    }
  } catch (error) {
    console.error('❌ Email sending error:', error);
    console.error('Error details:', {
      code: error.code,
      message: error.message,
      command: error.command,
      response: error.response
    });
    return false;
  }
}

function sendPasswordResetEmail(email, code, userName) {
  // Email template for password reset
  const emailTemplate = `Salom ${userName},

Parolni o'zgartirish uchun quyidagi tasdiqlash kodini kiriting:

🔐 KOD: ${code}

⏳ Kod 15 daqiqa davomida amal qiladi.

Agar bu siz bo'lmasangiz — e'tibor bermang.

— AndBillur Ferma tizimi`;

  // Bu yerda haqiqiy email service integratsiya qilinishi kerak
  console.log(`Email yuborilmoqda ${email} ga:`, emailTemplate);
  console.log(`Verification code: ${code}`);
  
  // Temporary: return true (haqiqiy email service qo'shilganda o'zgartiriladi)
  return true;
}

function sendPasswordChangeConfirmation(email, userName, ipAddress, device) {
  // Email template for password change confirmation
  const emailTemplate = `Salom ${userName},

Sizning ferma.andbillur.com hisobingiz uchun parol muvaffaqiyatli o'zgartirildi.

Agar bu o'zgarishni siz bajargan bo'lsangiz, hech qanday qo'shimcha harakat talab qilinmaydi.

Agar bu harakatni siz amalga oshirmagan bo'lsangiz, iltimos darhol quyidagi choralarni ko'ring:

Parolingizni qayta tiklang
Hisobingizga kirishni tekshiring
Administrator bilan bog'laning

📅 Sana: ${new Date().toLocaleString('uz-UZ')}
🌐 IP manzil: ${ipAddress}
📍 Qurilma: ${device}

Xavfsizlik uchun hech qachon parolingizni boshqa birov bilan ulashmang.

— AndBillur Ferma tizimi`;

  console.log(`Password change confirmation email yuborilmoqda ${email} ga:`, emailTemplate);
  
  // Temporary: return true (haqiqiy email service qo'shilganda o'zgartiriladi)
  return true;
}

function serveStatic(res, filePath) {
  const ext = path.extname(filePath);
  const types = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css' };
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
    res.end(content);
  } catch { res.writeHead(404); res.end('Not found'); }
}
function pathId(url, pos) {
  return new URL(url, 'http://localhost').pathname.split('/')[pos] || '';
}

const routes = {
  // AUTH
  'POST:/login': async (req, res) => {
    const { username, password } = await parseBody(req);
    if (!username || !password) return json(res, { error: 'Login va parol kerak' }, 400);
    const r = await pool.query('SELECT * FROM users WHERE username=$1 AND password=$2', [username, hashPassword(password)]);
    if (!r.rows[0]) return json(res, { error: "Noto'g'ri login yoki parol" }, 401);
    const user = r.rows[0];
    const token = createSession(user.id);
    const isProd = process.env.NODE_ENV === 'production';
    res.setHeader('Set-Cookie', `token=${token}; Path=/; HttpOnly; SameSite=Lax${isProd?'; Secure':''}`);
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

  // TEST EMAIL ENDPOINT
  'POST:/admin/test-email': async (req, res) => {
    try {
      const testCode = Math.floor(100000 + Math.random() * 900000).toString();
      const emailSent = await sendAdminResetEmail(testCode, 'test-user');
      
      if (emailSent) {
        json(res, { 
          success: true, 
          message: 'Test email sent successfully',
          code: testCode
        });
      } else {
        json(res, { 
          success: false, 
          message: 'Failed to send test email'
        }, 500);
      }
    } catch (error) {
      console.error('Test email error:', error);
      return json(res, { error: 'Server xatosi: ' + error.message }, 500);
    }
  },

  // ADMIN PASSWORD RESET
  'POST:/admin/password-reset-request': async (req, res) => {
    try {
      
      const { username } = await parseBody(req);
      
      if (!username) {
        return json(res, { error: 'Username kerak' }, 400);
      }
      
      if (username.trim().length < 2) {
        return json(res, { error: 'Username kamida 2 ta belgidan iborat bo\'lishi kerak' }, 400);
      }
      
      // Generate 6-digit code
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
      
      console.log(`🔐 Password reset request for username: ${username}`);
      console.log(`📧 Generated code: ${code}`);
      console.log(`⏰ Expires at: ${expiresAt}`);
      
      // Save to database
      try {
        await pool.query(
          'INSERT INTO password_resets (username, code, expires_at) VALUES ($1, $2, $3)',
          [username, code, expiresAt]
        );
        console.log(`✅ Code saved to database for user: ${username}`);
      } catch (dbError) {
        console.error('❌ Database error saving reset code:', dbError);
        return json(res, { error: 'Database xatosi' }, 500);
      }
      
      // Send email to admin
      try {
        console.log(`📤 Attempting to send email to admin...`);
        const emailSent = await sendAdminResetEmail(code, username);
        if (!emailSent) {
          console.error('❌ Failed to send admin email');
          return json(res, { error: 'Email yuborishda xatolik' }, 500);
        }
        console.log(`✅ Email sent successfully to admin`);
      } catch (emailError) {
        console.error('❌ Email service error:', emailError);
        return json(res, { error: 'Email xizmatida xatolik' }, 500);
      }
      
      // Always return success for security
      json(res, { 
        success: true, 
        message: 'Tasdiqlash kodi admin emailiga yuborildi' 
      });
      
    } catch (error) {
      console.error('Admin password reset request error:', error);
      return json(res, { error: 'Server xatosi: ' + error.message }, 500);
    }
  },

  'POST:/admin/password-reset-confirm': async (req, res) => {
    try {
      
      const { username, code, newPassword } = await parseBody(req);
      
      // Validate inputs
      if (!username || !code || !newPassword) {
        return json(res, { error: 'Username, kod va yangi parol kerak' }, 400);
      }
      
      if (newPassword.length < 6) {
        return json(res, { error: 'Parol kamida 6 ta belgidan iborat bo\'lishi kerak' }, 400);
      }
      
      // Check if code exists and is valid
      const resetResult = await pool.query(
        'SELECT id, expires_at, used FROM password_resets WHERE username=$1 AND code=$2 ORDER BY created_at DESC LIMIT 1',
        [username, code]
      );
      
      if (!resetResult.rows[0]) {
        return json(res, { error: 'Noto\'g\'ri tasdiqlash kodi' }, 400);
      }
      
      const reset = resetResult.rows[0];
      
      if (reset.used) {
        return json(res, { error: 'Bu kod allaqachon ishlatilgan' }, 400);
      }
      
      if (new Date() > new Date(reset.expires_at)) {
        return json(res, { error: 'Kodning muddati o\'tgan' }, 400);
      }
      
      // Update user password
      const userResult = await pool.query('SELECT id FROM users WHERE username=$1', [username]);
      if (!userResult.rows[0]) {
        return json(res, { error: 'Foydalanuvchi topilmadi' }, 404);
      }
      
      await pool.query(
        'UPDATE users SET password=$1 WHERE id=$2',
        [hashPassword(newPassword), userResult.rows[0].id]
      );
      
      // Mark code as used
      await pool.query(
        'UPDATE password_resets SET used=true WHERE id=$1',
        [reset.id]
      );
      
      json(res, { 
        success: true, 
        message: 'Parol muvaffaqiyatli o\'zgartirildi' 
      });
      
    } catch (error) {
      console.error('Admin password reset confirm error:', error);
      return json(res, { error: 'Server xatosi: ' + error.message }, 500);
    }
  },

  // STATS
  'GET:/stats/dashboard': async (req, res) => {
    const u = await auth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    const [aStats, milkToday, milk7, revToday, recentSales] = await Promise.all([
      pool.query(`SELECT COUNT(*) FILTER (WHERE status!='sotildi') AS total,
        COUNT(*) FILTER (WHERE status='sut_beradi') AS sut,
        COUNT(*) FILTER (WHERE status='kasal') AS kasal,
        COUNT(*) FILTER (WHERE status='bogoz') AS bogoz,
        COUNT(*) FILTER (WHERE status='bozak') AS bozak FROM animals`),
      pool.query(`SELECT COALESCE(SUM(liters),0) AS liters FROM milk_records WHERE date=CURRENT_DATE`),
      pool.query(`SELECT date::text, SUM(liters) AS liters FROM milk_records WHERE date>=CURRENT_DATE-INTERVAL '6 days' GROUP BY date ORDER BY date`),
      pool.query(`SELECT COALESCE(SUM(total),0) AS total FROM milk_sales WHERE date=CURRENT_DATE`),
      pool.query(`SELECT * FROM milk_sales ORDER BY date DESC, created_at DESC LIMIT 6`),
    ]);
    const last7 = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const ds = d.toISOString().split('T')[0];
      const found = milk7.rows.find(r => r.date === ds);
      last7.push({ date: ds, liters: found ? parseFloat(found.liters) : 0 });
    }
    const s = aStats.rows[0];
    json(res, {
      todayLiters: parseFloat(milkToday.rows[0].liters),
      todayRevenue: parseFloat(revToday.rows[0].total),
      last7,
      animalStats: { total:parseInt(s.total), sut:parseInt(s.sut), kasal:parseInt(s.kasal), bogoz:parseInt(s.bogoz), bozak:parseInt(s.bozak) },
      recentMilk: recentSales.rows.map(r => ({ ...r, liters:parseFloat(r.liters), price:parseFloat(r.price), total:parseFloat(r.total) })),
    });
  },

  'GET:/stats/finance': async (req, res) => {
    const u = await auth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    const { period='month' } = new URL(req.url,'http://localhost').searchParams;
    let cond, grp;
    switch(period) {
      case 'day':   cond="date=CURRENT_DATE";                         grp="date::text"; break;
      case 'week':  cond="date>=CURRENT_DATE-INTERVAL '6 days'";      grp="date::text"; break;
      case 'month': cond="date>=CURRENT_DATE-INTERVAL '29 days'";     grp="date::text"; break;
      case 'year':  cond="date>=CURRENT_DATE-INTERVAL '364 days'";    grp="to_char(date,'YYYY-MM')"; break;
      default:      cond="date>=CURRENT_DATE-INTERVAL '29 days'";     grp="date::text";
    }
    const [ms,ex,as2,byCatR,msC,exC] = await Promise.all([
      pool.query(`SELECT COALESCE(SUM(total),0) AS rev, COALESCE(SUM(liters),0) AS liters FROM milk_sales WHERE ${cond}`),
      pool.query(`SELECT COALESCE(SUM(amount),0) AS tot, COUNT(*) AS cnt FROM expenses WHERE ${cond}`),
      pool.query(`SELECT COALESCE(SUM(price),0) AS rev, COUNT(*) AS cnt FROM animal_sales WHERE ${cond}`),
      pool.query(`SELECT category, SUM(amount) AS tot FROM expenses WHERE ${cond} GROUP BY category ORDER BY tot DESC`),
      pool.query(`SELECT ${grp} AS d, COALESCE(SUM(total),0) AS income FROM milk_sales WHERE ${cond} GROUP BY d ORDER BY d`),
      pool.query(`SELECT ${grp} AS d, COALESCE(SUM(amount),0) AS expense FROM expenses WHERE ${cond} GROUP BY d ORDER BY d`),
    ]);
    const map = {};
    msC.rows.forEach(r => { map[r.d]={date:r.d, income:parseFloat(r.income), expense:0}; });
    exC.rows.forEach(r => { if(map[r.d]) map[r.d].expense=parseFloat(r.expense); else map[r.d]={date:r.d,income:0,expense:parseFloat(r.expense)}; });
    const byCat = {}; byCatR.rows.forEach(r => { byCat[r.category]=parseFloat(r.tot); });
    const milkRevenue=parseFloat(ms.rows[0].rev), salesRevenue=parseFloat(as2.rows[0].rev), totalExp=parseFloat(ex.rows[0].tot);
    json(res, {
      milkRevenue, milkLiters:parseFloat(ms.rows[0].liters),
      salesRevenue, salesCount:parseInt(as2.rows[0].cnt),
      totalExpenses:totalExp, expCount:parseInt(ex.rows[0].cnt),
      netProfit:milkRevenue+salesRevenue-totalExp,
      chart:Object.values(map).sort((a,b)=>a.date.localeCompare(b.date)),
      byCat,
    });
  },

  // ANIMALS
  'GET:/animals': async (req, res) => {
    const u = await auth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    const sp = new URL(req.url,'http://localhost').searchParams;
    const search=sp.get('search'), status=sp.get('status');
    const page=parseInt(sp.get('page')||'1'), limit=parseInt(sp.get('limit')||'200');
    const conds=[], params=[];
    if (search) { conds.push(`(tag_number ILIKE $${params.length+1} OR name ILIKE $${params.length+1})`); params.push(`%${search}%`); }
    if (status) { conds.push(`status=$${params.length+1}`); params.push(status); }
    const where = conds.length ? ' WHERE '+conds.join(' AND ') : '';
    params.push(limit, (page-1)*limit);
    const r = await pool.query(`SELECT * FROM animals${where} ORDER BY created_at DESC LIMIT $${params.length-1} OFFSET $${params.length}`, params);
    json(res, r.rows);
  },

  'POST:/animals': async (req, res) => {
    const u = await auth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    const d = await parseBody(req);
    if (!d.tag_number) return json(res, { error: 'Quloq raqami kerak' }, 400);
    const ex = await pool.query('SELECT id FROM animals WHERE tag_number=$1', [d.tag_number]);
    if (ex.rows.length) return json(res, { error: `"${d.tag_number}" quloq raqami allaqachon mavjud` }, 400);
    const id = uuid();
    try {
      await pool.query(`INSERT INTO animals (id,tag_number,name,type,gender,status,births,daily_milk,birth_date,last_calving_date,insemination_date,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [id,d.tag_number,d.name||null,d.type||'sigir',d.gender||'female',d.status||'sut_beradi',d.births||0,d.daily_milk||0,d.birth_date||null,d.last_calving_date||null,d.insemination_date||null,d.notes||null]);
      const r = await pool.query('SELECT * FROM animals WHERE id=$1', [id]);
      json(res, r.rows[0]);
    } catch(e) { json(res, { error: 'Xatolik: '+e.message }, 400); }
  },

  'PUT:/animals/:id': async (req, res) => {
    const u = await auth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    const id = pathId(req.url, 2);
    if (!id) return json(res, { error: 'Animal ID kerak' }, 400);
    const d = await parseBody(req);
    console.log('PUT /animals/:id data:', { id, data: d });
    console.log('Received ID from URL:', id);
    console.log('ID length:', id.length);
    if (!d.tag_number) return json(res, { error: 'Quloq raqami kerak' }, 400);
    
    // Skip existence check for now - try direct update
    console.log('Attempting direct update for ID:', id);
    
    // Faqat boshqa molga tegishli bo'lsa tekshiramiz
    // Get current tag for uniqueness check
    const current = await pool.query('SELECT tag_number FROM animals WHERE id=$1', [id]);
    const currentTag = current.rows[0]?.tag_number;
    console.log('Current tag from DB:', currentTag);
    console.log('PUT animals current tag:', currentTag, 'new tag:', d.tag_number);
    
    // Agar quloq raqam o'zgarmagan bo'lsa, tekshirish shart emas
    if (currentTag !== d.tag_number) {
      console.log('Tag changed from', currentTag, 'to', d.tag_number, 'checking uniqueness...');
      
      // Barcha animals larni ko'rish uchun debug
      const allAnimals = await pool.query('SELECT id, tag_number, name FROM animals ORDER BY tag_number');
      console.log('All animals in database:', allAnimals.rows);
      
      const ex = await pool.query('SELECT id, tag_number, name FROM animals WHERE tag_number=$1 AND id!=$2', [d.tag_number, id]);
      console.log('Uniqueness check result for tag', d.tag_number, ':', ex.rows);
      if (ex.rows.length > 0) {
        console.log('Tag', d.tag_number, 'already exists for animal:', ex.rows[0]);
        return json(res, { error: `"${d.tag_number}" quloq raqami allaqachon mavjud (mol: ${ex.rows[0].name || 'nomalum'})` }, 400);
      }
      console.log('Tag', d.tag_number, 'is unique, proceeding with update');
    } else {
      console.log('Tag not changed, skipping uniqueness check');
    }
    try {
      await pool.query(`UPDATE animals SET tag_number=$1,name=$2,type=$3,gender=$4,status=$5,births=$6,daily_milk=$7,birth_date=$8,last_calving_date=$9,insemination_date=$10,notes=$11 WHERE id=$12`,
        [d.tag_number,d.name||null,d.type,d.gender,d.status,d.births||0,d.daily_milk||0,d.birth_date||null,d.last_calving_date||null,d.insemination_date||null,d.notes||null,id]);
      const r = await pool.query('SELECT * FROM animals WHERE id=$1', [id]);
      json(res, r.rows[0]);
    } catch(e) { json(res, { error: 'Xatolik: '+e.message }, 400); }
  },

  'DELETE:/animals/:id': async (req, res) => {
    const u = await adminAuth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    const id = pathId(req.url, 2);
    try {
      const r = await pool.query('DELETE FROM animals WHERE id=$1 RETURNING *', [id]);
      if (!r.rows.length) return json(res, { error: 'Topilmadi' }, 404);
      json(res, { success: true });
    } catch(e) { json(res, { error: 'Xatolik' }, 500); }
  },

  'GET:/animals/:id/milk': async (req, res) => {
    const u = await auth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    const parts = new URL(req.url,'http://localhost').pathname.split('/');
    const id = parts[2];
    const days = parseInt(new URL(req.url,'http://localhost').searchParams.get('days')||'30');
    const r = await pool.query(`
      SELECT date::text,
        SUM(liters) AS total,
        MAX(CASE WHEN session=1 THEN liters END) AS s1,
        MAX(CASE WHEN session=2 THEN liters END) AS s2
      FROM milk_records
      WHERE animal_id=$1 AND date>=CURRENT_DATE-($2||' days')::interval
      GROUP BY date ORDER BY date`,
      [id, days]
    );
    json(res, r.rows.map(row => ({
      date:row.date, total:parseFloat(row.total),
      s1:row.s1?parseFloat(row.s1):null, s2:row.s2?parseFloat(row.s2):null
    })));
  },

  // MILK
  'GET:/milk': async (req, res) => {
    const u = await auth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    const sp = new URL(req.url,'http://localhost').searchParams;
    const date=sp.get('date'), limit=parseInt(sp.get('limit')||'60');
    let q = `SELECT mr.*, a.tag_number, a.name AS animal_name FROM milk_records mr LEFT JOIN animals a ON mr.animal_id=a.id`;
    const params=[];
    if (date) { q+=' WHERE mr.date=$1 ORDER BY a.tag_number, mr.session'; params.push(date); }
    else       { q+=' ORDER BY mr.date DESC, mr.created_at DESC LIMIT $1'; params.push(limit); }
    const r = await pool.query(q, params);
    json(res, r.rows);
  },

  'GET:/milk/daily': async (req, res) => {
    const u = await auth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    const date = new URL(req.url,'http://localhost').searchParams.get('date') || new Date().toISOString().split('T')[0];
    const r = await pool.query(`
      SELECT a.id, a.tag_number, a.name, a.status, a.daily_milk AS expected,
        MAX(CASE WHEN mr.session=1 THEN mr.liters END) AS s1,
        MAX(CASE WHEN mr.session=2 THEN mr.liters END) AS s2,
        MAX(CASE WHEN mr.session=1 THEN mr.id END) AS s1_id,
        MAX(CASE WHEN mr.session=2 THEN mr.id END) AS s2_id,
        COALESCE(SUM(mr.liters), 0) AS total
      FROM animals a
      LEFT JOIN milk_records mr ON a.id=mr.animal_id AND mr.date=$1
      WHERE a.status NOT IN ('sotildi','nobud')
      GROUP BY a.id, a.tag_number, a.name, a.status, a.daily_milk
      ORDER BY (a.status='sut_beradi') DESC, a.tag_number`,
      [date]
    );
    json(res, r.rows.map(row => ({
      id:row.id, tag_number:row.tag_number, name:row.name, status:row.status,
      expected:parseFloat(row.expected||0),
      s1:row.s1?parseFloat(row.s1):null, s1_id:row.s1_id,
      s2:row.s2?parseFloat(row.s2):null, s2_id:row.s2_id,
      total:parseFloat(row.total),
    })));
  },

  'POST:/milk': async (req, res) => {
    try {
      const u = await auth(req);
      console.log('User authenticated:', u ? 'Yes' : 'No');
      if (!u) {
        console.error('User not authenticated for milk submission');
        return json(res, { error: 'Unauthorized' }, 401);
      }
      const d = await parseBody(req);
      console.log('POST /milk data:', d);
      console.log('Milk submission data validation:', {
        hasAnimalId: !!d.animal_id,
        hasLiters: !!d.liters,
        hasSession: !!d.session,
        hasDate: !!d.date,
        litersValue: d.liters,
        animalIdValue: d.animal_id
      });
      
      if (!d.animal_id) return json(res, { error: 'Molni tanlang' }, 400);
      if (!d.liters || !d.session) return json(res, { error: 'Litr va sessiya kerak' }, 400);
      
      // Check for duplicate milk records
      if (d.animal_id) {
        console.log(`Checking for duplicate milk record for animal: ${d.animal_id}, date: ${d.date}, session: ${d.session}`);
        const dup = await pool.query('SELECT id FROM milk_records WHERE animal_id=$1 AND date=$2 AND session=$3', [d.animal_id, d.date, d.session]);
        if (dup.rows.length) {
          console.log(`Duplicate found: ${dup.rows.length} records`);
          return json(res, { error: `Bu mol uchun ${d.session}-soqim allaqachon qayd qilingan` }, 400);
        }
      }
      
      // Insert new milk record
      const id = uuid();
      console.log(`Inserting milk record with ID: ${id}`);
      
      await pool.query(`INSERT INTO milk_records (id,animal_id,date,session,liters,notes) VALUES ($1,$2,$3,$4,$5,$6)`,
        [id,d.animal_id||null,d.date,d.session,d.liters,d.notes||null]);
      
      console.log(`Milk record inserted successfully`);
      
      // Get the inserted record with animal details
      const r = await pool.query(`SELECT mr.*, a.tag_number, a.name AS animal_name FROM milk_records mr LEFT JOIN animals a ON mr.animal_id=a.id WHERE mr.id=$1`, [id]);
      
      if (r.rows[0]) {
        console.log(`Milk record retrieved successfully: ${r.rows[0].animal_name}`);
        json(res, r.rows[0]);
      } else {
        console.error('Failed to retrieve inserted milk record');
        return json(res, { error: 'Milk record saqlanmadi' }, 500);
      }
      
    } catch (error) {
      console.error('Milk submission error:', error);
      console.error('Error details:', {
        message: error.message,
        code: error.code,
        detail: error.detail,
        where: error.where
      });
      return json(res, { error: 'Server xatosi: ' + error.message }, 500);
    }
  },

  'DELETE:/milk/:id': async (req, res) => {
    const u = await auth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    const id = pathId(req.url, 2);
    try {
      const r = await pool.query('DELETE FROM milk_records WHERE id=$1 RETURNING *', [id]);
      if (!r.rows.length) return json(res, { error: 'Topilmadi' }, 404);
      json(res, { success: true });
    } catch(e) { json(res, { error: 'Xatolik' }, 500); }
  },

  // MILK SALES
  'GET:/milk-sales': async (req, res) => {
    const u = await auth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    const sp=new URL(req.url,'http://localhost').searchParams;
    const date=sp.get('date'), limit=parseInt(sp.get('limit')||'60');
    let q='SELECT * FROM milk_sales';
    const params=[];
    if(date){q+=' WHERE date=$1 ORDER BY created_at DESC';params.push(date);}
    else{q+=' ORDER BY date DESC, created_at DESC LIMIT $1';params.push(limit);}
    json(res, (await pool.query(q, params)).rows);
  },

  'POST:/milk-sales': async (req, res) => {
    const u = await auth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    const d = await parseBody(req);
    if (!d.liters||!d.price||!d.buyer) return json(res, { error: 'Miqdor, narx va xaridor kerak' }, 400);
    const id=uuid();
    const total=parseFloat(d.liters)*parseFloat(d.price);
    await pool.query(`INSERT INTO milk_sales (id,date,liters,price,total,buyer,phone,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id,d.date,d.liters,d.price,total,d.buyer,d.phone||null,d.notes||null]);
    json(res, (await pool.query('SELECT * FROM milk_sales WHERE id=$1',[id])).rows[0]);
  },

  'DELETE:/milk-sales/:id': async (req, res) => {
    const u = await auth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    const id = pathId(req.url, 2);
    try {
      const r = await pool.query('DELETE FROM milk_sales WHERE id=$1 RETURNING *',[id]);
      if(!r.rows.length) return json(res,{error:'Topilmadi'},404);
      json(res,{success:true});
    } catch(e){json(res,{error:'Xatolik'},500);}
  },

  // EXPENSES
  'GET:/expenses': async (req, res) => {
    const u = await auth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    const limit=parseInt(new URL(req.url,'http://localhost').searchParams.get('limit')||'60');
    json(res,(await pool.query('SELECT * FROM expenses ORDER BY date DESC, created_at DESC LIMIT $1',[limit])).rows);
  },

  'POST:/expenses': async (req, res) => {
    const u = await auth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    const d = await parseBody(req);
    if (!d.amount) return json(res, { error: 'Miqdor kerak' }, 400);
    const id=uuid();
    await pool.query(`INSERT INTO expenses (id,category,amount,description,date) VALUES ($1,$2,$3,$4,$5)`,
      [id,d.category||'boshqa',d.amount,d.description||null,d.date]);
    json(res,(await pool.query('SELECT * FROM expenses WHERE id=$1',[id])).rows[0]);
  },

  'DELETE:/expenses/:id': async (req, res) => {
    const u = await auth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    const id = pathId(req.url, 2);
    try {
      const r = await pool.query('DELETE FROM expenses WHERE id=$1 RETURNING *',[id]);
      if(!r.rows.length) return json(res,{error:'Topilmadi'},404);
      json(res,{success:true});
    } catch(e){json(res,{error:'Xatolik'},500);}
  },

  // USERS
  'GET:/users': async (req, res) => {
    const u = await adminAuth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    json(res,(await pool.query('SELECT id,username,role,name,created_at FROM users ORDER BY created_at DESC')).rows);
  },

  'POST:/users': async (req, res) => {
    const u = await adminAuth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    const d = await parseBody(req);
    if (!d.username||!d.password) return json(res,{error:'Username va parol kerak'},400);
    const ex = await pool.query('SELECT id FROM users WHERE username=$1',[d.username]);
    if(ex.rows.length) return json(res,{error:`"${d.username}" allaqachon mavjud`},400);
    const id=uuid();
    await pool.query(`INSERT INTO users (id,username,password,role,name) VALUES ($1,$2,$3,$4,$5)`,
      [id,d.username,hashPassword(d.password),d.role||'worker',d.name||d.username]);
    json(res,(await pool.query('SELECT id,username,role,name,created_at FROM users WHERE id=$1',[id])).rows[0]);
  },

  'DELETE:/users/:id': async (req, res) => {
    const u = await adminAuth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    const id = pathId(req.url, 2);
    if(id===u.id) return json(res,{error:"O'z o'zingizni o'chira olmaysiz"},400);
    try {
      const r = await pool.query('DELETE FROM users WHERE id=$1 RETURNING *',[id]);
      if(!r.rows.length) return json(res,{error:'Topilmadi'},404);
      json(res,{success:true});
    } catch(e){json(res,{error:'Xatolik'},500);}
  },

  // ANIMAL SALES
  'POST:/sales': async (req, res) => {
    const u = await auth(req);
    if (!u) return json(res, { error: 'Unauthorized' }, 401);
    const d = await parseBody(req);
    const id=uuid();
  const newStatus = (d.reason==='nobud') ? 'nobud' : 'sotildi';
    await pool.query(`INSERT INTO animal_sales (id,animal_id,price,buyer_name,reason,weight_kg,date,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id,d.animal_id,d.price||0,d.buyer||null,d.reason||'sotish',d.weight_kg||null,d.date,d.notes||null]);
    await pool.query(`UPDATE animals SET status=$1, updated_at=CURRENT_TIMESTAMP WHERE id=$2`,[newStatus,d.animal_id]);
    json(res,{success:true});
  },
};

function matchPath(pattern, path) {
  const pp=pattern.split('/'), rp=path.split('/');
  if(pp.length!==rp.length) return false;
  return pp.every((part,i)=>part.startsWith(':')||part===rp[i]);
}

function parseCookies(req) {
  return (req.headers.cookie||'').split(';').reduce((acc,c)=>{
    const [k,...v]=c.trim().split('=');
    if(k) acc[k.trim()]=v.join('=').trim();
    return acc;
  },{});
}

const server = http.createServer(async (req, res) => {
  const method=req.method, url=req.url;
  const pathname=new URL(url,'http://localhost').pathname;
  req.cookies=parseCookies(req);

  if(method==='OPTIONS'){
    res.writeHead(200,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type, x-session-token','Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS'});
    return res.end();
  }

  if(pathname.startsWith('/api/')){
    const apiPath=pathname.replace('/api','');
    let routeKey=`${method}:${apiPath}`;
    let handler=routes[routeKey];
    if(!handler){
      for(const [pat,h] of Object.entries(routes)){
        if(pat.startsWith(method+':')){
          const patPath=pat.substring(method.length+1);
          if(matchPath(patPath,apiPath)){handler=h;routeKey=pat;break;}
        }
      }
    }
    if(handler){
      try{await handler(req,res);}
      catch(e){console.error('API Error:',e);json(res,{error:'Server xatosi'},500);}
    } else {
      json(res,{error:'Route topilmadi'},404);
    }
    return;
  }

  if(pathname==='/') serveStatic(res,path.join(PUBLIC_DIR,'index.html'));
  else serveStatic(res,path.join(PUBLIC_DIR,pathname));
});

initDB().then(async ()=>{
  // Create password reset tokens table
  await createPasswordResetTable();
  server.listen(PORT,'0.0.0.0',()=>console.log(`FermaApp running on port ${PORT}`));
}).catch(e=>{console.error('Failed to start:',e);process.exit(1);});
