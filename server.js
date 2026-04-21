const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const SALT = 'ferma-app-salt-2024';
const sessions = {};

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://username:password@localhost:5432/ferma_app',
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Database initialization
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(32) PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password VARCHAR(64) NOT NULL,
        role VARCHAR(20) DEFAULT 'user',
        name VARCHAR(100)
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS animals (
        id VARCHAR(32) PRIMARY KEY,
        tag_number VARCHAR(50) UNIQUE NOT NULL,
        name VARCHAR(100),
        type VARCHAR(20),
        gender VARCHAR(20),
        status VARCHAR(30),
        births INTEGER DEFAULT 0,
        daily_milk DECIMAL(5,2) DEFAULT 0,
        birth_date DATE,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS milk_records (
        id VARCHAR(32) PRIMARY KEY,
        animal_id VARCHAR(32) REFERENCES animals(id),
        date DATE NOT NULL,
        session INTEGER NOT NULL,
        liters DECIMAL(6,2) NOT NULL,
        price DECIMAL(8,2) NOT NULL,
        total DECIMAL(10,2) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS expenses (
        id VARCHAR(32) PRIMARY KEY,
        category VARCHAR(50) NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        description TEXT,
        date DATE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS milk_sales (
        id VARCHAR(32) PRIMARY KEY,
        date DATE NOT NULL,
        liters DECIMAL(6,2) NOT NULL,
        price DECIMAL(8,2) NOT NULL,
        total DECIMAL(10,2) NOT NULL,
        buyer VARCHAR(100) NOT NULL,
        phone VARCHAR(20),
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS animal_sales (
        id VARCHAR(32) PRIMARY KEY,
        animal_id VARCHAR(32) REFERENCES animals(id),
        price DECIMAL(10,2) NOT NULL,
        buyer_name VARCHAR(100),
        buyer_phone VARCHAR(20),
        date DATE NOT NULL,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Create default admin user if not exists
    const adminExists = await pool.query('SELECT id FROM users WHERE username = $1', ['admin']);
    if (adminExists.rows.length === 0) {
      const adminId = crypto.randomBytes(16).toString('hex');
      const hashedPassword = crypto.createHash('sha256').update('admin123' + SALT).digest('hex');
      await pool.query(
        'INSERT INTO users (id, username, password, role, name) VALUES ($1, $2, $3, $4, $5)',
        [adminId, 'admin', hashedPassword, 'admin', 'Admin']
      );
    }
    
    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Database initialization error:', error);
  }
}

// Helper functions
function uuid() { return crypto.randomBytes(16).toString('hex'); }

function hashPassword(p) {
  return crypto.createHash('sha256').update(p + SALT).digest('hex');
}

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
  const s = getSession(req.headers['x-session-token']);
  if (!s) return null;
  return pool.query('SELECT * FROM users WHERE id = $1', [s.userId])
    .then(result => result.rows[0] || null)
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
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-session-token',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
  });
  res.end(JSON.stringify(data));
}

function serveStatic(res, filePath) {
  const ext = path.extname(filePath);
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
    res.end(content);
  } catch { res.writeHead(404); res.end('Not found'); }
}

function todayStr() { return new Date().toISOString().split('T')[0]; }

function dateStr(daysAgo = 0) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().split('T')[0];
}

// API Routes
const routes = {
  // Auth
  'POST:/login': async (req, res) => {
    const { username, password } = await parseBody(req);
    if (!username || !password) { return json(res, { error: 'Login va parol required' }, 400); }
    
    const hashedPassword = hashPassword(password);
    const result = await pool.query(
      'SELECT * FROM users WHERE username = $1 AND password = $2',
      [username, hashedPassword]
    );
    
    if (result.rows.length === 0) { return json(res, { error: 'Noto\'g\'ri login yoki parol' }, 401); }
    
    const user = result.rows[0];
    const token = createSession(user.id);
    json(res, { token, user: { id: user.id, username: user.username, role: user.role, name: user.name } });
  },

  // Animals
  'GET:/animals': async (req, res) => {
    const user = await auth(req);
    if (!user) return json(res, { error: 'Unauthorized' }, 401);
    
    const { search, status, page = 1, limit = 50 } = new URL(req.url, 'http://localhost').searchParams;
    let query = 'SELECT * FROM animals';
    const params = [];
    const conditions = [];
    
    if (search) {
      conditions.push('(tag_number ILIKE $1 OR name ILIKE $1)');
      params.push(`%${search}%`);
    }
    if (status) {
      conditions.push(`status = $${params.length + 1}`);
      params.push(status);
    }
    
    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    
    query += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
    params.push(limit, (page - 1) * limit);
    
    const result = await pool.query(query, params);
    json(res, result.rows);
  },

  'POST:/animals': async (req, res) => {
    const user = await auth(req);
    if (!user) return json(res, { error: 'Unauthorized' }, 401);
    
    const data = await parseBody(req);
    
    // Avval quloq raqami mavjudligini tekshiramiz
    const existing = await pool.query('SELECT id, tag_number FROM animals WHERE tag_number = $1', [data.tag_number]);
    if (existing.rows.length > 0) {
      return json(res, { error: `"${data.tag_number}" quloq raqami allaqachon mavjud! Boshqa raqam kiriting.` }, 400);
    }
    
    const id = uuid();
    
    try {
      await pool.query(`
        INSERT INTO animals (id, tag_number, name, type, gender, status, births, daily_milk, birth_date, notes)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `, [id, data.tag_number, data.name, data.type, data.gender, data.status, 
          data.births || 0, data.daily_milk || 0, data.birth_date, data.notes]);
      
      const result = await pool.query('SELECT * FROM animals WHERE id = $1', [id]);
      json(res, result.rows[0]);
    } catch (error) {
      json(res, { error: 'Xatolik yuz berdi. Qayta urinib ko\'ring.' }, 400);
    }
  },

  'PUT:/animals/:id': async (req, res) => {
    const user = await auth(req);
    if (!user) return json(res, { error: 'Unauthorized' }, 401);
    
    const { id } = new URL(req.url, 'http://localhost').pathname.split('/');
    const data = await parseBody(req);
    
    // Avval quloq raqami boshqa hayvonda mavjudligini tekshiramiz
    const existing = await pool.query('SELECT id, tag_number FROM animals WHERE tag_number = $1 AND id != $2', [data.tag_number, id]);
    if (existing.rows.length > 0) {
      return json(res, { error: `"${data.tag_number}" quloq raqami allaqachon mavjud! Boshqa raqam kiriting.` }, 400);
    }
    
    try {
      await pool.query(`
        UPDATE animals SET tag_number = $1, name = $2, type = $3, gender = $4, status = $5,
        births = $6, daily_milk = $7, birth_date = $8, notes = $9
        WHERE id = $10
      `, [data.tag_number, data.name, data.type, data.gender, data.status,
          data.births || 0, data.daily_milk || 0, data.birth_date, data.notes, id]);
      
      const result = await pool.query('SELECT * FROM animals WHERE id = $1', [id]);
      json(res, result.rows[0]);
    } catch (error) {
      json(res, { error: 'Xatolik yuz berdi. Qayta urinib ko\'ring.' }, 400);
    }
  },

  'DELETE:/animals/:id': async (req, res) => {
    const user = await auth(req);
    if (!user) return json(res, { error: 'Unauthorized' }, 401);
    
    const { id } = new URL(req.url, 'http://localhost').pathname.split('/');
    await pool.query('DELETE FROM animals WHERE id = $1', [id]);
    json(res, { success: true });
  },

  // Milk records
  'GET:/milk': async (req, res) => {
    const user = await auth(req);
    if (!user) return json(res, { error: 'Unauthorized' }, 401);
    
    const { date, limit = 50 } = new URL(req.url, 'http://localhost').searchParams;
    let query = 'SELECT mr.*, a.tag_number, a.name FROM milk_records mr LEFT JOIN animals a ON mr.animal_id = a.id';
    const params = [];
    
    if (date) {
      query += ' WHERE mr.date = $1 ORDER BY mr.session';
      params.push(date);
    } else {
      query += ' ORDER BY mr.date DESC, mr.session LIMIT $1';
      params.push(limit);
    }
    
    const result = await pool.query(query, params);
    json(res, result.rows);
  },

  'POST:/milk': async (req, res) => {
    const user = await auth(req);
    if (!user) return json(res, { error: 'Unauthorized' }, 401);
    
    const data = await parseBody(req);
    const id = uuid();
    
    try {
      await pool.query(`
        INSERT INTO milk_records (id, animal_id, date, session, liters, notes)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [id, data.animal_id || null, data.date, data.session, data.liters, data.notes || null]);
      
      const result = await pool.query('SELECT * FROM milk_records WHERE id = $1', [id]);
      json(res, result.rows[0]);
    } catch (error) {
      json(res, { error: 'Xatolik yuz berdi. Qayta urinib ko\'ring.' }, 400);
    }
  },

  'DELETE:/milk/:id': async (req, res) => {
    const user = await auth(req);
    if (!user) return json(res, { error: 'Unauthorized' }, 401);
    
    const { id } = new URL(req.url, 'http://localhost').pathname.split('/');
    await pool.query('DELETE FROM milk_records WHERE id = $1', [id]);
    json(res, { success: true });
  },

  // Milk Sales
  'GET:/milk-sales': async (req, res) => {
    const user = await auth(req);
    if (!user) return json(res, { error: 'Unauthorized' }, 401);
    
    const { date, limit = 50 } = new URL(req.url, 'http://localhost').searchParams;
    let query = 'SELECT * FROM milk_sales';
    const params = [];
    
    if (date) {
      query += ' WHERE date = $1 ORDER BY created_at DESC';
      params.push(date);
    } else {
      query += ' ORDER BY date DESC, created_at DESC LIMIT $1';
      params.push(limit);
    }
    
    const result = await pool.query(query, params);
    json(res, result.rows);
  },

  'POST:/milk-sales': async (req, res) => {
    const user = await auth(req);
    if (!user) return json(res, { error: 'Unauthorized' }, 401);
    
    const data = await parseBody(req);
    const id = uuid();
    
    await pool.query(`
      INSERT INTO milk_sales (id, date, liters, price, total, buyer, phone, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [id, data.date, data.liters, data.price, data.total, data.buyer, data.phone, data.notes]);
    
    const result = await pool.query('SELECT * FROM milk_sales WHERE id = $1', [id]);
    json(res, result.rows[0]);
  },

  'DELETE:/milk-sales/:id': async (req, res) => {
    const user = await auth(req);
    if (!user) return json(res, { error: 'Unauthorized' }, 401);
    
    const { id } = new URL(req.url, 'http://localhost').pathname.split('/');
    await pool.query('DELETE FROM milk_sales WHERE id = $1', [id]);
    json(res, { success: true });
  },

  // Expenses
  'GET:/expenses': async (req, res) => {
    const user = await auth(req);
    if (!user) return json(res, { error: 'Unauthorized' }, 401);
    
    const { limit = 50 } = new URL(req.url, 'http://localhost').searchParams;
    const result = await pool.query('SELECT * FROM expenses ORDER BY date DESC LIMIT $1', [limit]);
    json(res, result.rows);
  },

  'POST:/expenses': async (req, res) => {
    const user = await auth(req);
    if (!user) return json(res, { error: 'Unauthorized' }, 401);
    
    const data = await parseBody(req);
    const id = uuid();
    
    await pool.query(`
      INSERT INTO expenses (id, category, amount, description, date)
      VALUES ($1, $2, $3, $4, $5)
    `, [id, data.category, data.amount, data.description, data.date]);
    
    const result = await pool.query('SELECT * FROM expenses WHERE id = $1', [id]);
    json(res, result.rows[0]);
  },

  'DELETE:/expenses/:id': async (req, res) => {
    const user = await auth(req);
    if (!user) return json(res, { error: 'Unauthorized' }, 401);
    
    const { id } = new URL(req.url, 'http://localhost').pathname.split('/');
    await pool.query('DELETE FROM expenses WHERE id = $1', [id]);
    json(res, { success: true });
  },

  // Users (Admin)
  'GET:/users': async (req, res) => {
    const user = await adminAuth(req);
    if (!user) return json(res, { error: 'Unauthorized' }, 401);
    
    const result = await pool.query('SELECT id, username, role, name, created_at FROM users ORDER BY created_at DESC');
    json(res, result.rows);
  },

  'POST:/users': async (req, res) => {
    const user = await adminAuth(req);
    if (!user) return json(res, { error: 'Unauthorized' }, 401);
    
    const data = await parseBody(req);
    const id = uuid();
    
    try {
      await pool.query(`
        INSERT INTO users (id, username, password, role, name)
        VALUES ($1, $2, $3, $4, $5)
      `, [id, data.username, hashPassword(data.password), data.role, data.name]);
      
      const result = await pool.query('SELECT id, username, role, name, created_at FROM users WHERE id = $1', [id]);
      json(res, result.rows[0]);
    } catch (error) {
      json(res, { error: 'Username allaqachon mavjud' }, 400);
    }
  },

  'DELETE:/users/:id': async (req, res) => {
    const user = await adminAuth(req);
    if (!user) return json(res, { error: 'Unauthorized' }, 401);
    
    const { id } = new URL(req.url, 'http://localhost').pathname.split('/');
    await pool.query('DELETE FROM users WHERE id = $1', [id]);
    json(res, { success: true });
  },

  // Finance stats
  'GET:/finance': async (req, res) => {
    const user = await auth(req);
    if (!user) return json(res, { error: 'Unauthorized' }, 401);
    
    const { period = 'day' } = new URL(req.url, 'http://localhost').searchParams;
    let dateCondition = '';
    
    switch (period) {
      case 'day': dateCondition = "AND date = CURRENT_DATE"; break;
      case 'week': dateCondition = "AND date >= CURRENT_DATE - INTERVAL '7 days'"; break;
      case 'month': dateCondition = "AND date >= CURRENT_DATE - INTERVAL '30 days'"; break;
      case 'year': dateCondition = "AND date >= CURRENT_DATE - INTERVAL '365 days'"; break;
    }
    
    const [milkSalesResult, expenseResult] = await Promise.all([
      pool.query(`SELECT COALESCE(SUM(total), 0) as total FROM milk_sales WHERE 1=1 ${dateCondition}`),
      pool.query(`SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE 1=1 ${dateCondition}`)
    ]);
    
    json(res, {
      income: parseFloat(milkSalesResult.rows[0].total),
      expenses: parseFloat(expenseResult.rows[0].total),
      profit: parseFloat(milkSalesResult.rows[0].total) - parseFloat(expenseResult.rows[0].total)
    });
  },

  // Dashboard stats
  'GET:/dashboard': async (req, res) => {
    const user = await auth(req);
    if (!user) return json(res, { error: 'Unauthorized' }, 401);
    
    const [animalCount, milkToday, milk7Days, expenseToday] = await Promise.all([
      pool.query('SELECT COUNT(*) as count FROM animals WHERE status != $1', ['sotildi']),
      pool.query('SELECT COALESCE(SUM(liters), 0) as total FROM milk_records WHERE date = CURRENT_DATE'),
      pool.query(`
        SELECT date, SUM(liters) as liters 
        FROM milk_records 
        WHERE date >= CURRENT_DATE - INTERVAL '7 days' 
        GROUP BY date 
        ORDER BY date
      `),
      pool.query('SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE date = CURRENT_DATE')
    ]);
    
    json(res, {
      animalCount: parseInt(animalCount.rows[0].count),
      milkToday: parseFloat(milkToday.rows[0].total),
      milk7Days: milk7Days.rows.map(r => ({ date: r.date, liters: parseFloat(r.liters) })),
      expenseToday: parseFloat(expenseToday.rows[0].total)
    });
  }
};

// Server
const server = http.createServer(async (req, res) => {
  const method = req.method;
  const url = req.url;
  const pathname = new URL(url, 'http://localhost').pathname;
  
  // Handle CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, x-session-token',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
    });
    return res.end();
  }
  
  // API routes
  if (pathname.startsWith('/api/')) {
    const apiPath = pathname.replace('/api', '');
    const routeKey = `${method}:${apiPath}`;
    
    if (routes[routeKey]) {
      try {
        await routes[routeKey](req, res);
      } catch (error) {
        console.error('API Error:', error);
        json(res, { error: 'Server error' }, 500);
      }
    } else {
      json(res, { error: 'Route not found' }, 404);
    }
    return;
  }
  
  // Static files
  if (pathname === '/') {
    serveStatic(res, path.join(PUBLIC_DIR, 'index.html'));
  } else {
    const filePath = path.join(PUBLIC_DIR, pathname);
    serveStatic(res, filePath);
  }
});

// Start server
initDB().then(() => {
  server.listen(PORT, () => {
    console.log(`FermaApp server running on port ${PORT}`);
    console.log(`Database: PostgreSQL`);
  });
}).catch(error => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
