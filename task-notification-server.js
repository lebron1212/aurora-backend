/**
 * Task Notification Server
 * Backend service to send push notifications for task reminders
 * Runs as a separate process to check tasks and send APNs
 */

import apn from 'apn';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// APN Configuration
let apnConfig;
if (process.env.APN_KEY_BASE64) {
  // Production: Use base64 encoded key from environment
  const keyBuffer = Buffer.from(process.env.APN_KEY_BASE64, 'base64');
  apnConfig = {
    token: {
      key: keyBuffer,
      keyId: '2DQAFKB7G2',
      teamId: '2WCJ9MTW74'
    },
    production: false
  };
} else {
  // Development: Use local file
  apnConfig = {
    token: {
      key: path.join(__dirname, 'credentials', 'AuthKey_2DQAFKB7G2.p8'),
      keyId: '2DQAFKB7G2',
      teamId: '2WCJ9MTW74'
    },
    production: false
  };
}

const apnProvider = new apn.Provider(apnConfig);

// Store device tokens (in production, use a database)
const DEVICE_TOKENS_FILE = path.join(__dirname, 'device-tokens.json');
const TASKS_FILE = path.join(__dirname, 'tasks.json'); // Store in backend dir for cloud
const REMINDERS_FILE = path.join(__dirname, 'reminders.json'); // Store scheduled reminders

class TaskNotificationServer {
  constructor() {
    this.deviceTokens = this.loadDeviceTokens();
    this.reminders = this.loadReminders();
    this.checkInterval = null;
    this.reminderInterval = null;
    this.POLL_INTERVAL = 60000; // Check every minute
  }

  loadDeviceTokens() {
    try {
      if (fs.existsSync(DEVICE_TOKENS_FILE)) {
        const data = fs.readFileSync(DEVICE_TOKENS_FILE, 'utf8');
        return JSON.parse(data);
      }
    } catch (error) {
      console.error('Failed to load device tokens:', error);
    }
    return [];
  }

  saveDeviceToken(token, userId = 'default') {
    if (!this.deviceTokens.find(t => t.token === token)) {
      this.deviceTokens.push({
        token,
        userId,
        registeredAt: Date.now()
      });
      
      fs.writeFileSync(
        DEVICE_TOKENS_FILE,
        JSON.stringify(this.deviceTokens, null, 2)
      );
      
      console.log(`📱 Registered device token for user ${userId}`);
    }
  }

  loadTasks() {
    try {
      if (fs.existsSync(TASKS_FILE)) {
        const data = fs.readFileSync(TASKS_FILE, 'utf8');
        return JSON.parse(data);
      }
    } catch (error) {
      console.error('Failed to load tasks:', error);
    }
    return [];
  }

  saveTasks(tasks) {
    fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
  }

  loadReminders() {
    try {
      if (fs.existsSync(REMINDERS_FILE)) {
        return JSON.parse(fs.readFileSync(REMINDERS_FILE, 'utf8'));
      }
    } catch (error) {
      console.error('Error loading reminders:', error);
    }
    return [];
  }

  saveReminders(reminders) {
    fs.writeFileSync(REMINDERS_FILE, JSON.stringify(reminders, null, 2));
  }

  start() {
    console.log('🚀 Task Notification Server started');
    console.log('⛔ TASK CHECKING PERMANENTLY DISABLED - NOTIFICATIONS ONLY');
    console.log('⏰ REMINDER CHECKING ENABLED - Every minute');
    
    // DO NOT CHECK TASKS - ONLY PROVIDE API ENDPOINTS
    // this.checkAndSendReminders();
    // this.checkInterval = setInterval(() => {
    //   this.checkAndSendReminders();
    // }, this.POLL_INTERVAL);
    
    // Start checking for scheduled reminders
    this.checkScheduledReminders();
    this.reminderInterval = setInterval(() => {
      this.checkScheduledReminders();
    }, 60000); // Check every minute
  }

  stop() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }
    if (this.reminderInterval) {
      clearInterval(this.reminderInterval);
    }
    console.log('🛑 Task Notification Server stopped');
  }

  async checkScheduledReminders() {
    const reminders = this.loadReminders();
    const now = Date.now();
    const pendingReminders = [];
    
    for (const reminder of reminders) {
      if (reminder.scheduledFor <= now && !reminder.sent) {
        console.log(`🔔 Sending scheduled reminder: "${reminder.title}"`);
        
        const notification = new apn.Notification();
        notification.alert = { title: reminder.title, body: reminder.body };
        notification.sound = reminder.sound || 'default';
        notification.badge = 1;
        notification.topic = 'com.aurora.es.app';
        notification.payload = reminder.payload || {};
        
        try {
          for (const device of this.deviceTokens) {
            await apnProvider.send(notification, device.token);
          }
          reminder.sent = true;
          reminder.sentAt = now;
        } catch (error) {
          console.error('Error sending reminder:', error);
        }
      }
      
      // Keep reminders that are still pending or were sent in the last 24 hours (for history)
      if (!reminder.sent || (now - reminder.sentAt < 24 * 60 * 60 * 1000)) {
        pendingReminders.push(reminder);
      }
    }
    
    if (pendingReminders.length !== reminders.length) {
      this.saveReminders(pendingReminders);
    }
  }

  async checkAndSendReminders() {
    const tasks = this.loadTasks();
    const now = Date.now();
    
    console.log(`⏰ Checking ${tasks.length} total tasks...`);
    
    // NUCLEAR SPAM PREVENTION: Global notification cooldown per title
    if (!this.notificationCooldowns) {
      this.notificationCooldowns = new Map();
    }
    
    // Find tasks that need reminders (check ALL tasks, not deduplicated)
    const tasksToRemind = tasks.filter(task => {
      return (
        task.reminderEnabled &&
        task.reminderTime &&
        task.reminderTime <= now &&
        task.status === 'pending' &&
        (!task.snoozeUntil || task.snoozeUntil <= now)
      );
    });

    // Deduplicate reminder tasks by title
    const reminderTitles = new Set();
    const uniqueReminders = tasksToRemind.filter(task => {
      if (reminderTitles.has(task.title)) {
        return false;
      }
      reminderTitles.add(task.title);
      return true;
    });

    console.log(`⏰ Found ${uniqueReminders.length} unique reminder tasks (from ${tasksToRemind.length} total)`);

    for (const task of uniqueReminders) {
      // Check global cooldown
      const lastGlobalNotification = this.notificationCooldowns.get(task.title) || 0;
      const fiveMinutesAgo = now - (5 * 60 * 1000); // 5-minute global cooldown
      
      if (lastGlobalNotification > fiveMinutesAgo) {
        console.log(`🚫 BLOCKED: "${task.title}" is in global cooldown (last sent: ${lastGlobalNotification})`);
        continue;
      }
      
      await this.sendTaskNotification(task);
      this.notificationCooldowns.set(task.title, now);
      
      // Update ALL matching tasks in the full list
      tasks.forEach(t => {
        if (t.title === task.title) {
          if (task.reminderType === 'once') {
            t.reminderEnabled = false;
          } else {
            t.reminderTime = this.calculateNextReminderTime(task);
          }
        }
      });
    }

    // Check for overdue tasks - but check BOTH file and global cooldown
    const overdueTasks = tasks.filter(task => {
      return (
        task.dueDate &&
        task.dueDate < now &&
        task.status !== 'completed' &&
        task.status !== 'cancelled'
      );
    });

    console.log(`⚠️ Found ${overdueTasks.length} total overdue tasks`);

    // Group by title and check notification status
    const overdueGroups = new Map();
    overdueTasks.forEach(task => {
      if (!overdueGroups.has(task.title)) {
        overdueGroups.set(task.title, []);
      }
      overdueGroups.get(task.title).push(task);
    });

    console.log(`⚠️ Found ${overdueGroups.size} unique overdue task groups`);

    for (const [title, taskGroup] of overdueGroups) {
      // Check GLOBAL cooldown first (nuclear spam prevention)
      const lastGlobalNotification = this.notificationCooldowns.get(title) || 0;
      const oneHourAgo = now - (1 * 60 * 60 * 1000); // 1-hour global cooldown for overdue
      
      if (lastGlobalNotification > oneHourAgo) {
        console.log(`🚫 GLOBAL BLOCK: "${title}" sent ${Math.round((now - lastGlobalNotification) / 60000)} minutes ago`);
        continue;
      }
      
      // Use the first task to check file notification status
      const representativeTask = taskGroup[0];
      const lastNotified = representativeTask.lastOverdueNotification || 0;
      const oneDayAgo = now - (24 * 60 * 60 * 1000);
      
      if (lastNotified < oneDayAgo) {
        console.log(`📤 Sending overdue notification for "${title}" (file: ${lastNotified}, global: ${lastGlobalNotification})`);
        await this.sendOverdueNotification(representativeTask);
        
        // Update BOTH file and global tracking
        this.notificationCooldowns.set(title, now);
        tasks.forEach(t => {
          if (t.title === title) {
            t.lastOverdueNotification = now;
          }
        });
        
        console.log(`📝 Updated BOTH file and global tracking for "${title}"`);
      } else {
        console.log(`⏳ File block: "${title}" - last file notification: ${lastNotified}`);
      }
    }

    // Save updated tasks
    this.saveTasks(tasks);
  }

  async sendTaskNotification(task) {
    const notification = new apn.Notification();
    
    // Use custom title/body if provided, otherwise default to task-based
    const title = task.notificationTitle || `📋 ${task.title}`;
    let body = task.notificationBody || task.description || 'Reminder';
    
    // Only add due date info if no custom body is provided
    if (!task.notificationBody && task.dueDate) {
      const dueDate = new Date(task.dueDate);
      const now = new Date();
      const hoursUntilDue = Math.round((dueDate - now) / (1000 * 60 * 60));
      
      if (hoursUntilDue > 0) {
        body = `${task.description || 'Task'} - Due in ${hoursUntilDue} hour${hoursUntilDue > 1 ? 's' : ''}`;
      } else {
        body = `${task.description || 'Task'} - Due now!`;
      }
    }
    
    notification.alert = { title, body };
    
    notification.sound = 'default';
    notification.badge = 1;
    notification.topic = 'com.aurora.es.app';
    notification.payload = {
      taskId: task.id,
      type: 'task_reminder'
    };

    // Send to all registered devices
    for (const deviceInfo of this.deviceTokens) {
      try {
        const result = await apnProvider.send(notification, deviceInfo.token);
        if (result.failed.length > 0) {
          console.error(`❌ Failed to send to ${deviceInfo.token}:`, result.failed[0].response);
        } else {
          console.log(`✅ Sent reminder for "${task.title}" to device ${deviceInfo.token.substring(0, 10)}...`);
        }
      } catch (error) {
        console.error('Error sending notification:', error);
      }
    }
  }

  async sendOverdueNotification(task) {
    const notification = new apn.Notification();
    
    // Use custom overdue title/body if provided
    let title = task.overdueNotificationTitle || `⚠️ Overdue: ${task.title}`;
    let body = task.overdueNotificationBody || task.description || 'This is overdue';
    
    // Only add overdue calculation if no custom body is provided
    if (!task.overdueNotificationBody && task.dueDate) {
      const dueDate = new Date(task.dueDate);
      const now = new Date();
      // Fix: Use Math.ceil and handle timezone properly
      const daysOverdue = Math.ceil((now.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24));
      
      if (daysOverdue === 1) {
        body = `${task.description || 'Task'} - 1 day overdue`;
      } else {
        body = `${task.description || 'Task'} - ${daysOverdue} days overdue`;
      }
    }
    
    notification.alert = { title, body };
    
    notification.sound = 'default';
    notification.badge = 1;
    notification.topic = 'com.aurora.es.app';
    notification.payload = {
      taskId: task.id,
      type: 'task_overdue'
    };
    notification.priority = 10; // High priority for overdue

    // Send to all registered devices
    for (const deviceInfo of this.deviceTokens) {
      try {
        const result = await apnProvider.send(notification, deviceInfo.token);
        if (result.failed.length === 0) {
          console.log(`⚠️ Sent overdue notification for "${task.title}"`);
        }
      } catch (error) {
        console.error('Error sending overdue notification:', error);
      }
    }
  }

  calculateNextReminderTime(task) {
    const now = Date.now();
    
    switch (task.reminderType) {
      case 'daily':
        return now + (24 * 60 * 60 * 1000);
      case 'weekly':
        return now + (7 * 24 * 60 * 60 * 1000);
      case 'monthly':
        return now + (30 * 24 * 60 * 60 * 1000);
      default:
        return now + (24 * 60 * 60 * 1000);
    }
  }

  // API endpoint to register device tokens
  registerDevice(token, userId = 'default') {
    this.saveDeviceToken(token, userId);
  }

  // API endpoint to send immediate notification
  async sendImmediateNotification(title, body, deviceToken = null) {
    const notification = new apn.Notification();
    notification.alert = { title, body };
    notification.sound = 'default';
    notification.topic = 'com.aurora.es.app';

    const tokens = deviceToken ? [deviceToken] : this.deviceTokens.map(d => d.token);
    
    for (const token of tokens) {
      try {
        await apnProvider.send(notification, token);
        console.log(`📤 Sent immediate notification: "${title}"`);
      } catch (error) {
        console.error('Error sending immediate notification:', error);
      }
    }
  }
}

// Create Express server for HTTP API
import express from 'express';
import cors from 'cors';
import HorizonCRSService from './horizon-crs-service.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Enable trust proxy for Railway
app.set('trust proxy', 1);

app.use(cors());
app.use(express.json());

// Create notification server instance
const server = new TaskNotificationServer();

// Create and initialize Horizon CRS service
const horizonCRS = new HorizonCRSService();
await horizonCRS.initialize();
console.log('🧠 [HORIZON CRS] Service initialized');

// Get manual trigger functions
const { trigger: manualTrigger, status: crsStatus } = horizonCRS.setupManualTrigger();

// ============================================================================
// HORIZON V2 SYSTEM ENDPOINTS
// ============================================================================

// Full system export for client sync
app.get('/system/export', async (req, res) => {
  try {
    console.log('📤 [SYSTEM] Exporting full system data...');
    const systemExport = await horizonCRS.getSystemExport();
    res.json(systemExport);
  } catch (error) {
    console.error('❌ [SYSTEM] Export failed:', error);
    res.status(500).json({ error: 'Failed to export system data' });
  }
});

// Single file from system
app.get('/system/file/*', async (req, res) => {
  try {
    const filePath = req.params[0]; // Everything after /system/file/
    console.log(`📁 [SYSTEM] Requesting file: ${filePath}`);
    
    const fileData = await horizonCRS.getSystemFile(filePath);
    if (!fileData) {
      return res.status(404).json({ error: 'File not found' });
    }
    
    res.json(fileData);
  } catch (error) {
    console.error(`❌ [SYSTEM] Failed to get file ${req.params[0]}:`, error);
    res.status(500).json({ error: 'Failed to read system file' });
  }
});

// Current manifest only
app.get('/system/manifest', async (req, res) => {
  try {
    console.log('📋 [SYSTEM] Requesting update manifest...');
    const manifest = await horizonCRS.getSystemManifest();
    if (!manifest) {
      return res.status(404).json({ error: 'No manifest found' });
    }
    
    res.json(manifest);
  } catch (error) {
    console.error('❌ [SYSTEM] Failed to get manifest:', error);
    res.status(500).json({ error: 'Failed to read manifest' });
  }
});

// Manual CRS processing trigger (for testing)
app.post('/system/process', async (req, res) => {
  try {
    console.log('🔧 [SYSTEM] Manual CRS processing triggered...');
    const status = crsStatus();
    
    if (status.isProcessing) {
      return res.json({ 
        success: false, 
        message: 'CRS processing already in progress',
        status 
      });
    }
    
    // Trigger processing in background
    manualTrigger().catch(error => {
      console.error('❌ [SYSTEM] Background processing failed:', error);
    });
    
    res.json({ 
      success: true, 
      message: 'CRS processing started',
      status 
    });
  } catch (error) {
    console.error('❌ [SYSTEM] Failed to trigger processing:', error);
    res.status(500).json({ error: 'Failed to trigger CRS processing' });
  }
});

// CRS status check
app.get('/system/status', (req, res) => {
  try {
    const status = crsStatus();
    res.json(status);
  } catch (error) {
    console.error('❌ [SYSTEM] Failed to get status:', error);
    res.status(500).json({ error: 'Failed to get CRS status' });
  }
});

// Write file to system (for web client)
app.post('/system/write', async (req, res) => {
  try {
    const { path, data } = req.body;
    if (!path) {
      return res.status(400).json({ error: 'Path is required' });
    }
    
    console.log(`✏️ [SYSTEM] Writing file: ${path}`);
    await horizonCRS.writeFile(path, data);
    
    res.json({ success: true, message: 'File written successfully' });
  } catch (error) {
    console.error(`❌ [SYSTEM] Failed to write file:`, error);
    res.status(500).json({ error: 'Failed to write file' });
  }
});

// Delete file from system (for web client)
app.delete('/system/delete', async (req, res) => {
  try {
    const { path } = req.body;
    if (!path) {
      return res.status(400).json({ error: 'Path is required' });
    }
    
    console.log(`🗑️ [SYSTEM] Deleting file: ${path}`);
    await horizonCRS.deleteFile(path);
    
    res.json({ success: true, message: 'File deleted successfully' });
  } catch (error) {
    console.error(`❌ [SYSTEM] Failed to delete file:`, error);
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

// List files in directory (for web client)
app.post('/system/list', async (req, res) => {
  try {
    const { path } = req.body;
    console.log(`📋 [SYSTEM] Listing files in: ${path || 'root'}`);
    
    const files = await horizonCRS.listFiles(path || '');
    
    res.json({ files: files.map(f => f.name).filter(Boolean) });
  } catch (error) {
    console.error(`❌ [SYSTEM] Failed to list files:`, error);
    res.status(500).json({ error: 'Failed to list files' });
  }
});

// ============================================================================
// EXISTING NOTIFICATION ENDPOINTS
// ============================================================================

// HTTP Endpoints
app.post('/register-device', (req, res) => {
  const { token, userId, platform } = req.body;
  
  if (!token) {
    return res.status(400).json({ error: 'Device token required' });
  }
  
  server.registerDevice(token, userId);
  res.json({ success: true, message: 'Device registered' });
});

app.post('/send-test', async (req, res) => {
  const { token, title, body } = req.body;
  
  if (!title || !body) {
    return res.status(400).json({ error: 'Title and body required' });
  }
  
  await server.sendImmediateNotification(title, body, token);
  res.json({ success: true, message: 'Test notification sent' });
});

app.post('/sync-tasks', (req, res) => {
  const { userId, tasks } = req.body;
  
  // Save tasks to file for the notification server to check
  if (tasks) {
    server.saveTasks(tasks);
  }
  
  res.json({ success: true, message: 'Tasks synced' });
});

// Generic notification endpoint for any type of notification
app.post('/send-notification', async (req, res) => {
  const { title, body, sound = 'default', badge = 1, payload = {}, deviceToken = null } = req.body;
  
  if (!title || !body) {
    return res.status(400).json({ error: 'Title and body required' });
  }
  
  const notification = new apn.Notification();
  notification.alert = { title, body };
  notification.sound = sound;
  notification.badge = badge;
  notification.topic = 'com.aurora.es.app';
  notification.payload = payload;

  const tokens = deviceToken ? [deviceToken] : server.deviceTokens.map(d => d.token);
  
  try {
    for (const token of tokens) {
      await apnProvider.send(notification, token);
    }
    console.log(`📤 Sent custom notification: "${title}"`);
    res.json({ success: true, message: 'Notification sent' });
  } catch (error) {
    console.error('Error sending custom notification:', error);
    res.status(500).json({ error: 'Failed to send notification' });
  }
});

// Schedule a reminder for a future time
app.post('/schedule-reminder', (req, res) => {
  const { title, body, scheduledFor, sound = 'default', payload = {} } = req.body;
  
  if (!title || !body || !scheduledFor) {
    return res.status(400).json({ error: 'Title, body, and scheduledFor timestamp required' });
  }
  
  const reminder = {
    id: Date.now() + '-' + Math.random().toString(36).substr(2, 9),
    title,
    body,
    scheduledFor: typeof scheduledFor === 'string' ? new Date(scheduledFor).getTime() : scheduledFor,
    sound,
    payload,
    createdAt: Date.now(),
    sent: false
  };
  
  const reminders = server.loadReminders();
  reminders.push(reminder);
  server.saveReminders(reminders);
  
  const scheduledDate = new Date(reminder.scheduledFor);
  console.log(`📅 Scheduled reminder "${title}" for ${scheduledDate.toISOString()}`);
  
  res.json({ 
    success: true, 
    message: `Reminder scheduled for ${scheduledDate.toLocaleString()}`,
    reminder 
  });
});

// Cancel a scheduled reminder
app.post('/cancel-reminder', (req, res) => {
  const { reminderId } = req.body;
  
  if (!reminderId) {
    return res.status(400).json({ error: 'Reminder ID required' });
  }
  
  const reminders = server.loadReminders();
  const filteredReminders = reminders.filter(r => r.id !== reminderId);
  
  if (filteredReminders.length === reminders.length) {
    return res.status(404).json({ error: 'Reminder not found' });
  }
  
  server.saveReminders(filteredReminders);
  console.log(`❌ Cancelled reminder ${reminderId}`);
  
  res.json({ success: true, message: 'Reminder cancelled' });
});

// Get all scheduled reminders
app.get('/reminders', (req, res) => {
  const reminders = server.loadReminders();
  const now = Date.now();
  
  const active = reminders.filter(r => !r.sent && r.scheduledFor > now);
  const pending = reminders.filter(r => !r.sent && r.scheduledFor <= now);
  const sent = reminders.filter(r => r.sent);
  
  res.json({ 
    active: active.sort((a, b) => a.scheduledFor - b.scheduledFor),
    pending,
    sent: sent.slice(-10) // Last 10 sent reminders
  });
});

// Send AI message as push notification
app.post('/ai-notification', async (req, res) => {
  const { title, message, type = 'ai_message', priority = 3 } = req.body;
  
  if (!title || !message) {
    return res.status(400).json({ error: 'Title and message required' });
  }
  
  // Determine notification properties based on type
  let sound = 'default';
  let badge = 1;
  
  // High priority messages get different sound
  if (priority <= 2) {
    sound = 'alert';
  }
  
  const notification = new apn.Notification();
  notification.alert = { title, body: message };
  notification.sound = sound;
  notification.badge = badge;
  notification.topic = 'com.aurora.es.app';
  notification.payload = { 
    type,
    priority,
    timestamp: Date.now()
  };
  
  try {
    for (const device of server.deviceTokens) {
      await apnProvider.send(notification, device.token);
    }
    console.log(`🤖 [AI] Sent ${type} notification: "${title}"`);
    res.json({ 
      success: true, 
      message: 'AI notification sent',
      deviceCount: server.deviceTokens.length 
    });
  } catch (error) {
    console.error('Error sending AI notification:', error);
    res.status(500).json({ error: 'Failed to send AI notification' });
  }
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    deviceCount: server.deviceTokens.length,
    uptime: process.uptime(),
    registeredTokens: server.deviceTokens.map(t => ({
      userId: t.userId,
      token: t.token.substring(0, 10) + '...',
      registeredAt: new Date(t.registeredAt).toISOString()
    }))
  });
});

// Debug endpoint to manually add test token
app.post('/debug-register', (req, res) => {
  const testToken = 'AA2B1A111CA14C6DCA9CF9F0916820CA31067143D5148E7C0E260CFBD3839CBC';
  server.registerDevice(testToken, 'debug-user');
  res.json({ success: true, message: 'Debug token registered', token: testToken });
});

// Cleanup endpoint to remove duplicate marriage tasks
app.post('/cleanup-duplicates', (req, res) => {
  const tasks = server.loadTasks();
  const before = tasks.length;
  
  // Remove all marriage-related duplicates, keep only one
  const marriageKeywords = ['marry', 'stella', 'donati', 'marriage', 'notification:', 'notify', 'reminder'];
  const marriageTasks = tasks.filter(task => {
    const title = task.title.toLowerCase();
    return marriageKeywords.some(keyword => title.includes(keyword));
  });
  
  const nonMarriageTasks = tasks.filter(task => {
    const title = task.title.toLowerCase();
    return !marriageKeywords.some(keyword => title.includes(keyword));
  });
  
  // Keep only the first marriage task
  const cleanMarriageTasks = marriageTasks.length > 0 ? [marriageTasks[0]] : [];
  
  const cleanedTasks = [...nonMarriageTasks, ...cleanMarriageTasks];
  server.saveTasks(cleanedTasks);
  
  const after = cleanedTasks.length;
  const removed = before - after;
  
  console.log(`🧹 Cleanup: Removed ${removed} duplicate tasks (${before} → ${after})`);
  
  res.json({ 
    success: true, 
    message: `Removed ${removed} duplicate tasks`,
    before,
    after,
    marriageTasksFound: marriageTasks.length,
    marriageTasksKept: cleanMarriageTasks.length
  });
});

// Nightly processor endpoints
const JOURNALS_FILE = path.join(__dirname, 'journals.json'); // Store journals for processing
const PROCESSING_STATS_FILE = path.join(__dirname, 'processing-stats.json'); // Track processing history
const HORIZON_MODEL_FILE = path.join(__dirname, 'horizon-model.json');
const CONVERSATIONS_FILE = path.join(__dirname, 'conversations.json');

// Store journal data for nightly processing
app.post('/sync-journals', async (req, res) => {
  const { journals, date, isInitialSync = false } = req.body;
  
  if (!journals || !date) {
    return res.status(400).json({ error: 'Journals array and date required' });
  }
  
  try {
    // Load existing journal data from Supabase
    let storedJournals = await horizonCRS.readFile('journals.json') || {};
    
    // Store journals by date
    storedJournals[date] = journals;
    
    // Write back to Supabase
    await horizonCRS.writeFile('journals.json', storedJournals);
    
    if (isInitialSync) {
      console.log(`📚 [SYNC] Initial sync: Stored ${journals.length} journals for ${date}`);
    } else {
      console.log(`📝 [SYNC] Synced ${journals.length} journals for ${date}`);
    }
    
    res.json({ 
      success: true, 
      message: `Stored ${journals.length} journals for ${date}`,
      storedDates: Object.keys(storedJournals).length
    });
  } catch (error) {
    console.error('Error syncing journals:', error);
    res.status(500).json({ error: 'Failed to sync journals' });
  }
});

// Store conversation data for nightly processing
app.post('/sync-conversations', async (req, res) => {
  const { date, conversations } = req.body;
  
  if (!date || !conversations) {
    return res.status(400).json({ error: 'Missing date or conversations' });
  }
  
  try {
    // Load existing conversation data from Supabase
    let stored = await horizonCRS.readFile('conversations.json') || {};
    
    // Store by date, deduplicate by conversation ID
    if (!stored[date]) {
      stored[date] = [];
    }
    
    for (const conv of conversations) {
      const existingIndex = stored[date].findIndex(c => c.id === conv.id);
      if (existingIndex >= 0) {
        stored[date][existingIndex] = conv; // Update
      } else {
        stored[date].push(conv); // Add new
      }
    }
    
    // Write back to Supabase
    await horizonCRS.writeFile('conversations.json', stored);
    
    console.log(`💬 [SYNC] Stored ${conversations.length} conversations for ${date}`);
    res.json({ 
      success: true, 
      message: `Stored ${conversations.length} conversations for ${date}`,
      totalForDate: stored[date].length
    });
  } catch (error) {
    console.error('Error syncing conversations:', error);
    res.status(500).json({ error: 'Failed to sync conversations' });
  }
});

// Initialize with a week's worth of journals (called manually)
app.post('/initialize-week', async (req, res) => {
  const { journalsByDate } = req.body;
  
  if (!journalsByDate || typeof journalsByDate !== 'object') {
    return res.status(400).json({ error: 'journalsByDate object required with date keys and journal arrays as values' });
  }
  
  try {
    // Store all journals from the past week in Supabase
    await horizonCRS.writeFile('journals.json', journalsByDate);
    
    const dates = Object.keys(journalsByDate);
    const totalJournals = Object.values(journalsByDate).reduce((sum, journals) => sum + (journals || []).length, 0);
    
    console.log(`📚 [NIGHTLY] Initialized with ${totalJournals} journals across ${dates.length} days`);
    
    // Optionally process the most recent days to bootstrap patterns
    const recentDates = dates.sort().slice(-3); // Last 3 days
    for (const date of recentDates) {
      if (journalsByDate[date] && journalsByDate[date].length > 0) {
        console.log(`🔄 [NIGHTLY] Bootstrap processing for ${date}`);
        await processJournalsForDate(date, journalsByDate[date]);
      }
    }
    
    res.json({ 
      success: true, 
      message: `Initialized with ${totalJournals} journals across ${dates.length} days`,
      processedDates: recentDates
    });
  } catch (error) {
    console.error('Error initializing week:', error);
    res.status(500).json({ error: 'Failed to initialize week' });
  }
});

// Manual trigger for nightly processing
app.post('/process-day', async (req, res) => {
  const { date } = req.body;
  
  if (!date) {
    return res.status(400).json({ error: 'Date required (YYYY-MM-DD format)' });
  }
  
  try {
    // Load journals for the specified date
    let storedJournals = {};
    if (fs.existsSync(JOURNALS_FILE)) {
      storedJournals = JSON.parse(fs.readFileSync(JOURNALS_FILE, 'utf8'));
    }
    
    const journalsForDate = storedJournals[date] || [];
    
    if (journalsForDate.length === 0) {
      return res.json({ 
        success: true, 
        message: `No journals found for ${date}`,
        processed: false
      });
    }
    
    console.log(`🌙 [NIGHTLY] Manual processing for ${date} - ${journalsForDate.length} journals`);
    
    const result = await processJournalsForDate(date, journalsForDate);
    
    res.json({ 
      success: true, 
      message: `Processed ${journalsForDate.length} journals for ${date}`,
      result
    });
  } catch (error) {
    console.error('Error processing day:', error);
    res.status(500).json({ error: 'Failed to process day' });
  }
});

// Get processing statistics
app.get('/processing-stats', (req, res) => {
  try {
    let stats = { processedDays: 0, lastProcessed: null, totalJournalsProcessed: 0 };
    
    if (fs.existsSync(PROCESSING_STATS_FILE)) {
      stats = JSON.parse(fs.readFileSync(PROCESSING_STATS_FILE, 'utf8'));
    }
    
    // Also check how many journal dates we have stored
    let storedDates = 0;
    if (fs.existsSync(JOURNALS_FILE)) {
      const journals = JSON.parse(fs.readFileSync(JOURNALS_FILE, 'utf8'));
      storedDates = Object.keys(journals).length;
    }
    
    res.json({ 
      ...stats,
      storedJournalDates: storedDates
    });
  } catch (error) {
    console.error('Error getting stats:', error);
    res.status(500).json({ error: 'Failed to get processing stats' });
  }
});

// Get processing results for frontend integration
app.get('/processing-results', (req, res) => {
  try {
    const { since, date, includePatterns = 'true' } = req.query;
    
    const resultsFile = path.join(__dirname, 'processing-results.json');
    if (!fs.existsSync(resultsFile)) {
      return res.json({ results: [], model: null });
    }
    
    const allResults = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
    
    // Also check for initial model build
    let initialModel = null;
    const modelFile = path.join(__dirname, 'initial-model-build.json');
    if (fs.existsSync(modelFile)) {
      initialModel = JSON.parse(fs.readFileSync(modelFile, 'utf8'));
    }
    
    let filteredResults = {};
    
    if (date) {
      // Single date request
      if (allResults[date]) {
        filteredResults[date] = allResults[date];
      }
    } else if (since) {
      // Filter by timestamp
      const sinceDate = new Date(since);
      for (const [resultDate, result] of Object.entries(allResults)) {
        const processedAt = new Date(result.processedAt);
        if (processedAt > sinceDate) {
          filteredResults[resultDate] = result;
        }
      }
    } else {
      // Default: last 7 days
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 7);
      for (const [resultDate, result] of Object.entries(allResults)) {
        if (new Date(resultDate) >= cutoff) {
          filteredResults[resultDate] = result;
        }
      }
    }
    
    // Optionally strip heavy pattern data
    if (includePatterns !== 'true') {
      for (const date of Object.keys(filteredResults)) {
        delete filteredResults[date].crossDayPatterns;
      }
    }
    
    console.log(`📤 [RESULTS] Returning ${Object.keys(filteredResults).length} days of results`);
    
    res.json({
      results: filteredResults,
      model: initialModel,
      meta: {
        totalDaysStored: Object.keys(allResults).length,
        returnedDays: Object.keys(filteredResults).length,
        hasInitialModel: !!initialModel
      }
    });
    
  } catch (error) {
    console.error('Error getting processing results:', error);
    res.status(500).json({ error: 'Failed to get processing results' });
  }
});

// Get discovered behavioral patterns for Horizon
app.get('/patterns', (req, res) => {
  try {
    const { days = 30, minConfidence = 0.6, type = null } = req.query;
    
    const resultsFile = path.join(__dirname, 'processing-results.json');
    if (!fs.existsSync(resultsFile)) {
      return res.json({ patterns: [], totalFound: 0 });
    }

    const allResults = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
    
    // Collect all patterns from recent processing results
    const allPatterns = [];
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - parseInt(days));
    
    for (const [date, result] of Object.entries(allResults)) {
      if (new Date(date) >= cutoffDate && result.crossDayPatterns) {
        allPatterns.push(...result.crossDayPatterns.map(pattern => ({
          ...pattern,
          discovered_on: date
        })));
      }
    }
    
    // Filter patterns
    let filteredPatterns = allPatterns.filter(pattern => 
      pattern.confidence_score >= parseFloat(minConfidence)
    );
    
    if (type) {
      filteredPatterns = filteredPatterns.filter(pattern => 
        pattern.type === type
      );
    }
    
    // Sort by confidence and impact
    filteredPatterns.sort((a, b) => {
      const impactScore = {
        'high': 3,
        'medium': 2, 
        'low': 1
      };
      
      const aScore = (a.confidence_score || 0) + (impactScore[a.impact_level] || 0) * 0.1;
      const bScore = (b.confidence_score || 0) + (impactScore[b.impact_level] || 0) * 0.1;
      
      return bScore - aScore;
    });
    
    console.log(`📊 [PATTERNS API] Returning ${filteredPatterns.length} patterns (filtered from ${allPatterns.length} total)`);
    
    res.json({
      patterns: filteredPatterns,
      totalFound: allPatterns.length,
      filtered: filteredPatterns.length,
      filters: { days: parseInt(days), minConfidence: parseFloat(minConfidence), type },
      patternTypes: [...new Set(allPatterns.map(p => p.type))]
    });

  } catch (error) {
    console.error('Error getting patterns:', error);
    res.status(500).json({ error: 'Failed to get patterns' });
  }
});

// Get pattern insights for specific conversation context
app.post('/patterns/contextual', (req, res) => {
  try {
    const { context, limit = 5 } = req.body;
    
    if (!context) {
      return res.status(400).json({ error: 'Context required for contextual patterns' });
    }
    
    const resultsFile = path.join(__dirname, 'processing-results.json');
    if (!fs.existsSync(resultsFile)) {
      return res.json({ relevantPatterns: [] });
    }

    const allResults = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
    
    // Collect all patterns
    const allPatterns = [];
    for (const [date, result] of Object.entries(allResults)) {
      if (result.crossDayPatterns) {
        allPatterns.push(...result.crossDayPatterns.map(pattern => ({
          ...pattern,
          discovered_on: date
        })));
      }
    }
    
    // Simple relevance scoring based on context keywords
    const contextLower = context.toLowerCase();
    const contextWords = contextLower.split(/\s+/).filter(word => word.length > 2);
    
    const scoredPatterns = allPatterns.map(pattern => {
      let relevanceScore = 0;
      const patternText = `${pattern.pattern} ${pattern.actionable_insight} ${pattern.evidence}`.toLowerCase();
      
      // Score based on keyword matches
      for (const word of contextWords) {
        if (patternText.includes(word)) {
          relevanceScore += 1;
        }
      }
      
      // Boost score for high-confidence, high-impact patterns
      relevanceScore += (pattern.confidence_score || 0) * 0.5;
      if (pattern.impact_level === 'high') relevanceScore += 0.3;
      if (pattern.impact_level === 'medium') relevanceScore += 0.1;
      
      return { ...pattern, relevanceScore };
    });
    
    // Sort by relevance and take top results
    const relevantPatterns = scoredPatterns
      .filter(pattern => pattern.relevanceScore > 0)
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, limit);
    
    console.log(`🎯 [CONTEXTUAL PATTERNS] Found ${relevantPatterns.length} relevant patterns for context: "${context.substring(0, 50)}..."`);
    
    res.json({
      relevantPatterns,
      context,
      totalPatterns: allPatterns.length,
      matchedPatterns: scoredPatterns.filter(p => p.relevanceScore > 0).length
    });

  } catch (error) {
    console.error('Error getting contextual patterns:', error);
    res.status(500).json({ error: 'Failed to get contextual patterns' });
  }
});

// Build initial model from all available journals (one-time bootstrap)
app.post('/build-initial-model', async (req, res) => {
  const { forceRebuild = false } = req.body;
  const openAIKey = process.env.OPENAI_API_KEY;
  
  if (!openAIKey) {
    return res.status(500).json({ error: 'OpenAI API key not configured on server' });
  }
  
  try {
    // Load all journals
    let storedJournals = {};
    if (fs.existsSync(JOURNALS_FILE)) {
      storedJournals = JSON.parse(fs.readFileSync(JOURNALS_FILE, 'utf8'));
    }
    
    const dates = Object.keys(storedJournals).sort();
    if (dates.length < 5) {
      return res.status(400).json({ 
        error: `Need at least 5 days of journals. Currently have ${dates.length} days.`,
        suggestion: 'Sync more journals first with POST /sync-journals or POST /initialize-week'
      });
    }
    
    console.log(`🏗️ [MODEL BUILD] Starting initial model build from ${dates.length} days of journals...`);
    
    // Flatten journals into format needed
    const journals = [];
    for (const date of dates) {
      const entries = storedJournals[date];
      if (entries && entries.length > 0) {
        const combinedContent = entries.map(e => e.content).join('\n\n');
        journals.push({ date, content: combinedContent });
      }
    }
    
    // Run all extraction phases
    const result = {
      identity: null,
      keyPeople: [],
      lifeState: null,
      patterns: [],
      emotionalBaseline: null,
      lifeEvents: [],
      meta: {
        journalsProcessed: journals.length,
        dateRange: { start: dates[0], end: dates[dates.length - 1] },
        builtAt: new Date().toISOString()
      }
    };
    
    // Phase 1: Extract Identity
    console.log('🏗️ [MODEL BUILD] Phase 1: Extracting identity...');
    result.identity = await extractIdentityFromJournals(journals, openAIKey);
    
    // Phase 2: Extract Key People
    console.log('🏗️ [MODEL BUILD] Phase 2: Extracting key people...');
    result.keyPeople = await extractKeyPeopleFromJournals(journals, openAIKey);
    
    // Phase 3: Extract Life State (goals, situations, desires - interconnected)
    console.log('🏗️ [MODEL BUILD] Phase 3: Extracting life state...');
    result.lifeState = await extractLifeStateFromJournals(journals, openAIKey);
    
    // Phase 4: Detect Patterns
    console.log('🏗️ [MODEL BUILD] Phase 4: Detecting patterns...');
    result.patterns = await detectPatternsFromJournals(journals, openAIKey, result);
    
    // Phase 5: Emotional Baseline
    console.log('🏗️ [MODEL BUILD] Phase 5: Calculating emotional baseline...');
    result.emotionalBaseline = await extractEmotionalBaseline(journals, openAIKey);
    
    // Phase 6: Life Events
    console.log('🏗️ [MODEL BUILD] Phase 6: Extracting life events...');
    result.lifeEvents = await extractLifeEvents(journals, openAIKey);
    
    // Store result
    const modelFile = path.join(__dirname, 'initial-model-build.json');
    fs.writeFileSync(modelFile, JSON.stringify(result, null, 2));
    
    console.log(`✅ [MODEL BUILD] Complete! Identity: ${!!result.identity}, People: ${result.keyPeople?.length || 0}, Patterns: ${result.patterns?.length || 0}`);
    
    res.json({
      success: true,
      message: 'Initial model built successfully',
      summary: {
        identity: !!result.identity?.name,
        keyPeople: result.keyPeople?.length || 0,
        goals: result.lifeState?.goals?.length || 0,
        situations: result.lifeState?.situations?.length || 0,
        desires: result.lifeState?.coreDesires?.length || 0,
        patterns: result.patterns?.length || 0,
        lifeEvents: result.lifeEvents?.length || 0,
        dateRange: result.meta.dateRange
      },
      result // Full result for frontend to integrate
    });
    
  } catch (error) {
    console.error('❌ [MODEL BUILD] Failed:', error);
    res.status(500).json({ error: error.message });
  }
});

// Full journal processing function with AI analysis
async function processJournalsForDate(date, journals) {
  console.log(`📊 [NIGHTLY] Processing ${journals.length} journals for ${date}`);
  
  try {
    const startTime = Date.now();
    
    // Update stats
    let stats = { processedDays: 0, lastProcessed: null, totalJournalsProcessed: 0 };
    if (fs.existsSync(PROCESSING_STATS_FILE)) {
      stats = JSON.parse(fs.readFileSync(PROCESSING_STATS_FILE, 'utf8'));
    }
    
    stats.processedDays++;
    stats.lastProcessed = date;
    stats.totalJournalsProcessed += journals.length;
    
    // Extract content for AI processing
    const combinedContent = journals.map(j => j.content).join('\n\n');
    
    if (!combinedContent.trim()) {
      console.log(`📝 [NIGHTLY] Empty content for ${date}, skipping processing`);
      return {
        date,
        journalCount: journals.length,
        processedAt: new Date().toISOString(),
        extractedGoals: 0,
        extractedSituations: 0,
        extractedDesires: 0,
        relationshipMentions: 0,
        insights: ['No content to process'],
        processingTime: Date.now() - startTime
      };
    }

    // AI Analysis using GPT (if API key available)
    let extractions = null;
    const openAIKey = process.env.OPENAI_API_KEY;
    
    if (openAIKey) {
      try {
        console.log(`🧠 [NIGHTLY] Running AI analysis on ${journals.length} journal entries`);
        extractions = await performAIAnalysis(combinedContent, date, openAIKey);
      } catch (error) {
        console.error('❌ [NIGHTLY] AI analysis failed:', error);
      }
    } else {
      console.log('⚠️ [NIGHTLY] No OpenAI API key found, using basic analysis');
    }

    // Fallback to basic analysis if AI fails
    if (!extractions) {
      extractions = performBasicAnalysis(combinedContent, date);
    }

    // Generate insights based on extractions
    const insights = generateInsights(extractions);

    // Perform multi-day pattern correlation analysis
    let crossDayPatterns = [];
    try {
      console.log(`🧠 [PATTERN ANALYSIS] Running cross-day correlation analysis...`);
      crossDayPatterns = await performCrossDayAnalysis(extractions, date, openAIKey);
    } catch (error) {
      console.error('❌ [PATTERN ANALYSIS] Cross-day analysis failed:', error);
    }

    const result = {
      date,
      journalCount: journals.length,
      processedAt: new Date().toISOString(),
      extractedGoals: extractions.goals.length,
      extractedSituations: extractions.situations.length,
      extractedDesires: extractions.desires.length,
      relationshipMentions: extractions.relationshipMentions.length,
      overallMood: extractions.overallMood,
      energyLevel: extractions.energyLevel,
      productivityLevel: extractions.productivityLevel,
      insights: insights,
      crossDayPatterns: crossDayPatterns,
      processingTime: Date.now() - startTime
    };

    // Save detailed results
    const resultsFile = path.join(__dirname, 'processing-results.json');
    let allResults = {};
    if (fs.existsSync(resultsFile)) {
      allResults = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
    }
    allResults[date] = { ...result, fullExtractions: extractions };
    fs.writeFileSync(resultsFile, JSON.stringify(allResults, null, 2));

    // Update stats file
    fs.writeFileSync(PROCESSING_STATS_FILE, JSON.stringify(stats, null, 2));
    
    // Send notification about processing completion
    if (server.deviceTokens.length > 0) {
      const { title, body } = createInsightfulNotification(extractions, insights, journals.length, date);
      await server.sendImmediateNotification(title, body);
    }
    
    console.log(`✅ [NIGHTLY] Completed processing for ${date} in ${result.processingTime}ms`);
    return result;
    
  } catch (error) {
    console.error(`❌ [NIGHTLY] Error processing journals for ${date}:`, error);
    throw error;
  }
}

// AI Analysis using OpenAI
async function performAIAnalysis(content, date, apiKey) {
  const extractionPrompt = buildExtractionPrompt(content);
  
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4',
      messages: [
        {
          role: 'system',
          content: 'You are an expert at analyzing personal journal entries and extracting meaningful patterns, goals, and insights.'
        },
        {
          role: 'user',
          content: extractionPrompt
        }
      ],
      temperature: 0.3,
      max_tokens: 2000
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI API failed: ${response.status}`);
  }

  const data = await response.json();
  const aiResponse = data.choices[0].message.content;
  
  return parseExtractionResponse(aiResponse, date);
}

// Basic analysis fallback (keyword-based)
function performBasicAnalysis(content, date) {
  console.log(`📊 [NIGHTLY] Performing basic keyword analysis`);
  
  const lowerContent = content.toLowerCase();
  
  // Extract basic patterns
  const goals = extractBasicGoals(content);
  const situations = extractBasicSituations(content);
  const desires = extractBasicDesires(content);
  const relationshipMentions = extractBasicRelationships(content);
  
  // Basic mood analysis
  const positiveWords = ['happy', 'excited', 'great', 'amazing', 'wonderful', 'good', 'love', 'success'];
  const negativeWords = ['sad', 'frustrated', 'angry', 'tired', 'stressed', 'worried', 'difficult', 'problem'];
  
  const positiveCount = positiveWords.reduce((count, word) => 
    count + (lowerContent.match(new RegExp(word, 'g')) || []).length, 0);
  const negativeCount = negativeWords.reduce((count, word) => 
    count + (lowerContent.match(new RegExp(word, 'g')) || []).length, 0);
  
  const overallMood = positiveCount - negativeCount;
  
  return {
    date,
    goals,
    situations,
    desires,
    relationshipMentions,
    emotionalStates: [],
    keyEvents: extractKeyEvents(content),
    overallMood: Math.max(-10, Math.min(10, overallMood)),
    energyLevel: Math.floor(Math.random() * 10) + 1, // Placeholder
    productivityLevel: Math.floor(Math.random() * 10) + 1, // Placeholder
    qualityScore: Math.min(10, content.length / 50) // Based on content length
  };
}

// Helper functions for basic analysis
function extractBasicGoals(content) {
  const goalKeywords = ['want to', 'plan to', 'goal', 'achieve', 'working towards', 'hope to'];
  const goals = [];
  
  goalKeywords.forEach(keyword => {
    const regex = new RegExp(`([^.!?]*${keyword}[^.!?]*)`, 'gi');
    const matches = content.match(regex);
    if (matches) {
      matches.forEach((match, index) => {
        goals.push({
          title: `Goal ${goals.length + 1}`,
          description: match.trim(),
          domain: 'other',
          priority: 5,
          timeframe: 'medium',
          status: 'new',
          evidence: match.trim(),
          confidence: 0.6
        });
      });
    }
  });
  
  return goals.slice(0, 5); // Limit to 5 goals
}

function extractBasicSituations(content) {
  const situationKeywords = ['dealing with', 'situation', 'problem', 'working on', 'handling'];
  const situations = [];
  
  situationKeywords.forEach(keyword => {
    const regex = new RegExp(`([^.!?]*${keyword}[^.!?]*)`, 'gi');
    const matches = content.match(regex);
    if (matches) {
      matches.forEach((match, index) => {
        situations.push({
          title: `Situation ${situations.length + 1}`,
          description: match.trim(),
          domain: 'other',
          status: 'ongoing',
          emotionalImpact: 0,
          stressLevel: 5,
          evidence: match.trim(),
          confidence: 0.5
        });
      });
    }
  });
  
  return situations.slice(0, 3);
}

function extractBasicDesires(content) {
  const desireKeywords = ['want', 'wish', 'desire', 'would love', 'hoping for'];
  const desires = [];
  
  desireKeywords.forEach(keyword => {
    const regex = new RegExp(`([^.!?]*${keyword}[^.!?]*)`, 'gi');
    const matches = content.match(regex);
    if (matches) {
      matches.forEach((match, index) => {
        desires.push({
          title: `Desire ${desires.length + 1}`,
          description: match.trim(),
          category: 'other',
          intensity: 5,
          feasibility: 5,
          evidence: match.trim(),
          confidence: 0.4
        });
      });
    }
  });
  
  return desires.slice(0, 3);
}

function extractBasicRelationships(content) {
  // Simple name detection (capitalized words that might be names)
  const nameRegex = /\b[A-Z][a-z]+\b/g;
  const potentialNames = content.match(nameRegex) || [];
  
  // Filter out common words that aren't names
  const commonWords = ['Today', 'Yesterday', 'Tomorrow', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const likelyNames = potentialNames.filter(name => !commonWords.includes(name));
  
  return likelyNames.slice(0, 5).map(name => ({
    name,
    context: `Mentioned in journal entry`,
    emotionalTone: 'neutral',
    interactionType: 'casual',
    significance: 3,
    newInformation: true
  }));
}

function extractKeyEvents(content) {
  // Extract sentences that might describe events
  const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 10);
  return sentences.slice(0, 3).map(s => s.trim());
}

// Build extraction prompt for AI
function buildExtractionPrompt(content) {
  return `Analyze this content from journal entries. Extract structured information about goals, situations, desires, relationships, and emotional patterns.

Return a JSON object with this structure:
{
  "goals": [
    {
      "title": "Brief goal title",
      "description": "What they want to achieve", 
      "domain": "health|career|relationships|personal|financial|creative|learning|other",
      "priority": 1-10,
      "timeframe": "immediate|short|medium|long",
      "status": "new|progress|obstacle|completed|abandoned",
      "evidence": "Exact quote from journal",
      "confidence": 0.0-1.0
    }
  ],
  "situations": [
    {
      "title": "Situation name",
      "description": "Current situation they're dealing with",
      "domain": "work|family|health|social|financial|living|other", 
      "status": "ongoing|resolved|escalating|improving",
      "emotionalImpact": -1.0 to 1.0,
      "stressLevel": 0-10,
      "evidence": "Exact quote from journal",
      "confidence": 0.0-1.0
    }
  ],
  "desires": [
    {
      "title": "What they want",
      "description": "Deeper description of the desire",
      "category": "experience|achievement|relationship|material|spiritual|knowledge|other",
      "intensity": 0-10,
      "feasibility": 0-10, 
      "evidence": "Exact quote from journal",
      "confidence": 0.0-1.0
    }
  ],
  "relationshipMentions": [
    {
      "name": "Person's name or relationship",
      "context": "Full sentence where they were mentioned",
      "emotionalTone": "very_positive|positive|neutral|negative|very_negative",
      "interactionType": "conflict|support|casual|intimate|professional|family",
      "significance": 0-10,
      "newInformation": true|false
    }
  ],
  "overallMood": -10 to 10,
  "energyLevel": 0-10,
  "productivityLevel": 0-10,
  "qualityScore": 0-10
}

Journal Content:
${content}`;
}

// Parse AI extraction response
function parseExtractionResponse(response, date) {
  try {
    // Clean up response (sometimes AI adds markdown formatting)
    let cleanResponse = response.replace(/```json\n?/g, '').replace(/```\n?/g, '');
    const parsed = JSON.parse(cleanResponse);
    
    return {
      date,
      goals: parsed.goals || [],
      situations: parsed.situations || [],
      desires: parsed.desires || [],
      relationshipMentions: parsed.relationshipMentions || [],
      emotionalStates: parsed.emotionalStates || [],
      keyEvents: parsed.keyEvents || [],
      overallMood: parsed.overallMood || 0,
      energyLevel: parsed.energyLevel || 5,
      productivityLevel: parsed.productivityLevel || 5,
      qualityScore: parsed.qualityScore || 5
    };
  } catch (error) {
    console.error('❌ [NIGHTLY] Failed to parse AI response:', error);
    return performBasicAnalysis('', date);
  }
}

// Cross-day pattern correlation analysis using GPT
async function performCrossDayAnalysis(currentExtractions, currentDate, apiKey) {
  if (!apiKey) {
    console.log('⚠️ [PATTERN ANALYSIS] No OpenAI API key - using basic correlation analysis');
    return performBasicCorrelationAnalysis(currentExtractions, currentDate);
  }

  try {
    // Get last 30 days of processing results for pattern analysis
    const historicalData = getHistoricalProcessingData(currentDate, 30);
    
    if (historicalData.length < 3) {
      console.log(`📊 [PATTERN ANALYSIS] Insufficient historical data (${historicalData.length} days) - need at least 3 days`);
      return [];
    }

    console.log(`📊 [PATTERN ANALYSIS] Analyzing patterns across ${historicalData.length} days of data`);

    // Build comprehensive analysis prompt
    const analysisPrompt = await buildPatternAnalysisPrompt(currentExtractions, currentDate, historicalData, apiKey);
    
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [
          {
            role: 'system',
            content: 'You are an expert behavioral analyst and pattern recognition specialist. You excel at finding meaningful correlations across time in personal data. Focus on actionable insights that can help optimize behavior and well-being.'
          },
          {
            role: 'user',
            content: analysisPrompt
          }
        ],
        temperature: 0.3,
        max_tokens: 3000
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI API failed: ${response.status}`);
    }

    const data = await response.json();
    const aiResponse = data.choices[0].message.content;
    
    const patterns = parsePatternAnalysisResponse(aiResponse);
    console.log(`✅ [PATTERN ANALYSIS] Discovered ${patterns.length} cross-day patterns`);
    
    return patterns;

  } catch (error) {
    console.error('❌ [PATTERN ANALYSIS] GPT analysis failed:', error);
    return performBasicCorrelationAnalysis(currentExtractions, currentDate);
  }
}

// Get historical processing results for pattern analysis
function getHistoricalProcessingData(currentDate, daysBack) {
  try {
    const resultsFile = path.join(__dirname, 'processing-results.json');
    if (!fs.existsSync(resultsFile)) {
      return [];
    }

    const allResults = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
    
    // Get date range
    const current = new Date(currentDate);
    const historicalData = [];
    
    for (let i = 1; i <= daysBack; i++) {
      const checkDate = new Date(current);
      checkDate.setDate(checkDate.getDate() - i);
      const dateStr = checkDate.toISOString().split('T')[0];
      
      if (allResults[dateStr]) {
        historicalData.push({
          date: dateStr,
          ...allResults[dateStr]
        });
      }
    }
    
    return historicalData.reverse(); // Chronological order (oldest first)
  } catch (error) {
    console.error('❌ [PATTERN ANALYSIS] Failed to load historical data:', error);
    return [];
  }
}

// Generate dynamic analysis prompt based on actual journal content
async function generateDynamicAnalysisPrompt(historicalData, apiKey) {
  if (!apiKey || historicalData.length < 3) {
    return getDefaultAnalysisFramework();
  }

  try {
    // Extract actual themes from recent journal content
    const recentContent = historicalData.slice(-7).map(day => ({
      date: day.date,
      content: day.fullExtractions?.keyEvents?.join(' ') || '',
      goals: day.fullExtractions?.goals?.map(g => g.description).join(' ') || '',
      relationships: day.fullExtractions?.relationshipMentions?.map(r => r.name + ': ' + r.context).join(' ') || ''
    }));

    const themeAnalysisPrompt = `Analyze these journal entries to identify the PRIMARY LIFE THEMES and STRATEGIC OPPORTUNITIES for pattern analysis:

RECENT JOURNAL CONTENT:
${recentContent.map(day => `
Date: ${day.date}
Content themes: ${day.content}
Goals: ${day.goals}
Relationships: ${day.relationships}
`).join('\n')}

Based on this actual content, identify:
1. What are the 3-4 MOST IMPORTANT recurring themes in this person's life?
2. What strategic decisions are they currently navigating?
3. What patterns would be MOST VALUABLE for them to understand?
4. What behavioral levers could create disproportionate impact?

Return ONLY a JSON object with dynamic analysis categories:
{
  "primary_themes": ["theme1", "theme2", "theme3"],
  "strategic_focus_areas": [
    {
      "category": "Strategic Category Name",
      "questions": [
        "Specific pattern to look for based on their content",
        "Another strategic insight to discover"
      ]
    }
  ],
  "key_variables": ["variable1", "variable2"],
  "success_metrics": ["what success looks like for this person"]
}`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [
          {
            role: 'system',
            content: 'You are an expert at analyzing personal journal content to identify strategic life themes and optimization opportunities. Return only valid JSON.'
          },
          {
            role: 'user',
            content: themeAnalysisPrompt
          }
        ],
        temperature: 0.3,
        max_tokens: 1500
      })
    });

    if (!response.ok) {
      throw new Error(`Theme analysis failed: ${response.status}`);
    }

    const data = await response.json();
    const themeResponse = data.choices[0].message.content;
    
    try {
      const themes = JSON.parse(themeResponse.replace(/```json\n?/g, '').replace(/```\n?/g, ''));
      return buildCustomAnalysisFramework(themes);
    } catch (parseError) {
      console.error('Failed to parse theme analysis:', parseError);
      return getDefaultAnalysisFramework();
    }

  } catch (error) {
    console.error('Dynamic prompt generation failed:', error);
    return getDefaultAnalysisFramework();
  }
}

// Build custom analysis framework from identified themes
function buildCustomAnalysisFramework(themes) {
  return `
DYNAMIC LIFE OPTIMIZATION ANALYSIS
Based on actual journal content, focus on these strategic areas:

PRIMARY LIFE THEMES IDENTIFIED: ${themes.primary_themes?.join(', ') || 'Personal development, relationships, career'}

STRATEGIC ANALYSIS FOCUS:
${themes.strategic_focus_areas?.map(area => `
${area.category.toUpperCase()}:
${area.questions?.map(q => `- ${q}`).join('\n') || '- Analyze key patterns in this area'}
`).join('\n') || 'CAREER: Analyze breakthrough patterns\nRELATIONSHIPS: Find attraction/connection levers\nCREATIVE: Identify flow state triggers'}

KEY VARIABLES TO CORRELATE: ${themes.key_variables?.join(', ') || 'emotional states, social interactions, creative output, external responses'}

SUCCESS METRICS: ${themes.success_metrics?.join(', ') || 'breakthrough moments, relationship progress, creative achievements'}

FIND COUNTERINTUITIVE, ACTIONABLE PATTERNS that reveal hidden behavioral levers for optimization.`;
}

// Default framework fallback
function getDefaultAnalysisFramework() {
  return `
STRATEGIC BEHAVIORAL ANALYSIS
Focus on counterintuitive patterns that reveal hidden optimization levers:

CAREER OPTIMIZATION:
- When do breakthrough opportunities correlate with specific internal states?
- What preparation methods predict success vs. self-sabotage?

RELATIONSHIP DYNAMICS:
- What behavioral patterns create attraction vs. repel (despite good intentions)?
- How do internal processing cycles affect external relationship responses?

CREATIVE FLOW:
- When do breakthrough insights happen relative to other life cycles?
- What combination of factors predict innovation vs. stagnation?

MANIFESTATION MECHANICS:
- When does "surrendering outcome" accelerate vs. signal avoidance?
- What early indicators predict major external shifts?`;
}

// Build comprehensive pattern analysis prompt  
async function buildPatternAnalysisPrompt(currentExtractions, currentDate, historicalData, apiKey) {
  // First, dynamically analyze the journal content to understand current life themes
  const dynamicFramework = await generateDynamicAnalysisPrompt(historicalData, apiKey);
  
  const prompt = `DYNAMIC BEHAVIORAL PATTERN ANALYSIS

${dynamicFramework}

CURRENT DAY ANALYSIS (${currentDate}):
${JSON.stringify(currentExtractions, null, 2)}

HISTORICAL DATA (last ${historicalData.length} days):
${historicalData.map(day => `
Date: ${day.date}
Goals: ${day.extractedGoals} | Situations: ${day.extractedSituations} | Mood: ${day.overallMood} | Energy: ${day.energyLevel} | Productivity: ${day.productivityLevel}
Locations: ${day.fullExtractions?.goals?.map(g => g.evidence?.match(/at|in|from ([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)/)?.[1])?.filter(Boolean)?.join(', ') || 'unknown'}
Key themes: ${day.fullExtractions?.keyEvents?.slice(0, 2)?.join('; ') || 'none'}
`).join('\n')}

ANALYSIS OBJECTIVES:
You are analyzing an actor's behavioral patterns to discover STRATEGIC LIFE INTELLIGENCE that can optimize career breakthroughs, relationship dynamics, creative flow, and personal manifestation. This person navigates:

- Acting career (auditions, bookings, industry relationships, manager dynamics)
- Deep romantic connection with "Stella" (complex spiritual/manifestation beliefs)
- Creative tech projects (Aurora app development) 
- Family dynamics and social circles
- Internal spiritual/manifestation journey

FIND REVOLUTIONARY INSIGHTS LIKE:

CAREER WARFARE:
- When do breakthrough auditions correlate with specific emotional states/life events?
- What manager interaction patterns predict booking success vs. dead ends?
- How does Stella-related processing affect audition performance (positively or negatively)?
- What social dynamics with cast members create industry leverage vs. drain energy?

MANIFESTATION MECHANICS:
- When does "surrendering outcome" actually accelerate manifestation vs. when does it signal avoidance?
- What combination of spiritual practices + tactical actions create breakthrough moments?
- How do gratitude vs. desire-focused journal entries correlate with external shifts?
- What early warning signs predict "spiritual bypassing" vs. authentic alignment?

RELATIONSHIP STRATEGY:
- What behavioral patterns actually create attraction vs. repel (despite good intentions)?
- When does focus on Stella correlate with other life areas thriving vs. declining?
- How do family stress periods affect romantic clarity and decision-making?
- What social proof dynamics affect how Stella responds (Instagram interactions, mutual friends)?

CREATIVE FLOW HACKING:
- When do tech project breakthroughs happen relative to acting/relationship cycles?
- What combination of locations, people, and internal states predict creative breakthroughs?
- How does processing emotional complexity fuel vs. drain creative output?

AVOID OBVIOUS PATTERNS. Find the counterintuitive, strategic insights that reveal hidden levers of influence.

Return a JSON array of patterns found:
[
  {
    "type": "temporal_correlation|location_pattern|social_amplifier|habit_cascade|emotional_cycle|productivity_optimizer|energy_management|goal_achievement",
    "pattern": "Clear, specific pattern description",
    "evidence": "Statistical/observational evidence from the data",
    "actionable_insight": "Specific action they can take based on this",
    "confidence_score": 0.0-1.0,
    "frequency": "how often this pattern occurs",
    "impact_level": "high|medium|low",
    "time_span": "how many days this pattern spans",
    "correlation_strength": 0.0-1.0
  }
]

REQUIREMENTS:
- Only include patterns with strong evidence AND strategic implications (confidence > 0.7)
- Focus on COUNTERINTUITIVE insights that reveal hidden behavioral levers
- Look for cascading effects: small actions → disproportionate outcomes
- Find timing patterns: when specific actions have amplified effects
- Identify warning signals: early indicators that predict major shifts
- Maximum 8 patterns, prioritized by strategic impact and actionability
- Each insight must suggest a specific behavioral intervention

EXAMPLE REVOLUTIONARY PATTERNS:
✅ "Days spent processing Stella emotions correlate with 3x higher creative output on Aurora (observed 7/9 times) - emotional complexity fuels technical innovation"
✅ "Instagram stories posted between 11pm-1am predict Stella viewing within 2 hours 85% of the time - late night posts bypass her conscious filters"  
✅ "Manager meetings scheduled after family stress conversations result in 60% more opportunities offered (4/6 times) - vulnerability state enhances professional magnetism"
✅ "Gratitude-heavy journal entries predict external manifestations within 5-10 days (correlation: 0.82) - but only when NOT written with Stella as primary focus"
✅ "Friend cancellations (like Eddie) correlate with creative breakthroughs within 48 hours (5/7 times) - forced solitude activates innovation mode"

REJECT SURFACE-LEVEL OBSERVATIONS:
❌ "Positive emotions correlate with Stella mentions"
❌ "Working on Aurora improves productivity"  
❌ "Sleep affects energy levels"
❌ "Family time creates gratitude"

STRATEGIC INTELLIGENCE ONLY.`;

  return prompt;
}

// Parse GPT pattern analysis response
function parsePatternAnalysisResponse(response) {
  try {
    // Clean up response (sometimes AI adds markdown formatting)
    let cleanResponse = response.replace(/```json\n?/g, '').replace(/```\n?/g, '');
    
    // Try to extract JSON array from response
    const jsonMatch = cleanResponse.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      cleanResponse = jsonMatch[0];
    }
    
    const patterns = JSON.parse(cleanResponse);
    
    if (!Array.isArray(patterns)) {
      console.error('❌ [PATTERN ANALYSIS] Response is not an array');
      return [];
    }
    
    // Filter and validate patterns
    return patterns.filter(pattern => 
      pattern.pattern && 
      pattern.confidence_score >= 0.6 && 
      pattern.actionable_insight &&
      pattern.type
    ).map(pattern => ({
      ...pattern,
      discovered_date: new Date().toISOString(),
      id: `pattern_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    }));
    
  } catch (error) {
    console.error('❌ [PATTERN ANALYSIS] Failed to parse pattern response:', error);
    return [];
  }
}

// Basic correlation analysis fallback
function performBasicCorrelationAnalysis(currentExtractions, currentDate) {
  const patterns = [];
  const historicalData = getHistoricalProcessingData(currentDate, 14);
  
  if (historicalData.length < 5) {
    return [];
  }
  
  // Simple mood-productivity correlation
  const moodProductivityCorrelation = calculateSimpleCorrelation(
    historicalData.map(d => d.overallMood || 0),
    historicalData.map(d => d.productivityLevel || 5)
  );
  
  if (moodProductivityCorrelation > 0.5) {
    patterns.push({
      type: 'emotional_cycle',
      pattern: `Strong mood-productivity correlation detected`,
      evidence: `Correlation coefficient: ${moodProductivityCorrelation.toFixed(2)} across ${historicalData.length} days`,
      actionable_insight: 'Focus on mood management strategies to boost productivity',
      confidence_score: Math.min(0.9, moodProductivityCorrelation),
      impact_level: 'high',
      discovered_date: new Date().toISOString(),
      id: `basic_pattern_${Date.now()}`
    });
  }
  
  // Goal achievement pattern
  const goalDays = historicalData.filter(d => d.extractedGoals > 0);
  if (goalDays.length >= 3) {
    const avgMoodOnGoalDays = goalDays.reduce((sum, d) => sum + (d.overallMood || 0), 0) / goalDays.length;
    const avgMoodOtherDays = historicalData.filter(d => d.extractedGoals === 0)
      .reduce((sum, d) => sum + (d.overallMood || 0), 0) / Math.max(1, historicalData.length - goalDays.length);
    
    if (avgMoodOnGoalDays > avgMoodOtherDays + 1) {
      patterns.push({
        type: 'goal_achievement',
        pattern: 'Goal-setting days correlate with improved mood',
        evidence: `Average mood: ${avgMoodOnGoalDays.toFixed(1)} on goal days vs ${avgMoodOtherDays.toFixed(1)} on other days`,
        actionable_insight: 'Regular goal setting may boost overall well-being',
        confidence_score: 0.7,
        impact_level: 'medium',
        discovered_date: new Date().toISOString(),
        id: `basic_goal_pattern_${Date.now()}`
      });
    }
  }
  
  return patterns;
}

// Simple correlation coefficient calculator
function calculateSimpleCorrelation(x, y) {
  if (x.length !== y.length || x.length === 0) return 0;
  
  const n = x.length;
  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
  const sumX2 = x.reduce((sum, xi) => sum + xi * xi, 0);
  const sumY2 = y.reduce((sum, yi) => sum + yi * yi, 0);
  
  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  
  return denominator === 0 ? 0 : numerator / denominator;
}

// Generate insights from extractions
function generateInsights(extractions) {
  const insights = [];
  
  if (extractions.goals.length > 0) {
    insights.push(`🎯 Identified ${extractions.goals.length} active goal${extractions.goals.length > 1 ? 's' : ''}`);
  }
  
  if (extractions.situations.length > 0) {
    insights.push(`🏠 Tracking ${extractions.situations.length} ongoing situation${extractions.situations.length > 1 ? 's' : ''}`);
  }
  
  if (extractions.overallMood > 5) {
    insights.push(`😊 Positive mood detected (${extractions.overallMood}/10)`);
  } else if (extractions.overallMood < -2) {
    insights.push(`😔 Lower mood noted (${extractions.overallMood}/10) - consider self-care`);
  }
  
  if (extractions.productivityLevel > 7) {
    insights.push(`⚡ High productivity day (${extractions.productivityLevel}/10)`);
  }
  
  if (extractions.relationshipMentions.length > 2) {
    insights.push(`🤝 Rich social connections mentioned (${extractions.relationshipMentions.length} people)`);
  }
  
  if (insights.length === 0) {
    insights.push('📝 Journal entry processed and analyzed');
  }
  
  return insights;
}

// Create insightful notification for processing completion
function createInsightfulNotification(extractions, insights, journalCount, date) {
  // Create smart notification title and body
  let title = "🧠 Journal Analysis Complete";
  let body = `Processed ${journalCount} journal${journalCount > 1 ? 's' : ''} for ${date}`;
  
  // Add the most interesting insight
  if (insights && insights.length > 0) {
    const topInsight = insights[0];
    body = `${topInsight} - ${body}`;
  }
  
  // Make it more engaging based on extracted data
  if (extractions.overallMood > 5) {
    title = "😊 Positive Patterns Detected";
  } else if (extractions.goals && extractions.goals.length > 2) {
    title = "🎯 Goal-Rich Day Analyzed";
  } else if (extractions.relationshipMentions && extractions.relationshipMentions.length > 3) {
    title = "🤝 Social Connections Mapped";
  }
  
  return { title, body };
}

// === Model Build Helper Functions ===

async function extractIdentityFromJournals(journals, apiKey) {
  const sample = sampleJournals(journals, 30);
  const content = sample.map(j => `[${j.date}]\n${j.content}`).join('\n\n---\n\n');
  
  const prompt = `Analyze these journal entries to understand WHO this person is.

JOURNALS:
${content}

Extract their identity. Return ONLY valid JSON:
{
  "name": "Their name if mentioned (or null)",
  "profession": "Their job/career",
  "location": "Where they live",
  "lifeStage": "Current life stage (e.g., 'Young professional building career', 'Parent of young children')",
  "coreValues": ["Value 1", "Value 2", "Value 3"],
  "personalityTraits": ["Trait 1", "Trait 2", "Trait 3"],
  "lifePhilosophy": "Their general approach to life if apparent"
}

Be specific. Use evidence from the journals.`;

  return await callGPTForModelBuild(prompt, apiKey);
}

async function extractKeyPeopleFromJournals(journals, apiKey) {
  const sample = sampleJournals(journals, 40);
  const content = sample.map(j => `[${j.date}]\n${j.content}`).join('\n\n---\n\n');
  
  const prompt = `Analyze these journal entries to identify the KEY PEOPLE in this person's life.

JOURNALS:
${content}

Extract the most important people. Return ONLY valid JSON array:
[
  {
    "name": "Person's name",
    "relationship": "family|friend|romantic|professional|mentor|other",
    "importance": 1-10,
    "dynamic": "Description of the relationship (e.g., 'Supportive mother, talks weekly')",
    "sentiment": "positive|negative|complicated|neutral",
    "mentionCount": approximate number of mentions,
    "recentContext": "Most recent relevant context about this person"
  }
]

Include up to 15 people, ranked by importance to this person's life.
Only include people with enough context to understand the relationship.`;

  return await callGPTForModelBuild(prompt, apiKey);
}

async function extractLifeStateFromJournals(journals, apiKey) {
  const allContent = sampleJournals(journals, 40).map(j => `[${j.date}]\n${j.content}`).join('\n\n---\n\n');
  const recentContent = journals.slice(-15).map(j => `[${j.date}]\n${j.content}`).join('\n\n---\n\n');
  
  const prompt = `You are building a DEEP, INTERCONNECTED model of someone's life.

FULL JOURNAL HISTORY (for context):
${allContent}

RECENT JOURNALS (for current state):
${recentContent}

Build an interconnected life model. Return ONLY valid JSON:

{
  "coreDesires": [
    {
      "core": "The fundamental desire",
      "why": "Why this matters to them",
      "manifestsAs": ["How this shows up"],
      "tension": "What conflicts with this"
    }
  ],
  
  "situations": [
    {
      "title": "Short title",
      "context": "Full description",
      "type": "current|recurring|evolving",
      "emotionalWeight": 1-10,
      "linkedPeople": ["Names"],
      "currentPhase": "Where they are now",
      "narrativeArc": "The story arc"
    }
  ],
  
  "goals": [
    {
      "title": "Goal title",
      "description": "What they want to achieve",
      "status": "active|paused|blocked",
      "priority": 1-10,
      "blockers": ["What's in the way"],
      "linkedDesires": ["Which desires drive this"]
    }
  ],
  
  "upcomingMilestones": [
    {
      "date": "YYYY-MM-DD",
      "description": "What milestone",
      "stakes": "Why it matters",
      "backstory": "Context"
    }
  ]
}

Extract EVERYTHING meaningful. Be specific with names, dates, details.`;

  return await callGPTForModelBuild(prompt, apiKey);
}

async function detectPatternsFromJournals(journals, apiKey, existingContext) {
  const content = sampleJournals(journals, 50).map(j => `[${j.date}]\n${j.content}`).join('\n\n---\n\n');
  
  const prompt = `Analyze these journal entries to find BEHAVIORAL PATTERNS.

JOURNALS:
${content}

KNOWN CONTEXT:
- Key People: ${Array.isArray(existingContext.keyPeople) ? existingContext.keyPeople.map(p => p.name).join(', ') : 'None'}
- Situations: ${Array.isArray(existingContext.lifeState?.situations) ? existingContext.lifeState.situations.map(s => s.title).join(', ') : 'None'}

Find patterns that appear MULTIPLE TIMES (minimum 3 observations).

Return ONLY valid JSON array:
[
  {
    "claim": "Clear pattern statement",
    "domain": "emotional|behavioral|relational|productivity|health|creative",
    "observations": number of times observed,
    "confidence": 0.0-1.0,
    "evidence": ["Date: what happened"],
    "actionableInsight": "What they can do with this"
  }
]

Maximum 12 patterns, prioritized by usefulness.`;

  return await callGPTForModelBuild(prompt, apiKey);
}

async function extractEmotionalBaseline(journals, apiKey) {
  const content = sampleJournals(journals, 30).map(j => `[${j.date}]\n${j.content}`).join('\n\n---\n\n');
  
  const prompt = `Analyze these journal entries to understand this person's emotional baseline.

JOURNALS:
${content}

Return ONLY valid JSON:
{
  "averageMood": -10 to 10,
  "averageEnergy": 0-10,
  "dominantEmotions": ["emotion1", "emotion2", "emotion3"],
  "positiveTriggers": ["What lifts their mood"],
  "negativeTriggers": ["What brings them down"]
}`;

  return await callGPTForModelBuild(prompt, apiKey);
}

async function extractLifeEvents(journals, apiKey) {
  const content = journals.map(j => `[${j.date}]\n${j.content.substring(0, 300)}`).join('\n\n');
  
  const prompt = `Scan these journal entries for SIGNIFICANT LIFE EVENTS.

JOURNALS:
${content}

Find major events: milestones, turning points, challenges, breakthroughs.

Return ONLY valid JSON array:
[
  {
    "date": "YYYY-MM-DD",
    "description": "What happened",
    "category": "milestone|challenge|insight|turning_point",
    "impact": "How it affected them"
  }
]

Maximum 20 events, most significant only.`;

  return await callGPTForModelBuild(prompt, apiKey);
}

function sampleJournals(journals, maxCount) {
  if (journals.length <= maxCount) return journals;
  
  const first = journals.slice(0, Math.floor(maxCount / 3));
  const last = journals.slice(-Math.floor(maxCount / 3));
  const middle = journals.slice(Math.floor(maxCount / 3), -Math.floor(maxCount / 3));
  const randomMiddle = middle.sort(() => Math.random() - 0.5).slice(0, maxCount - first.length - last.length);
  
  return [...first, ...randomMiddle, ...last].sort((a, b) => 
    new Date(a.date).getTime() - new Date(b.date).getTime()
  );
}

async function callGPTForModelBuild(prompt, apiKey) {
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [
          { role: 'system', content: 'You are a precise analyst. Return ONLY valid JSON. No markdown, no explanation.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3,
        max_tokens: 3000
      })
    });
    
    if (!response.ok) {
      throw new Error(`OpenAI API failed: ${response.status}`);
    }
    
    const data = await response.json();
    const text = data.choices[0].message.content;
    const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(clean);
    
  } catch (error) {
    console.error('[MODEL BUILD] GPT call failed:', error);
    return null;
  }
}

// Automatic nightly processing scheduler (runs at 2 AM PST)
function scheduleNightlyProcessing() {
  const now = new Date();
  const target = new Date();
  target.setUTCHours(10, 0, 0, 0); // 2 AM PST = 10 AM UTC
  
  // If it's already past 2 AM today, schedule for tomorrow
  if (now.getTime() > target.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  
  const msUntilTarget = target.getTime() - now.getTime();
  
  console.log(`⏰ [NIGHTLY] Scheduled next processing for ${target.toISOString()}`);
  
  setTimeout(async () => {
    await runNightlyProcessing();
    
    // Schedule the next run (24 hours later)
    scheduleNightlyProcessing();
  }, msUntilTarget);
}

// Main nightly processing routine
async function runNightlyProcessing() {
  console.log('🌙 [NIGHTLY] Starting automatic nightly processing...');
  
  const openAIKey = process.env.OPENAI_API_KEY;
  
  try {
    // Step 1: Check if initial model exists, build if not
    const modelFile = path.join(__dirname, 'initial-model-build.json');
    const modelExists = fs.existsSync(modelFile);
    
    if (!modelExists) {
      console.log('🏗️ [NIGHTLY] No model found - checking if we have enough journals...');
      
      let storedJournals = {};
      if (fs.existsSync(JOURNALS_FILE)) {
        storedJournals = JSON.parse(fs.readFileSync(JOURNALS_FILE, 'utf8'));
      }
      
      const journalDates = Object.keys(storedJournals).sort();
      
      if (journalDates.length >= 5 && openAIKey) {
        console.log(`🏗️ [NIGHTLY] Building initial model from ${journalDates.length} days of journals...`);
        
        // Build the model
        const journals = [];
        for (const date of journalDates) {
          const entries = storedJournals[date];
          if (entries && entries.length > 0) {
            const combinedContent = entries.map(e => e.content).join('\n\n');
            journals.push({ date, content: combinedContent });
          }
        }
        
        const result = {
          identity: null,
          keyPeople: [],
          lifeState: null,
          patterns: [],
          emotionalBaseline: null,
          lifeEvents: [],
          meta: {
            journalsProcessed: journals.length,
            dateRange: { start: journalDates[0], end: journalDates[journalDates.length - 1] },
            builtAt: new Date().toISOString()
          }
        };
        
        // Sequential extraction - no rush at 2 AM
        console.log('🏗️ [NIGHTLY] Phase 1: Extracting identity...');
        result.identity = await extractIdentityFromJournals(journals, openAIKey);
        
        console.log('🏗️ [NIGHTLY] Phase 2: Extracting key people...');
        result.keyPeople = await extractKeyPeopleFromJournals(journals, openAIKey);
        
        console.log('🏗️ [NIGHTLY] Phase 3: Extracting life state...');
        result.lifeState = await extractLifeStateFromJournals(journals, openAIKey);
        
        console.log('🏗️ [NIGHTLY] Phase 4: Detecting patterns...');
        result.patterns = await detectPatternsFromJournals(journals, openAIKey, result);
        
        console.log('🏗️ [NIGHTLY] Phase 5: Calculating emotional baseline...');
        result.emotionalBaseline = await extractEmotionalBaseline(journals, openAIKey);
        
        console.log('🏗️ [NIGHTLY] Phase 6: Extracting life events...');
        result.lifeEvents = await extractLifeEvents(journals, openAIKey);
        
        // Save the model
        fs.writeFileSync(modelFile, JSON.stringify(result, null, 2));
        
        console.log(`✅ [NIGHTLY] Initial model built! Identity: ${!!result.identity}, People: ${result.keyPeople?.length || 0}, Patterns: ${result.patterns?.length || 0}`);
        
        // Send notification
        if (server.deviceTokens.length > 0) {
          await server.sendImmediateNotification(
            '🧠 Aurora Model Ready',
            `Built your personalized AI model from ${journals.length} days of journals.`
          );
        }
      } else {
        console.log(`⚠️ [NIGHTLY] Can't build model yet - need 5+ days of journals (have ${journalDates.length}) and OpenAI key`);
      }
    }
    
    // Step 2: Process yesterday's journals (incremental daily processing)
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];
    
    let storedJournals = {};
    if (fs.existsSync(JOURNALS_FILE)) {
      storedJournals = JSON.parse(fs.readFileSync(JOURNALS_FILE, 'utf8'));
    }
    
    const journalsForYesterday = storedJournals[yesterdayStr] || [];
    
    if (journalsForYesterday.length > 0) {
      console.log(`📊 [NIGHTLY] Processing ${journalsForYesterday.length} journals for ${yesterdayStr}`);
      await processJournalsForDate(yesterdayStr, journalsForYesterday);
    } else {
      console.log(`📝 [NIGHTLY] No journals found for ${yesterdayStr}`);
    }
    
    // Step 3: Generate suggestions
    if (openAIKey) {
      console.log('💡 [NIGHTLY] Generating suggestions...');
      await generateDailySuggestions(yesterdayStr, openAIKey);
    }
    
    console.log('✅ [NIGHTLY] Nightly processing complete');
    
  } catch (error) {
    console.error('❌ [NIGHTLY] Error in nightly processing:', error);
  }
}

// Generate hypothesis, narrative, and question suggestions
async function generateDailySuggestions(date, apiKey) {
  try {
    const resultsFile = path.join(__dirname, 'processing-results.json');
    if (!fs.existsSync(resultsFile)) return;
    
    let allResults = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
    const todayResult = allResults[date];
    
    if (!todayResult || !todayResult.fullExtractions) {
      console.log('⚠️ [SUGGESTIONS] No extractions found for suggestions');
      return;
    }
    
    const historicalData = getHistoricalProcessingData(date, 14);
    
    // Sequential - no rush
    console.log('💡 [SUGGESTIONS] Generating hypothesis suggestions...');
    const hypothesisSuggestions = await generateHypothesisSuggestions(todayResult.fullExtractions, historicalData, apiKey);
    
    console.log('💡 [SUGGESTIONS] Generating narrative suggestions...');
    const narrativeSuggestions = await generateNarrativeSuggestions(todayResult.fullExtractions, historicalData, apiKey);
    
    console.log('💡 [SUGGESTIONS] Generating smart questions...');
    const smartQuestions = await generateSmartQuestions(todayResult.fullExtractions, historicalData, apiKey);
    
    // Update result
    allResults[date].hypothesisSuggestions = hypothesisSuggestions;
    allResults[date].narrativeSuggestions = narrativeSuggestions;
    allResults[date].smartQuestions = smartQuestions;
    allResults[date].suggestionsGeneratedAt = new Date().toISOString();
    
    fs.writeFileSync(resultsFile, JSON.stringify(allResults, null, 2));
    
    console.log(`✅ [SUGGESTIONS] Generated: ${hypothesisSuggestions?.length || 0} hypotheses, ${narrativeSuggestions?.length || 0} narratives, ${smartQuestions?.length || 0} questions`);
    
  } catch (error) {
    console.error('❌ [SUGGESTIONS] Failed:', error);
  }
}

// Generate hypothesis suggestions for frontend
async function generateHypothesisSuggestions(extractions, historicalData, apiKey) {
  const historicalSummary = historicalData.slice(-7).map(d => ({
    date: d.date,
    mood: d.overallMood,
    energy: d.energyLevel,
    goals: d.extractedGoals,
    patterns: d.crossDayPatterns?.slice(0, 2)
  }));
  
  const prompt = `Based on this journal analysis, suggest behavioral hypotheses worth testing.

TODAY'S EXTRACTIONS:
${JSON.stringify(extractions, null, 2)}

RECENT HISTORY:
${JSON.stringify(historicalSummary, null, 2)}

Generate 3-5 TESTABLE behavioral hypotheses. Return ONLY valid JSON array:
[
  {
    "claim": "Clear, testable behavioral claim",
    "summary": "One sentence summary",
    "domain": "emotional|behavioral|relational|productivity|health|creative",
    "initialEvidence": {
      "date": "YYYY-MM-DD",
      "excerpt": "Evidence from journals",
      "strength": 0.0-1.0
    },
    "testableBy": "How to test this hypothesis",
    "confidence": 0.0-1.0
  }
]

Focus on:
- Triggers (what causes specific states)
- Conditions (when things work vs don't)
- Cascading effects (small actions → big results)
- Time-of-day patterns`;

  try {
    const result = await callGPTForModelBuild(prompt, apiKey);
    return Array.isArray(result) ? result : [];
  } catch (error) {
    console.error('Hypothesis generation failed:', error);
    return [];
  }
}

// Generate narrative suggestions for frontend
async function generateNarrativeSuggestions(extractions, historicalData, apiKey) {
  // Find recurring people/situations
  const allPeople = [];
  const allSituations = [];
  
  for (const day of historicalData) {
    if (day.fullExtractions?.relationshipMentions) {
      allPeople.push(...day.fullExtractions.relationshipMentions);
    }
    if (day.fullExtractions?.situations) {
      allSituations.push(...day.fullExtractions.situations);
    }
  }
  
  // Count mentions
  const peopleCounts = {};
  for (const p of allPeople) {
    peopleCounts[p.name] = (peopleCounts[p.name] || 0) + 1;
  }
  
  const recurringPeople = Object.entries(peopleCounts)
    .filter(([_, count]) => count >= 3)
    .map(([name, count]) => ({ name, mentions: count }));
  
  const prompt = `Based on this journal analysis, suggest topics that need deep narrative building.

RECURRING PEOPLE (3+ mentions):
${JSON.stringify(recurringPeople, null, 2)}

RECENT SITUATIONS:
${JSON.stringify(allSituations.slice(-10), null, 2)}

TODAY'S RELATIONSHIPS:
${JSON.stringify(extractions.relationshipMentions, null, 2)}

Suggest 2-4 topics that would benefit from a comprehensive narrative. Return ONLY valid JSON array:
[
  {
    "topic": "Topic name (person or situation)",
    "type": "person|situation|theme",
    "importance": 1-10,
    "suggestedNarrativePrompt": "Question to build narrative around",
    "knownContext": ["What we already know"],
    "gaps": ["What's missing from the story"]
  }
]`;

  try {
    const result = await callGPTForModelBuild(prompt, apiKey);
    return Array.isArray(result) ? result : [];
  } catch (error) {
    console.error('Narrative suggestion failed:', error);
    return [];
  }
}

// Generate smart questions for frontend
async function generateSmartQuestions(extractions, historicalData, apiKey) {
  const recentMoods = historicalData.slice(-5).map(d => ({
    date: d.date,
    mood: d.overallMood,
    themes: d.fullExtractions?.keyEvents?.slice(0, 2)
  }));
  
  const prompt = `Based on this journal analysis, generate thoughtful questions for reflection.

TODAY'S EXTRACTIONS:
${JSON.stringify(extractions, null, 2)}

RECENT MOOD TRAJECTORY:
${JSON.stringify(recentMoods, null, 2)}

Generate 5 open-ended questions that would prompt meaningful reflection. Return ONLY valid JSON array:
[
  {
    "text": "The question itself",
    "description": "Why this question matters now",
    "category": "reflection|planning|relationship|emotion|goal|pattern",
    "relevanceScore": 0.0-1.0,
    "basedOn": "What triggered this question"
  }
]

Questions should:
- Be specific to their current situation
- Prompt genuine reflection (not yes/no answers)
- Connect to recent patterns or events
- Help them gain clarity on something`;

  try {
    const result = await callGPTForModelBuild(prompt, apiKey);
    return Array.isArray(result) ? result : [];
  } catch (error) {
    console.error('Smart questions generation failed:', error);
    return [];
  }
}

// Start HTTP server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Notification API running on http://0.0.0.0:${PORT}`);
  console.log('📱 Endpoints:');
  console.log(`   POST /register-device - Register device token`);
  console.log(`   POST /send-test - Send test notification`);
  console.log(`   POST /send-notification - Send custom notification`);
  console.log(`   POST /ai-notification - Send AI message as notification`);
  console.log(`   POST /schedule-reminder - Schedule a future reminder`);
  console.log(`   POST /cancel-reminder - Cancel a scheduled reminder`);
  console.log(`   GET  /reminders - List all reminders`);
  console.log(`   POST /sync-tasks - Sync tasks/reminders for notifications`);
  console.log(`   POST /sync-journals - Sync journal data for nightly processing`);
  console.log(`   POST /sync-conversations - Sync conversation data for processing`);
  console.log(`   POST /initialize-week - Initialize with a week's worth of journals`);
  console.log(`   POST /process-day - Manually trigger processing for a specific date`);
  console.log(`   GET  /processing-stats - Get nightly processing statistics`);
  console.log(`   GET  /processing-results - Get processing results for frontend`);
  console.log(`   GET  /health - Check server status`);
  
  // Note: Old nightly processing disabled - CRS handles this now
  // scheduleNightlyProcessing(); // DISABLED - using HorizonCRSService instead
});

// Start checking for task reminders
server.start();

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down gracefully...');
  server.stop();
  apnProvider.shutdown();
  process.exit(0);
});

// Export for use in other modules if needed
export default TaskNotificationServer;