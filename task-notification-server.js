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
const app = express();
const PORT = process.env.PORT || 3001;

// Enable trust proxy for Railway
app.set('trust proxy', 1);

app.use(cors());
app.use(express.json());

// Create notification server instance
const server = new TaskNotificationServer();

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

// Store journal data for nightly processing
app.post('/sync-journals', (req, res) => {
  const { journals, date, isInitialSync = false } = req.body;
  
  if (!journals || !date) {
    return res.status(400).json({ error: 'Journals array and date required' });
  }
  
  try {
    // Load existing journal data
    let storedJournals = {};
    if (fs.existsSync(JOURNALS_FILE)) {
      storedJournals = JSON.parse(fs.readFileSync(JOURNALS_FILE, 'utf8'));
    }
    
    // Store journals by date
    storedJournals[date] = journals;
    
    fs.writeFileSync(JOURNALS_FILE, JSON.stringify(storedJournals, null, 2));
    
    if (isInitialSync) {
      console.log(`📚 [NIGHTLY] Initial sync: Stored ${journals.length} journals for ${date}`);
    } else {
      console.log(`📝 [NIGHTLY] Synced ${journals.length} journals for ${date}`);
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

// Initialize with a week's worth of journals (called manually)
app.post('/initialize-week', async (req, res) => {
  const { journalsByDate } = req.body;
  
  if (!journalsByDate || typeof journalsByDate !== 'object') {
    return res.status(400).json({ error: 'journalsByDate object required with date keys and journal arrays as values' });
  }
  
  try {
    // Store all journals from the past week
    fs.writeFileSync(JOURNALS_FILE, JSON.stringify(journalsByDate, null, 2));
    
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
    const analysisPrompt = buildPatternAnalysisPrompt(currentExtractions, currentDate, historicalData);
    
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

// Build comprehensive pattern analysis prompt
function buildPatternAnalysisPrompt(currentExtractions, currentDate, historicalData) {
  const prompt = `CROSS-DAY BEHAVIORAL PATTERN ANALYSIS

You are analyzing behavioral patterns across time. Today's data plus ${historicalData.length} days of historical data.

CURRENT DAY (${currentDate}):
${JSON.stringify(currentExtractions, null, 2)}

HISTORICAL DATA (last ${historicalData.length} days):
${historicalData.map(day => `
Date: ${day.date}
Goals: ${day.extractedGoals} | Situations: ${day.extractedSituations} | Mood: ${day.overallMood} | Energy: ${day.energyLevel} | Productivity: ${day.productivityLevel}
Locations: ${day.fullExtractions?.goals?.map(g => g.evidence?.match(/at|in|from ([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)/)?.[1])?.filter(Boolean)?.join(', ') || 'unknown'}
Key themes: ${day.fullExtractions?.keyEvents?.slice(0, 2)?.join('; ') || 'none'}
`).join('\n')}

ANALYSIS OBJECTIVES:
Find ACTIONABLE behavioral correlations that can optimize performance, mood, and decision-making.

Look for these pattern types:
1. TEMPORAL CORRELATIONS (what predicts what)
2. LOCATION PATTERNS (where performance/mood peaks)
3. SOCIAL AMPLIFIERS (people/interactions that boost outcomes)
4. HABIT CASCADES (one behavior triggering others)
5. EMOTIONAL CYCLES (mood patterns and triggers)
6. PRODUCTIVITY OPTIMIZERS (conditions for peak performance)
7. ENERGY MANAGEMENT (what drains vs. energizes)
8. GOAL ACHIEVEMENT PATTERNS (what leads to progress)

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
- Only include patterns with strong evidence (confidence > 0.6)
- Focus on ACTIONABLE insights, not just observations
- Look for causal relationships, not just coincidences
- Consider multi-day lag effects (mood today affecting performance tomorrow)
- Include quantitative evidence when possible
- Maximum 10 patterns, prioritize by impact and actionability

EXAMPLE GOOD PATTERNS:
✅ "Gym sessions followed by 40% higher productivity scores the next day (correlation: 0.85, observed 8/10 times)"
✅ "Coffee shop journaling correlates with 2x more breakthrough insights than home (correlation: 0.78)"
✅ "Calls with Sarah precede mood improvements by 1-2 days (correlation: 0.71, observed 6/8 times)"

BAD PATTERNS (too vague):
❌ "Sometimes feels better after exercise"
❌ "Likes coffee shops"
❌ "Social interactions are good"`;

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

// Automatic nightly processing scheduler (runs at 2 AM)
function scheduleNightlyProcessing() {
  const now = new Date();
  const target = new Date();
  target.setHours(2, 0, 0, 0); // 2 AM
  
  // If it's already past 2 AM today, schedule for tomorrow
  if (now.getTime() > target.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  
  const msUntilTarget = target.getTime() - now.getTime();
  
  console.log(`⏰ [NIGHTLY] Scheduled next processing for ${target.toISOString()}`);
  
  setTimeout(async () => {
    console.log('🌙 [NIGHTLY] Starting automatic nightly processing...');
    
    try {
      // Get yesterday's date
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().split('T')[0];
      
      // Load journals for yesterday
      let storedJournals = {};
      if (fs.existsSync(JOURNALS_FILE)) {
        storedJournals = JSON.parse(fs.readFileSync(JOURNALS_FILE, 'utf8'));
      }
      
      const journalsForYesterday = storedJournals[yesterdayStr] || [];
      
      if (journalsForYesterday.length > 0) {
        await processJournalsForDate(yesterdayStr, journalsForYesterday);
      } else {
        console.log(`📝 [NIGHTLY] No journals found for ${yesterdayStr}`);
      }
    } catch (error) {
      console.error('Error in automatic nightly processing:', error);
    }
    
    // Schedule the next run (24 hours later)
    scheduleNightlyProcessing();
  }, msUntilTarget);
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
  console.log(`   POST /initialize-week - Initialize with a week's worth of journals`);
  console.log(`   POST /process-day - Manually trigger processing for a specific date`);
  console.log(`   GET  /processing-stats - Get nightly processing statistics`);
  console.log(`   GET  /health - Check server status`);
  
  // Start nightly processing scheduler
  scheduleNightlyProcessing();
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