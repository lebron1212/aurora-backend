# Horizon v2 Railway Deployment Guide

## Prerequisites

1. **Supabase Setup** (follow setup-supabase.md first)
2. **Railway Account** with existing aurora-notification-server project
3. **Environment Variables** configured in Railway

## Required Environment Variables

Add these to your Railway project environment:

```bash
# Supabase Configuration
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_ANON_KEY=your_anon_key_here
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key_here

# OpenAI (optional - for enhanced CRS processing)
OPENAI_API_KEY=your_openai_key_here

# APN Configuration (existing)
APN_KEY_BASE64=your_existing_apn_key
```

## Deployment Steps

### 1. Install Dependencies

```bash
cd backend-deployment
npm install
```

### 2. Test Locally (Optional)

```bash
# Set environment variables locally
export SUPABASE_URL="https://YOUR_PROJECT_REF.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="your_service_role_key"

# Run locally
npm start
```

Verify endpoints:
- `GET http://localhost:3001/health` - Should return server status
- `GET http://localhost:3001/system/status` - Should return CRS status
- `POST http://localhost:3001/system/process` - Should trigger manual CRS processing

### 3. Deploy to Railway

```bash
# Commit changes
git add .
git commit -m "Add Horizon v2 CRS service with Supabase integration"

# Push to Railway (if connected to GitHub)
git push origin main
```

Or deploy via Railway CLI:
```bash
railway login
railway link
railway up
```

### 4. Verify Deployment

After deployment, test these endpoints on your Railway domain:

```bash
# Replace with your actual Railway domain
RAILWAY_URL="https://aurora-notification-server-production.up.railway.app"

# Health check
curl "$RAILWAY_URL/health"

# CRS status
curl "$RAILWAY_URL/system/status"

# System export (should work after first journal sync)
curl "$RAILWAY_URL/system/export"
```

## Client Configuration

### Web/Browser Clients

Add to your environment configuration:

```typescript
// In your .env or config
VITE_RAILWAY_API_URL=https://aurora-notification-server-production.up.railway.app
```

### Mobile Clients (iOS/Capacitor)

The mobile clients will continue using iCloud via AuroraFiles plugin. No changes needed.

### Electron Clients 

Electron clients will continue using local filesystem. No changes needed.

## Testing the Full Pipeline

### 1. Sync Journals
```bash
curl -X POST "$RAILWAY_URL/sync-journals" \
  -H "Content-Type: application/json" \
  -d '{
    "journals": [{"content": "Test journal entry", "id": "test1"}],
    "date": "2025-12-01"
  }'
```

### 2. Trigger CRS Processing
```bash
curl -X POST "$RAILWAY_URL/system/process"
```

### 3. Check System Export
```bash
curl "$RAILWAY_URL/system/export"
```

### 4. Check Manifest
```bash
curl "$RAILWAY_URL/system/manifest"
```

## Monitoring

### Logs
```bash
railway logs
```

### CRS Processing Status
```bash
curl "$RAILWAY_URL/system/status"
```

### Supabase Storage
Check your Supabase dashboard > Storage > horizon-files bucket for:
- `system/entities/`
- `system/facts/`
- `system/updates/latest.json`

## Troubleshooting

### "Supabase configuration missing" error
- Verify SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set in Railway environment
- Check Supabase project is active and bucket exists

### "CRS processing failed" error  
- Check Railway logs for detailed error messages
- Verify OpenAI API key if using enhanced processing
- Ensure sufficient Railway memory allocation

### "No manifest found" error
- Trigger manual CRS processing: `POST /system/process`
- Check Supabase storage for `system/updates/latest.json`
- Verify journals have been synced: `POST /sync-journals`

### Client can't connect to Railway
- Verify VITE_RAILWAY_API_URL is set correctly
- Check CORS is enabled (already configured)
- Test Railway domain directly in browser

## What's Next

After successful deployment:

1. **Sync Historical Data**: Use `/sync-journals` and `/initialize-week` to backfill journal data
2. **Enable Client Integration**: Configure clients to use the new Railway backend
3. **Monitor Processing**: Watch `/system/status` and Railway logs for CRS processing
4. **Test RTCS Updates**: Verify clients receive incremental updates via manifest system

## Architecture Summary

```
📱 Aurora Client (iOS/Electron/Web)
    ↓ Journal sync, System reads
🌐 Railway Backend 
    ├── 📁 Supabase Storage (shared horizon-files bucket)
    ├── 🔄 CRS Nightly Processing (2am cron)
    └── 📡 System APIs (/system/*)
    
🔄 Flow:
1. Clients sync journals → Railway
2. Railway CRS processes at 2am → Supabase
3. Clients check manifest → get updates from Supabase
4. RTCS reloads updated stores
```

Your Horizon v2 system is now **production-ready** with:
- ✅ Remote CRS processing (no app needed at 2am)
- ✅ Shared storage via Supabase  
- ✅ Cross-device memory sync
- ✅ Scalable Railway infrastructure