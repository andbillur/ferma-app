# FermaApp Deployment Guide

## Render.com Deployment

### 1. Preparation
- Ensure you have a Render.com account
- Have your code in a GitHub repository

### 2. Database Setup
1. In Render dashboard, create a new PostgreSQL database
2. Note the database connection string
3. Set the `DATABASE_URL` environment variable

### 3. Web Service Setup
1. Create a new Web Service
2. Connect your GitHub repository
3. Use the following settings:
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Environment Variables**:
     - `NODE_ENV`: `production`
     - `PORT`: `10000`
     - `DATABASE_URL`: (your PostgreSQL connection string)

### 4. Environment Variables
Required environment variables:
```
NODE_ENV=production
PORT=10000
DATABASE_URL=postgresql://user:password@host:port/database
```

### 5. Automatic Deployment
- Push changes to your GitHub repository
- Render will automatically build and deploy your application
- The database will be automatically initialized on first run

### 6. Access
- Your app will be available at: `https://your-app-name.onrender.com`
- Default login: `admin` / `admin123`

## Local Development with PostgreSQL

### 1. Install PostgreSQL
```bash
# On Ubuntu/Debian
sudo apt-get install postgresql postgresql-contrib

# On macOS with Homebrew
brew install postgresql

# On Windows
# Download and install from postgresql.org
```

### 2. Create Database
```bash
sudo -u postgres createdb ferma_app
```

### 3. Set Environment Variables
```bash
export DATABASE_URL="postgresql://postgres:password@localhost:5432/ferma_app"
```

### 4. Install Dependencies and Run
```bash
npm install
node server.js
```

## Features Implemented

1. **Enhanced Navigation**: Beautiful, larger navbar with improved styling
2. **Today's Milk Display**: Shows total milk added today in the milk section
3. **Extended Animal Gender Options**:
   - Female (Urg'ochi)
   - Male (Erkak) 
   - Calf Male (Bozak erkak)
   - Pregnant Female (Bog'oz urg'ochi)
4. **Pregnancy Status**: Added "Bog'oz (homilador)" as an animal status
5. **PostgreSQL Database**: Full database migration from JSON to PostgreSQL
6. **Render.com Ready**: Complete deployment configuration

## Database Schema

The application uses the following tables:
- `users` - User authentication and roles
- `animals` - Animal records with extended gender/status options
- `milk_records` - Daily milk collection records
- `expenses` - Financial expense tracking
- `animal_sales` - Animal sales records
