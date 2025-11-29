# Aurora Backend - Task Notification Server

This directory contains the backend notification server deployed to Railway.

## Current Deployment
- **URL**: https://web-production-57e1c.up.railway.app
- **GitHub Repo**: https://github.com/lebron1212/aurora-backend
- **Status**: ✅ Live and operational

## What it does
- Receives task data from Aurora frontend
- Sends Apple Push Notifications for task reminders  
- Checks for due tasks every minute
- Manages device token registration
- Supports multiple reminder types (once, daily, weekly, monthly)

## Files
- `task-notification-server.js` - Main server application
- `package.json` - Node.js dependencies and scripts
- `Procfile` - Railway deployment configuration
- `railway.json` - Railway build settings
- `credentials/AuthKey_2DQAFKB7G2.p8` - APN authentication key

## Environment Variables (on Railway)
- `APN_KEY_BASE64` - Base64 encoded APN authentication key
- `NODE_ENV=production` - Environment setting

## Local Development
```bash
cd backend
npm install
npm start
```

## Deployment
The backend is automatically deployed via GitHub integration with Railway.
Any changes to https://github.com/lebron1212/aurora-backend will trigger redeployment.

## API Endpoints
- `GET /health` - Server status and registered devices
- `POST /register-device` - Register device token
- `POST /send-test` - Send test notification
- `POST /sync-tasks` - Sync tasks for notifications