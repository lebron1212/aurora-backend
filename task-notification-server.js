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

class TaskNotificationServer {
  constructor() {
    this.deviceTokens = this.loadDeviceTokens();
    this.checkInterval = null;
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

  start() {
    console.log('🚀 Task Notification Server started');
    
    // Initial check
    this.checkAndSendReminders();
    
    // Set up recurring check
    this.checkInterval = setInterval(() => {
      this.checkAndSendReminders();
    }, this.POLL_INTERVAL);
  }

  stop() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      console.log('🛑 Task Notification Server stopped');
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

// Start HTTP server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Notification API running on http://0.0.0.0:${PORT}`);
  console.log('📱 Endpoints:');
  console.log(`   POST /register-device - Register device token`);
  console.log(`   POST /send-test - Send test notification`);
  console.log(`   POST /send-notification - Send custom notification`);
  console.log(`   POST /sync-tasks - Sync tasks/reminders for notifications`);
  console.log(`   GET  /health - Check server status`);
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