/**
 * Night Owl Service
 * 
 * Autonomous background intelligence that works on life threads while you sleep.
 * 
 * CAPABILITIES:
 * 
 * 1. LIFE THREAD PROCESSING
 *    - Research: "Planning Alaska trip" → destinations, activities, logistics
 *    - Decisions: "Should I take the job?" → weighs against values/patterns
 *    - Preparation: "Talk to Sarah about X" → approaches, anticipation
 * 
 * 2. ANTICIPATORY PREP
 *    - Tomorrow's calendar → pulls context on people, life threads
 *    - Upcoming birthdays → gift ideas based on relationship knowledge
 *    - Upcoming trips → logistics, packing, things you mentioned
 * 
 * 3. PATTERN SURFACING
 *    - Behavioral patterns from journal/facts
 *    - Health correlations (sleep vs mood, exercise vs productivity)
 *    - Relationship dynamics
 * 
 * 4. SMART REMINDERS
 *    - "Thank you note for yesterday's interview"
 *    - "Follow up on conversation with Mike"
 *    - Context-aware, not just time-based
 * 
 * 5. LEARNING SYNTHESIS
 *    - Connects things you're reading/learning
 *    - Identifies gaps in understanding
 *    - Links learning to goals
 * 
 * 6. ACCOUNTABILITY
 *    - "You said you'd decide by Friday"
 *    - "Day 12 of no progress on book outline"
 *    - Gentle, not nagging
 * 
 * 7. CONNECTION FINDING
 *    - Links insights across domains
 *    - "What your therapist said connects to pattern with brother"
 * 
 * 8. HEALTH CORRELATIONS
 *    - Sleep vs mood patterns
 *    - Exercise vs energy levels
 *    - Requires HealthKit data synced to Supabase
 * 
 * Uses Claude API with web search for research-backed insights.
 * Queues results for natural delivery in conversation.
 */

import Anthropic from '@anthropic-ai/sdk';

// ============================================================================
// TYPES
// ============================================================================

/**
 * @typedef {Object} LifeThread
 * @property {string} id
 * @property {string} title
 * @property {string} category - career|relationship|health|finance|creative|logistics|goal|waiting
 * @property {string} status - Current situation summary
 * @property {string} currentContext - Detailed current state
 * @property {number} emotionalWeight - 1-10
 * @property {string[]} [relatedEntities]
 * @property {boolean} resolved
 */

/**
 * @typedef {Object} NightOwlInsight
 * @property {string} id
 * @property {string} threadId
 * @property {string} threadTitle
 * @property {string} insightType - research|perspective|suggestion|preparation
 * @property {string} content - The actual insight/research
 * @property {string} conversationHook - Natural way to bring it up
 * @property {string[]} sources - URLs if web research was used
 * @property {number} createdAt
 * @property {string} status - pending|delivered|dismissed
 * @property {StagedAction[]} [stagedActions] - Suggested actions for main service to execute
 */

/**
 * @typedef {Object} StagedAction
 * @property {string} id
 * @property {'create_note'|'add_calendar_event'|'update_thread'|'resolve_thread'|'create_thread'|'add_fact'} type
 * @property {Object} payload - Data needed to execute the action
 * @property {string} description - Human-readable description of what this action does
 * @property {boolean} requiresApproval - If true, user must explicitly approve
 * @property {'pending'|'approved'|'executed'|'rejected'} status
 */

/**
 * @typedef {Object} UserContext
 * @property {Object} selfIdentity
 * @property {Array} relevantFacts
 * @property {Array} relevantEntities
 * @property {Array} patterns
 */

/**
 * @typedef {Object} NightOwlSettings
 * @property {boolean} enabled - Master switch
 * @property {boolean} autonomousProcessing - Process threads, patterns automatically
 * @property {boolean} processQueuedOnly - Only process user-requested analyses
 * @property {boolean} notificationsEnabled
 * @property {'immediate'|'morning'} notificationTiming
 * @property {number} morningHour - When to send morning notification
 * @property {number} maxInsightsPerNight
 * @property {number|null} lastProcessedAt
 * @property {number|null} pausedUntil
 */

const DEFAULT_SETTINGS = {
  enabled: true,
  autonomousProcessing: false,  // DISABLED - saves $$$, only process queued research
  processQueuedOnly: true,       // ENABLED - only user-requested research
  notificationsEnabled: true,
  notificationTiming: 'morning',
  morningHour: 6,
  maxInsightsPerNight: 5,        // Reduced from 10
  lastProcessedAt: null,
  pausedUntil: null
};

// Web search tool definition - API requires both name and type fields
const WEB_SEARCH_TOOL = { type: 'web_search_20250305', name: 'web_search' };

// ============================================================================
// NIGHT OWL SERVICE
// ============================================================================

class NightOwlService {
  constructor(crsService, config = {}) {
    this.crsService = crsService;
    this.anthropicApiKey = config.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
    this.maxThreadsPerRun = config.maxThreadsPerRun || 3;
    this.minEmotionalWeight = config.minEmotionalWeight || 5; // Process threads with weight >= 5
    this.settings = DEFAULT_SETTINGS;
    
    // In-memory queue cache to avoid Supabase sync latency issues
    this.queueCache = null;
    this.queueCacheTime = 0;
    
    // Processing lock to prevent concurrent research runs (which cost $$$)
    this.isProcessing = false;
    this.processingStartTime = null;
    this.processingLockTimeout = 10 * 60 * 1000; // 10 minutes max lock

    if (!this.anthropicApiKey) {
      console.warn('⚠️ [NightOwl] ANTHROPIC_API_KEY not set. Night Owl will be disabled.');
    }

    this.anthropic = this.anthropicApiKey ? new Anthropic({
      apiKey: this.anthropicApiKey
    }) : null;
  }
  
  /**
   * Check if processing is locked (with automatic timeout release)
   */
  isProcessingLocked() {
    if (!this.isProcessing) return false;
    
    // Auto-release lock if it's been held too long (safeguard against stuck processes)
    if (this.processingStartTime && (Date.now() - this.processingStartTime) > this.processingLockTimeout) {
      console.warn('⚠️ [NightOwl] Processing lock timed out after 10 minutes - releasing');
      this.isProcessing = false;
      this.processingStartTime = null;
      return false;
    }
    
    return true;
  }
  
  /**
   * Acquire processing lock
   * @returns {boolean} true if lock acquired, false if already locked
   */
  acquireProcessingLock() {
    if (this.isProcessingLocked()) {
      const elapsed = this.processingStartTime ? Math.round((Date.now() - this.processingStartTime) / 1000) : 0;
      console.log(`🔒 [NightOwl] Processing already in progress (${elapsed}s elapsed) - blocking duplicate`);
      return false;
    }
    
    this.isProcessing = true;
    this.processingStartTime = Date.now();
    console.log('🔓 [NightOwl] Acquired processing lock');
    return true;
  }
  
  /**
   * Release processing lock
   */
  releaseProcessingLock() {
    const elapsed = this.processingStartTime ? Math.round((Date.now() - this.processingStartTime) / 1000) : 0;
    this.isProcessing = false;
    this.processingStartTime = null;
    console.log(`🔓 [NightOwl] Released processing lock (was held for ${elapsed}s)`);
  }

  // ============================================================================
  // SETTINGS MANAGEMENT
  // ============================================================================

  async initialize() {
    await this.loadSettings();
  }

  async loadSettings() {
    try {
      const saved = await this.crsService.readFile('system/nightowl/settings.json');
      this.settings = { ...DEFAULT_SETTINGS, ...saved };
    } catch {
      this.settings = DEFAULT_SETTINGS;
    }
    return this.settings;
  }

  async saveSettings(updates) {
    this.settings = { ...this.settings, ...updates };
    await this.crsService.writeFile('system/nightowl/settings.json', this.settings);
    return this.settings;
  }

  /**
   * Disable autonomous processing (only runs queued at 2 AM)
   */
  async disableAutonomous() {
    await this.saveSettings({
      autonomousProcessing: false,
      pausedUntil: null
    });
    console.log('🦉 [NightOwl] Autonomous processing disabled. Only queued requests will run at 2 AM.');
  }

  /**
   * Enable autonomous processing (full processing at 2 AM)
   */
  async enableAutonomous() {
    await this.saveSettings({
      autonomousProcessing: true,
      pausedUntil: null
    });
    console.log('🦉 [NightOwl] Autonomous processing enabled. Full processing will run at 2 AM.');
  }

  /**
   * Check if we should run autonomous processors
   * Only used by processAll() which runs at 2 AM
   */
  shouldRunAutonomous() {
    if (!this.settings.enabled) return false;
    if (!this.settings.autonomousProcessing) return false;
    if (this.settings.pausedUntil && Date.now() < this.settings.pausedUntil) return false;
    return true;
  }

  // ============================================================================
  // CONTEXT DOCUMENT MANAGEMENT
  // ============================================================================

  /**
   * Get the context document
   */
  async getContextDocument() {
    try {
      const doc = await this.crsService.readFile('system/nightowl/context-document.json');
      return doc;
    } catch {
      return null;
    }
  }

  /**
   * Create default context document
   */
  createDefaultContextDocument() {
    return {
      id: `ctx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      version: 1,
      primaryDirective: '',
      sections: [],
      focusAreas: [],
      avoidTopics: [],
      preferredInsightTypes: ['actionable', 'reflective'],
      tone: 'balanced',
      depth: 'moderate',
      frequency: 'moderate',
      // Clear behavior settings
      clearDirectiveAfterUse: false,  // Clear primary directive after Night Owl runs
      clearFocusAreasAfterUse: false, // Clear focus areas after use
      clearAvoidTopicsAfterUse: false, // Clear avoid topics after use
      lastSentAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
  }

  /**
   * Save context document
   */
  async saveContextDocument(updates) {
    let doc = await this.getContextDocument();

    if (!doc) {
      doc = this.createDefaultContextDocument();
    }

    // Merge updates
    const updated = {
      ...doc,
      ...updates,
      version: (doc.version || 0) + 1,
      updatedAt: Date.now()
    };

    // Preserve sections if not explicitly updated
    if (updates.sections === undefined && doc.sections) {
      updated.sections = doc.sections;
    }

    await this.crsService.writeFile('system/nightowl/context-document.json', updated);
    console.log(`📋 [NightOwl] Context document saved (v${updated.version})`);
    return updated;
  }

  /**
   * Add a section to the context document
   */
  async addContextSection(sectionData) {
    let doc = await this.getContextDocument();
    if (!doc) {
      doc = this.createDefaultContextDocument();
    }

    const section = {
      id: `sec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      title: sectionData.title,
      content: sectionData.content,
      priority: sectionData.priority || 'normal',
      category: sectionData.category || 'custom',
      enabled: sectionData.enabled !== false,
      clearAfterUse: sectionData.clearAfterUse || false,  // One-time instruction
      createdAt: Date.now(),
      updatedAt: Date.now(),
      createdBy: sectionData.createdBy || 'user'
    };

    if (!doc.sections) {
      doc.sections = [];
    }

    doc.sections.push(section);
    doc.updatedAt = Date.now();
    doc.version = (doc.version || 0) + 1;

    await this.crsService.writeFile('system/nightowl/context-document.json', doc);
    console.log(`📋 [NightOwl] Added section: "${section.title}"${section.clearAfterUse ? ' (one-time)' : ''}`);
    return section;
  }

  /**
   * Update a section
   */
  async updateContextSection(sectionId, updates) {
    const doc = await this.getContextDocument();
    if (!doc || !doc.sections) return null;

    const index = doc.sections.findIndex(s => s.id === sectionId);
    if (index === -1) return null;

    doc.sections[index] = {
      ...doc.sections[index],
      ...updates,
      id: sectionId,
      updatedAt: Date.now()
    };

    doc.updatedAt = Date.now();
    doc.version = (doc.version || 0) + 1;

    await this.crsService.writeFile('system/nightowl/context-document.json', doc);
    console.log(`📋 [NightOwl] Updated section: "${doc.sections[index].title}"`);
    return doc.sections[index];
  }

  /**
   * Remove a section
   */
  async removeContextSection(sectionId) {
    const doc = await this.getContextDocument();
    if (!doc || !doc.sections) return false;

    const index = doc.sections.findIndex(s => s.id === sectionId);
    if (index === -1) return false;

    const removed = doc.sections.splice(index, 1)[0];
    doc.updatedAt = Date.now();
    doc.version = (doc.version || 0) + 1;

    await this.crsService.writeFile('system/nightowl/context-document.json', doc);
    console.log(`🗑️ [NightOwl] Removed section: "${removed.title}"`);
    return true;
  }

  /**
   * Reset context document to defaults
   */
  async resetContextDocument() {
    const doc = this.createDefaultContextDocument();
    await this.crsService.writeFile('system/nightowl/context-document.json', doc);
    console.log(`🔄 [NightOwl] Context document reset to defaults`);
    return doc;
  }

  /**
   * Build the context string to send to Night Owl processing
   * This compiles the document into clear instructions and handles clearing
   */
  async buildContextInstructions() {
    const doc = await this.getContextDocument();
    if (!doc) return '';

    const lines = [];
    let needsSave = false;

    // Primary directive first
    if (doc.primaryDirective) {
      lines.push(`PRIMARY DIRECTIVE: ${doc.primaryDirective}`);
      lines.push('');

      // Clear if configured to do so
      if (doc.clearDirectiveAfterUse) {
        doc.primaryDirective = '';
        doc.clearDirectiveAfterUse = false;
        needsSave = true;
        console.log(`🧹 [NightOwl] Cleared primary directive after use`);
      }
    }

    // Focus areas
    if (doc.focusAreas?.length > 0) {
      lines.push(`FOCUS AREAS (prioritize these topics): ${doc.focusAreas.join(', ')}`);

      if (doc.clearFocusAreasAfterUse) {
        doc.focusAreas = [];
        doc.clearFocusAreasAfterUse = false;
        needsSave = true;
        console.log(`🧹 [NightOwl] Cleared focus areas after use`);
      }
    }

    // Avoid topics
    if (doc.avoidTopics?.length > 0) {
      lines.push(`AVOID TOPICS (do not surface insights about): ${doc.avoidTopics.join(', ')}`);

      if (doc.clearAvoidTopicsAfterUse) {
        doc.avoidTopics = [];
        doc.clearAvoidTopicsAfterUse = false;
        needsSave = true;
        console.log(`🧹 [NightOwl] Cleared avoid topics after use`);
      }
    }

    // Style preferences
    lines.push(`TONE: ${doc.tone || 'balanced'}`);
    lines.push(`ANALYSIS DEPTH: ${doc.depth || 'moderate'}`);
    lines.push(`INSIGHT FREQUENCY: ${doc.frequency || 'moderate'}`);

    // Process enabled sections by priority
    const enabledSections = (doc.sections || [])
      .filter(s => s.enabled)
      .sort((a, b) => {
        const priorityOrder = { critical: 0, high: 1, normal: 2, low: 3 };
        return (priorityOrder[a.priority] || 2) - (priorityOrder[b.priority] || 2);
      });

    // Track sections to remove after use
    const sectionsToRemove = [];

    if (enabledSections.length > 0) {
      lines.push('');
      lines.push('ADDITIONAL INSTRUCTIONS:');
      for (const section of enabledSections) {
        const priorityLabel = section.priority === 'critical' ? '[CRITICAL] ' :
          section.priority === 'high' ? '[HIGH] ' : '';
        const oneTimeLabel = section.clearAfterUse ? ' (one-time)' : '';
        lines.push(`${priorityLabel}${section.title}${oneTimeLabel}: ${section.content}`);

        // Mark for removal if it's a one-time section
        if (section.clearAfterUse) {
          sectionsToRemove.push(section.id);
        }
      }
    }

    // Remove one-time sections
    if (sectionsToRemove.length > 0) {
      doc.sections = doc.sections.filter(s => !sectionsToRemove.includes(s.id));
      needsSave = true;
      console.log(`🧹 [NightOwl] Cleared ${sectionsToRemove.length} one-time section(s) after use`);
    }

    // Update last sent timestamp
    doc.lastSentAt = Date.now();
    doc.updatedAt = Date.now();

    // Save if anything changed
    await this.crsService.writeFile('system/nightowl/context-document.json', doc);

    return lines.join('\n');
  }

  /**
   * Clear all context (full reset but keep style preferences)
   */
  async clearContextAfterRun() {
    const doc = await this.getContextDocument();
    if (!doc) return;

    // Clear content but keep style preferences
    doc.primaryDirective = '';
    doc.focusAreas = [];
    doc.avoidTopics = [];
    doc.sections = [];
    doc.updatedAt = Date.now();
    doc.version = (doc.version || 0) + 1;

    await this.crsService.writeFile('system/nightowl/context-document.json', doc);
    console.log(`🧹 [NightOwl] Cleared all context after run (kept style preferences)`);
    return doc;
  }

  // ============================================================================
  // MAIN PROCESSING
  // ============================================================================

  /**
   * Main entry point - called by backend at 2 AM
   * Processes both queued requests AND autonomous insights
   */
  async processAll() {
    await this.initialize();

    if (!this.settings.enabled) {
      console.log('🦉 [NightOwl] Disabled. Skipping.');
      return { success: true, insightCount: 0, skipped: true, reason: 'disabled' };
    }

    if (!this.anthropic) {
      console.log('🦉 [NightOwl] Skipping - no API key configured');
      return { success: true, insightCount: 0, skipped: true, reason: 'no_api_key' };
    }
    
    // Prevent concurrent processing (multiple triggers = $$$)
    if (!this.acquireProcessingLock()) {
      return { 
        success: false, 
        insightCount: 0, 
        skipped: true, 
        reason: 'already_processing',
        error: 'Night Owl is already processing. Please wait for the current run to complete.'
      };
    }

    console.log('🦉 [NightOwl] Starting nightly processing (2 AM batch)...');
    const startTime = Date.now();
    const allInsights = [];

    try {
      // Load context once
      const userContext = await this.getUserContext();
      const healthData = await this.getHealthData();
      const trackingData = await this.getTrackingDataFromStore();

      // ============================================================
      // PHASE 1: QUEUED REQUESTS (always process these first)
      // ============================================================
      const queuedInsights = await this.processQueuedRequests(userContext, healthData, trackingData);
      allInsights.push(...queuedInsights);

      // ============================================================
      // PHASE 2: AUTONOMOUS PROCESSING - DISABLED TO SAVE COSTS
      // ============================================================
      // Autonomous "insights" disabled - they cost $$$ and don't add value
      // Night Owl now only processes explicit research requests from queue
      console.log('🦉 [NightOwl] Autonomous processing permanently disabled (cost savings).');

      // ============================================================
      // PHASE 3: SAVE & NOTIFY
      // ============================================================

      // Dedupe by loopId (don't analyze same thing twice)
      const deduped = this.dedupeInsights(allInsights);

      // Save all insights
      for (const insight of deduped) {
        await this.saveInsight(insight);
      }

      // Update last processed
      await this.saveSettings({ lastProcessedAt: Date.now() });

      // Queue notification if insights generated
      if (deduped.length > 0 && this.settings.notificationsEnabled) {
        await this.queueNotification(deduped);
      }

      // ============================================================
      // PHASE 4: CLEAR CONTEXT DOCUMENT
      // ============================================================
      // Clear the context doc after processing so it's fresh for next time
      await this.clearContextAfterRun();

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`🦉 [NightOwl] Complete in ${elapsed}s. ${deduped.length} insights generated.`);

      this.releaseProcessingLock();
      return {
        success: true,
        insightCount: deduped.length,
        breakdown: {
          queued: queuedInsights.length,
          autonomous: deduped.length - queuedInsights.length
        },
        elapsed: parseFloat(elapsed)
      };

    } catch (error) {
      console.error('❌ [NightOwl] Processing failed:', error);
      this.releaseProcessingLock();
      return { success: false, error: error.message, insightCount: allInsights.length };
    }
  }

  /**
   * Process ONLY queued research requests - NO autonomous processing
   * Use this for on-demand/immediate processing triggered by user
   */
  async processQueuedOnly() {
    await this.initialize();

    if (!this.anthropic) {
      console.log('🦉 [NightOwl] Skipping - no API key configured');
      return { success: true, insightCount: 0, skipped: true, reason: 'no_api_key' };
    }
    
    // Prevent concurrent processing (multiple triggers = $$$)
    if (!this.acquireProcessingLock()) {
      return { 
        success: false, 
        insightCount: 0, 
        skipped: true, 
        reason: 'already_processing',
        error: 'Night Owl is already processing. Please wait for the current run to complete.'
      };
    }

    console.log('🦉 [NightOwl] Processing queued requests only (on-demand)...');
    const startTime = Date.now();

    try {
      // Load context
      const userContext = await this.getUserContext();
      const healthData = await this.getHealthData();
      const trackingData = await this.getTrackingDataFromStore();

      // Process ONLY queued requests - no autonomous
      const queuedInsights = await this.processQueuedRequests(userContext, healthData, trackingData);

      // Save insights
      for (const insight of queuedInsights) {
        await this.saveInsight(insight);
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`🦉 [NightOwl] Queued processing complete in ${elapsed}s. ${queuedInsights.length} insights generated.`);

      this.releaseProcessingLock();
      return {
        success: true,
        insightCount: queuedInsights.length,
        breakdown: {
          queued: queuedInsights.length,
          autonomous: 0
        },
        elapsed: parseFloat(elapsed)
      };

    } catch (error) {
      console.error('❌ [NightOwl] Queued processing failed:', error);
      this.releaseProcessingLock();
      return { success: false, error: error.message, insightCount: 0 };
    }
  }

  /**
   * Legacy method - calls processAll for backwards compatibility
   */
  async process() {
    return this.processAll();
  }

  // ============================================================================
  // QUEUED REQUEST PROCESSING
  // ============================================================================

  /**
   * Process user-queued requests from UnifiedTrackingStore
   */
  async processQueuedRequests(userContext, healthData, trackingData) {
    const insights = [];

    try {
      // Read queued requests (use cache)
      const queueFile = await this.getQueueFile();
      const queue = queueFile?.requests?.filter(r => r.status === 'pending') || [];

      if (queue.length === 0) {
        console.log('🦉 [NightOwl] No queued requests.');
        return insights;
      }

      console.log(`🦉 [NightOwl] Processing ${queue.length} queued requests...`);

      // Sort by priority
      const sorted = queue.sort((a, b) => {
        const priorityOrder = { high: 0, normal: 1, low: 2 };
        return priorityOrder[a.priority] - priorityOrder[b.priority];
      });

      for (const request of sorted) {
        try {
          console.log(`🦉 [NightOwl] Processing queued: "${request.request}" (${request.type})`);

          const insight = await this.processQueuedRequest(request, userContext, healthData, trackingData);

          if (insight) {
            insights.push(insight);

            // Mark request as completed
            request.status = 'completed';
            request.result = insight.content;
            request.completedAt = Date.now();
          } else {
            request.status = 'failed';
            request.error = 'No insight generated';
          }
        } catch (error) {
          console.error(`❌ [NightOwl] Failed to process queued request:`, error.message);
          request.status = 'failed';
          request.error = error.message;
        }
      }

      // Save updated queue and update cache
      const updatedQueue = {
        requests: queueFile?.requests || queue,
        lastProcessed: Date.now()
      };
      this.queueCache = updatedQueue;
      this.queueCacheTime = Date.now();
      await this.crsService.writeFile('system/nightowl/queue.json', updatedQueue);

    } catch (error) {
      console.error('❌ [NightOwl] Queue processing failed:', error.message);
    }

    return insights;
  }

  /**
   * Process a single queued request
   */
  async processQueuedRequest(request, userContext, healthData, trackingData) {

    // For research requests, use the iterative research system with depth
    if (request.type === 'research') {
      const depth = request.depth || 'standard';
      console.log(`🔬 [NightOwl] Using ${depth} research depth for: "${request.request}"`);
      
      // Create a pseudo-loop for the research system
      const researchLoop = {
        id: request.id,
        title: request.request,
        description: request.context || '',
        loopType: 'research',
        priority: request.priority === 'high' ? 1 : request.priority === 'low' ? 3 : 2,
        relatedEntityIds: []
      };
      
      return await this.doResearch(researchLoop, userContext, depth);
    }

    // Build data context based on requested sources
    const dataContext = this.buildDataContext(request.dataSources || ['all'], {
      userContext,
      healthData,
      trackingData
    });

    const systemPrompt = `You are Night Owl, an AI assistant that works overnight to analyze patterns and provide insights.

The user specifically asked you to: "${request.request}"

Provide a thoughtful, personalized analysis based on the data provided. Be:
- Insightful and specific (not generic)
- Connected to their actual life and patterns
- Actionable where appropriate
- Warm and supportive

This will be delivered in conversation, so write conversationally.`;

    const userPrompt = `Analyze this for the user:

REQUEST: ${request.request}
TYPE: ${request.type}
${request.context ? `ADDITIONAL CONTEXT: ${request.context}` : ''}
${request.dateRange ? `DATE RANGE: ${request.dateRange.start} to ${request.dateRange.end}` : ''}

DATA AVAILABLE:
${dataContext}

Please provide your analysis.`;

    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        tools: request.type === 'research' ? [WEB_SEARCH_TOOL] : [],
        messages: [{ role: 'user', content: userPrompt }],
        system: systemPrompt
      });

      const { text, sources } = this.extractResponseContent(response);

      return {
        id: this.generateId('queued_insight'),
        loopId: request.id,
        loopTitle: request.request,
        insightType: `queued_${request.type}`,
        content: text,
        conversationHook: this.generateQueuedHook(request),
        sources,
        isQueued: true,
        originalRequest: request,
        createdAt: Date.now(),
        status: 'pending'
      };

    } catch (error) {
      console.error(`❌ [NightOwl] Queued request analysis failed:`, error.message);
      return null;
    }
  }

  /**
   * Build data context string based on requested sources
   */
  buildDataContext(sources, data) {
    const { userContext, healthData, trackingData } = data;
    const parts = [];
    const includeAll = sources.includes('all');

    // User context / facts
    if (includeAll || sources.includes('facts') || sources.includes('context')) {
      if (userContext.relevantFacts?.length > 0) {
        parts.push('## Personal Context');
        parts.push(userContext.relevantFacts.slice(0, 15).map(f => `- ${f.content}`).join('\n'));
      }
      if (userContext.patterns?.length > 0) {
        parts.push('\n## Known Patterns');
        parts.push(userContext.patterns.map(p => `- ${p.claim}`).join('\n'));
      }
    }

    // Tracking data (metrics, habits)
    if (includeAll || sources.includes('tracking') || sources.includes('metrics') || sources.includes('habits')) {
      if (trackingData.available) {
        const { metrics, habits, activities } = trackingData;

        if (Object.keys(metrics).length > 0) {
          parts.push('\n## Tracked Metrics (30 days)');
          for (const [name, values] of Object.entries(metrics)) {
            const recent = values.slice(-14);
            const avg = recent.reduce((sum, v) => sum + v.value, 0) / recent.length;
            parts.push(`${name}: avg ${avg.toFixed(1)}, recent: ${recent.slice(-7).map(v => v.value).join(', ')}`);
          }
        }

        if (Object.keys(habits).length > 0) {
          parts.push('\n## Habit Tracking (30 days)');
          for (const [name, values] of Object.entries(habits)) {
            const recent = values.slice(-30);
            const completed = recent.filter(v => v.completed).length;
            parts.push(`${name}: ${completed}/${recent.length} days (${Math.round(completed / recent.length * 100)}%)`);
          }
        }

        if (activities.length > 0) {
          parts.push('\n## Recent Activities');
          parts.push(activities.slice(-10).map(a => `- ${a.date}: ${a.name}`).join('\n'));
        }
      }
    }

    // Health data
    if (includeAll || sources.includes('health')) {
      if (healthData.available) {
        if (healthData.sleep?.length > 0) {
          parts.push('\n## Sleep Data (7 days)');
          parts.push(healthData.sleep.slice(-7).map(s =>
            `${s.date}: ${s.duration}hrs, quality: ${s.quality || 'unknown'}`
          ).join('\n'));
        }
        if (healthData.steps?.length > 0) {
          parts.push('\n## Steps (7 days)');
          parts.push(healthData.steps.slice(-7).map(s => `${s.date}: ${s.count}`).join(', '));
        }
      }
    }

    // Journals
    if (includeAll || sources.includes('journals')) {
      // Would need to load journal entries - placeholder
      parts.push('\n## Journal Context');
      parts.push('(Journal entries would be loaded here)');
    }

    return parts.join('\n') || 'No data available for requested sources.';
  }

  generateQueuedHook(request) {
    const hooks = {
      analyze: `I finished that analysis you asked about — ${request.request.substring(0, 30)}...`,
      find_pattern: `I looked into patterns around ${request.request.substring(0, 30)}...`,
      question: `I researched that question — ${request.request.substring(0, 30)}...`,
      compare: `I compared what you asked about...`,
      focus: `I did a deep dive on ${request.request.substring(0, 30)}...`,
      research: `I researched ${request.request.substring(0, 30)}...`
    };
    return hooks[request.type] || `About that thing you asked me to look into...`;
  }

  // ============================================================================
  // QUEUE MANAGEMENT
  // ============================================================================

  /**
   * Queue a request for overnight processing
   * Called by Claude tool
   */
  async queueRequest(request) {
    const fullRequest = {
      ...request,
      id: this.generateId('req'),
      status: 'pending',
      createdAt: Date.now(),
      delivered: false
    };

    // Load existing queue (use cache if fresh)
    let queueFile = await this.getQueueFile();

    queueFile.requests.push(fullRequest);
    
    // Update cache immediately
    this.queueCache = queueFile;
    this.queueCacheTime = Date.now();
    
    // Write to Supabase (async, don't block)
    await this.crsService.writeFile('system/nightowl/queue.json', queueFile);
    
    console.log(`🦉 [NightOwl] Queued request ${fullRequest.id}: "${fullRequest.request?.slice(0, 50)}..."`);

    // If autonomous was paused, note that it should resume
    if (this.settings.processQueuedOnly) {
      console.log('🦉 [NightOwl] Request queued. Autonomous processing will resume next run.');
    }

    return fullRequest;
  }

  /**
   * Get queue file with caching to handle Supabase sync latency
   */
  async getQueueFile() {
    // Use cache if less than 30 seconds old
    if (this.queueCache && (Date.now() - this.queueCacheTime) < 30000) {
      console.log('🦉 [NightOwl] Using cached queue');
      return this.queueCache;
    }
    
    try {
      const queueFile = await this.crsService.readFile('system/nightowl/queue.json');
      this.queueCache = queueFile || { requests: [] };
      this.queueCacheTime = Date.now();
      return this.queueCache;
    } catch {
      this.queueCache = { requests: [] };
      this.queueCacheTime = Date.now();
      return this.queueCache;
    }
  }

  /**
   * Get queue status
   * @param {boolean} forceRefresh - If true, bypass cache and read fresh from storage
   */
  async getQueueStatus(forceRefresh = false) {
    if (forceRefresh) {
      // Invalidate cache
      this.queueCache = null;
      this.queueCacheTime = 0;
    }
    
    const queueFile = await this.getQueueFile();
    const pending = queueFile.requests?.filter(r => r.status === 'pending') || [];
    const completed = queueFile.requests?.filter(r => r.status === 'completed') || [];

    const undelivered = await this.getPendingInsights();

    return {
      pending,
      completed: completed.slice(-10),  // Last 10 completed
      undelivered,
      settings: this.settings
    };
  }

  /**
   * Get a single queue item by ID
   */
  async getQueueItem(requestId) {
    const queueFile = await this.getQueueFile();
    return queueFile.requests?.find(r => r.id === requestId) || null;
  }

  /**
   * Update an existing queue item
   * Only allows updating pending requests
   */
  async updateQueueItem(requestId, updates) {
    const queueFile = await this.getQueueFile();
    const index = queueFile.requests?.findIndex(r => r.id === requestId);
    
    if (index === -1 || index === undefined) {
      console.log(`⚠️ [NightOwl] Queue item ${requestId} not found`);
      return null;
    }
    
    const item = queueFile.requests[index];
    
    // Only allow updating pending items
    if (item.status !== 'pending') {
      console.log(`⚠️ [NightOwl] Cannot update ${item.status} queue item ${requestId}`);
      return null;
    }
    
    // Allowed fields to update
    const allowedFields = ['request', 'type', 'context', 'priority', 'dataSources', 'dateRange'];
    const updatedItem = { ...item };
    
    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        updatedItem[field] = updates[field];
      }
    }
    
    updatedItem.updatedAt = Date.now();
    queueFile.requests[index] = updatedItem;
    
    // Update cache
    this.queueCache = queueFile;
    this.queueCacheTime = Date.now();
    
    // Save to storage
    await this.crsService.writeFile('system/nightowl/queue.json', queueFile);
    
    console.log(`📝 [NightOwl] Updated queue item ${requestId}: "${updatedItem.request?.slice(0, 50)}..."`);
    return updatedItem;
  }

  /**
   * Remove a queue item by ID
   * Can remove pending items, marks completed/failed items as 'removed'
   */
  async removeQueueItem(requestId) {
    // Invalidate cache to get fresh data
    this.queueCache = null;
    this.queueCacheTime = 0;
    
    const queueFile = await this.getQueueFile();
    const index = queueFile.requests?.findIndex(r => r.id === requestId);
    
    if (index === -1 || index === undefined) {
      console.log(`⚠️ [NightOwl] Queue item ${requestId} not found`);
      return false;
    }
    
    const item = queueFile.requests[index];
    
    if (item.status === 'pending') {
      // Actually remove pending items
      queueFile.requests.splice(index, 1);
      console.log(`🗑️ [NightOwl] Removed pending queue item ${requestId}`);
    } else {
      // Mark completed/failed items as removed (keep for history)
      queueFile.requests[index].status = 'removed';
      queueFile.requests[index].removedAt = Date.now();
      console.log(`🗑️ [NightOwl] Marked queue item ${requestId} as removed`);
    }
    
    // Update cache
    this.queueCache = queueFile;
    this.queueCacheTime = Date.now();
    
    // Save to storage
    await this.crsService.writeFile('system/nightowl/queue.json', queueFile);
    
    return true;
  }

  /**
   * Clear all pending queue items
   */
  async clearPendingQueue() {
    try {
      // Invalidate cache to force fresh read from storage
      this.queueCache = null;
      this.queueCacheTime = 0;
      
      // Read fresh from storage (bypass cache)
      let queueFile;
      try {
        queueFile = await this.crsService.readFile('system/nightowl/queue.json');
        if (!queueFile || !queueFile.requests) {
          queueFile = { requests: [] };
        }
      } catch {
        queueFile = { requests: [] };
      }
      
      const pending = queueFile.requests?.filter(r => r.status === 'pending') || [];
      const clearedCount = pending.length;
      
      // Keep non-pending items
      queueFile.requests = queueFile.requests?.filter(r => r.status !== 'pending') || [];
      
      // Update cache
      this.queueCache = queueFile;
      this.queueCacheTime = Date.now();
      
      // Save to storage
      await this.crsService.writeFile('system/nightowl/queue.json', queueFile);
      
      console.log(`🧹 [NightOwl] Cleared ${clearedCount} pending queue items`);
      return clearedCount;
    } catch (error) {
      console.error('❌ [NightOwl] clearPendingQueue failed:', error);
      throw error;
    }
  }

  /**
   * Reorder queue items by priority or custom order
   * @param {string[]} orderedIds - Array of request IDs in desired order
   */
  async reorderQueue(orderedIds) {
    const queueFile = await this.getQueueFile();
    const pending = queueFile.requests?.filter(r => r.status === 'pending') || [];
    const nonPending = queueFile.requests?.filter(r => r.status !== 'pending') || [];
    
    // Reorder pending items based on provided order
    const reordered = [];
    for (const id of orderedIds) {
      const item = pending.find(r => r.id === id);
      if (item) {
        reordered.push(item);
      }
    }
    
    // Add any pending items not in the order list at the end
    for (const item of pending) {
      if (!orderedIds.includes(item.id)) {
        reordered.push(item);
      }
    }
    
    queueFile.requests = [...reordered, ...nonPending];
    
    // Update cache
    this.queueCache = queueFile;
    this.queueCacheTime = Date.now();
    
    // Save to storage
    await this.crsService.writeFile('system/nightowl/queue.json', queueFile);
    
    console.log(`🔄 [NightOwl] Reordered ${reordered.length} pending queue items`);
    return reordered;
  }

  // ============================================================================
  // AUTONOMOUS PROCESSORS
  // ============================================================================

  /**
   * Run all autonomous processors
   */
  async runAutonomousProcessors(userContext, healthData, trackingData, maxInsights) {
    const insights = [];

    // Run processors in priority order, stopping when we hit max
    const processors = [
      { name: 'milestones', fn: () => this.processMilestones(userContext) },
      { name: 'threads', fn: () => this.processLifeThreads(userContext) },
      { name: 'anticipatory', fn: () => this.processAnticipatoryPrep(userContext) },
      { name: 'patterns', fn: () => this.surfacePatterns(userContext, healthData, trackingData) },
      { name: 'health', fn: () => this.analyzeHealthCorrelations(userContext, healthData, trackingData) },
      { name: 'accountability', fn: () => this.checkAccountability(userContext) },
      { name: 'reminders', fn: () => this.generateSmartReminders(userContext) },
      { name: 'connections', fn: () => this.findConnections(userContext) },
      { name: 'plans', fn: () => this.iterateOnPlans(userContext) },
      { name: 'learning', fn: () => this.synthesizeLearning(userContext) }
    ];

    for (const processor of processors) {
      if (insights.length >= maxInsights) break;

      try {
        const result = await processor.fn();
        const toAdd = result.slice(0, maxInsights - insights.length);
        insights.push(...toAdd);

        if (toAdd.length > 0) {
          console.log(`🦉 [NightOwl] ${processor.name}: ${toAdd.length} insights`);
        }
      } catch (error) {
        console.error(`❌ [NightOwl] ${processor.name} failed:`, error.message);
      }
    }

    return insights;
  }

  /**
   * Process milestones specifically (high priority)
   */
  async processMilestones(userContext) {
    const threads = await this.crsService.loadExistingSystemFiles('life_threads');
    const milestones = (threads || []).filter(t => !t.resolved && t.nextMilestone);

    const insights = [];
    for (const milestone of milestones.slice(0, 2)) {
      const insight = await this.prepareMilestone(milestone, userContext);
      if (insight) insights.push(insight);
    }
    return insights;
  }

  dedupeInsights(insights) {
    const seen = new Set();
    return insights.filter(i => {
      const key = i.threadId || i.threadTitle;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * Get tracking data from UnifiedTrackingStore
   */
  async getTrackingDataFromStore() {
    try {
      const trackingFile = await this.crsService.readFile('system/tracking/entries.json').catch(() => null);

      if (!trackingFile?.entries) {
        return { metrics: {}, habits: {}, activities: [], available: false };
      }

      const entries = trackingFile.entries;
      const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
      const recent = entries.filter(e => e.date >= thirtyDaysAgo);

      const metrics = {};
      const habits = {};
      const activities = [];

      for (const entry of recent) {
        if (entry.type === 'metric' && entry.value !== undefined) {
          if (!metrics[entry.name]) metrics[entry.name] = [];
          metrics[entry.name].push({ date: entry.date, value: entry.value });
        } else if (entry.type === 'habit') {
          if (!habits[entry.name]) habits[entry.name] = [];
          habits[entry.name].push({ date: entry.date, completed: entry.valueBool });
        } else if (entry.type === 'activity') {
          activities.push({ date: entry.date, name: entry.name, data: entry.data });
        }
      }

      return { metrics, habits, activities, available: true };
    } catch (error) {
      console.warn('⚠️ [NightOwl] Failed to load tracking data:', error.message);
      return { metrics: {}, habits: {}, activities: [], available: false };
    }
  }

  // ============================================================================
  // NOTIFICATION SYSTEM
  // ============================================================================

  /**
   * Queue notification for delivery
   * Handles immediate vs morning timing
   */
  async queueNotification(insights) {
    const notification = {
      id: this.generateId('notif'),
      insightCount: insights.length,
      insightTypes: [...new Set(insights.map(i => i.insightType))],
      createdAt: Date.now(),
      scheduledFor: this.settings.notificationTiming === 'immediate'
        ? Date.now()
        : this.getNextMorningTime(),
      sent: false,
      message: this.generateNotificationMessage(insights)
    };

    await this.crsService.writeFile(`system/nightowl/notifications/${notification.id}.json`, notification);
    console.log(`🔔 [NightOwl] Notification queued for ${this.settings.notificationTiming === 'immediate' ? 'now' : 'morning'}`);
  }

  getNextMorningTime() {
    const now = new Date();
    const morning = new Date();
    morning.setHours(this.settings.morningHour, 0, 0, 0);

    // If it's already past morning, schedule for tomorrow
    if (now.getHours() >= this.settings.morningHour) {
      morning.setDate(morning.getDate() + 1);
    }

    return morning.getTime();
  }

  generateNotificationMessage(insights) {
    const count = insights.length;
    const hasMilestone = insights.some(i => i.insightType === 'milestone_prep');
    const hasQueued = insights.some(i => i.isQueued);

    let body;

    if (hasQueued && count === 1) {
      body = `I finished that analysis you asked about. Ready when you are.`;
    } else if (hasMilestone) {
      body = `I've been thinking about something important coming up.`;
    } else if (count === 1) {
      const insight = insights[0];
      const typeMessages = {
        research: `I did some research on something you're working on.`,
        pattern: `I noticed a pattern worth mentioning.`,
        health: `I found something interesting in your health patterns.`,
        anticipatory: `I prepared some context for tomorrow.`,
        accountability: `Quick check-in on some commitments.`
      };
      body = typeMessages[insight.insightType] || `I have a thought to share when you're ready.`;
    } else {
      body = `I worked on ${count} things overnight. Open when you're ready to chat.`;
    }

    return {
      title: 'Horizon',
      body
    };
  }

  /**
   * Get pending notifications ready to send
   * Called by iOS/backend notification scheduler
   */
  async getPendingNotifications() {
    try {
      const files = await this.crsService.listFiles('system/nightowl/notifications');
      const now = Date.now();
      const pending = [];

      for (const file of files) {
        if (!file.name.endsWith('.json')) continue;
        const notif = await this.crsService.readFile(`system/nightowl/notifications/${file.name}`);
        if (notif && !notif.sent && notif.scheduledFor <= now) {
          pending.push(notif);
        }
      }

      return pending;
    } catch {
      return [];
    }
  }

  async markNotificationSent(notificationId) {
    const path = `system/nightowl/notifications/${notificationId}.json`;
    try {
      const notif = await this.crsService.readFile(path);
      if (notif) {
        notif.sent = true;
        notif.sentAt = Date.now();
        await this.crsService.writeFile(path, notif);
      }
    } catch (error) {
      console.error('❌ [NightOwl] Failed to mark notification sent:', error.message);
    }
  }

  /**
   * Process life threads for autonomous insights
   */
  async processLifeThreads(userContext) {
    const threads = await this.getWorkableLifeThreads();
    
    if (threads.length === 0) {
      console.log(`🦉 [NightOwl] No workable life threads to process`);
      return [];
    }
    
    console.log(`🦉 [NightOwl] Processing ${threads.length} life threads...`);
    const insights = [];
    for (const thread of threads) {
      try {
        const insight = await this.processLifeThread(thread, userContext);
        if (insight) insights.push(insight);
      } catch (error) {
        console.error(`❌ [NightOwl] Failed to process thread "${thread.title}":`, error.message);
      }
    }
    return insights;
  }

  // ============================================================================
  // LIFE THREAD SELECTION
  // ============================================================================

  /**
   * Get life threads that are worth autonomous work
   */
  async getWorkableLifeThreads() {
    const allThreads = await this.crsService.loadExistingSystemFiles('life_threads');

    // Filter to active, high emotional weight threads
    const workable = (allThreads || [])
      .filter(thread => {
        if (thread.resolved) return false;
        
        // Focus on threads with emotional weight >= minEmotionalWeight
        const weight = thread.emotionalWeight || 5;
        if (weight < this.minEmotionalWeight) return false;
        
        // Focus on categories that benefit from autonomous thinking
        const workableCategories = ['career', 'relationship', 'health', 'financial', 'goal', 'waiting'];
        if (!workableCategories.includes(thread.category)) return false;

        return true;
      })
      .sort((a, b) => {
        // Sort by emotional weight (highest first), then by recency
        const weightDiff = (b.emotionalWeight || 5) - (a.emotionalWeight || 5);
        if (weightDiff !== 0) return weightDiff;
        return (b.lastUpdate || 0) - (a.lastUpdate || 0);
      })
      .slice(0, this.maxThreadsPerRun);

    return workable;
  }

  /**
   * Process a single life thread and generate insight
   */
  async processLifeThread(thread, userContext) {
    const strategy = await this.determineThreadStrategy(thread);

    switch (strategy) {
      case 'research':
        return await this.doThreadResearch(thread, userContext);
      case 'decision':
        return await this.analyzeThreadDecision(thread, userContext);
      case 'preparation':
        return await this.prepareThreadApproach(thread, userContext);
      case 'reflection':
        return await this.reflectOnThread(thread, userContext);
      default:
        return await this.thinkThroughThread(thread, userContext);
    }
  }

  /**
   * Determine what kind of work this thread needs
   */
  async determineThreadStrategy(thread) {
    // Use category and context to determine strategy
    if (thread.category === 'waiting') return 'reflection';
    if (thread.category === 'career' && thread.status?.toLowerCase().includes('decision')) return 'decision';
    if (thread.category === 'relationship' && thread.nextMilestone) return 'preparation';
    if (thread.category === 'goal') return 'research';
    
    // Default based on context
    const context = (thread.currentContext || '').toLowerCase();
    if (context.includes('decide') || context.includes('choice')) return 'decision';
    if (context.includes('meeting') || context.includes('talk to')) return 'preparation';
    if (context.includes('learn') || context.includes('plan')) return 'research';
    
    return 'reflection';
  }

  // ============================================================================
  // USER CONTEXT
  // ============================================================================

  /**
   * Get relevant user context for personalization
   */
  async getUserContext() {
    try {
      const [entities, facts, patterns] = await Promise.all([
        this.crsService.loadExistingSystemFiles('entities'),
        this.crsService.loadExistingSystemFiles('facts'),
        this.crsService.loadExistingSystemFiles('patterns')
      ]);

      // Get self facts
      const selfFacts = facts.filter(f => f.entityId === 'self');

      // Get confirmed patterns
      const confirmedPatterns = patterns.filter(p => p.status === 'confirmed');

      // Build identity from self facts
      const identity = {};
      for (const fact of selfFacts) {
        if (fact.category === 'biographical') {
          if (fact.content.toLowerCase().includes('vegetarian')) identity.diet = 'vegetarian';
          if (fact.content.toLowerCase().includes('vegan')) identity.diet = 'vegan';
          // Add more as needed
        }
        if (fact.category === 'preference') {
          identity.preferences = identity.preferences || [];
          identity.preferences.push(fact.content);
        }
      }

      return {
        selfIdentity: identity,
        relevantFacts: selfFacts.slice(0, 20), // Limit for context window
        relevantEntities: entities.filter(e => e.salience > 0.5),
        patterns: confirmedPatterns
      };

    } catch (error) {
      console.warn('⚠️ [NightOwl] Failed to load user context:', error.message);
      return { selfIdentity: {}, relevantFacts: [], relevantEntities: [], patterns: [] };
    }
  }

  // ============================================================================
  // LIFE THREAD PROCESSING
  // ============================================================================

  /**
   * Research insights for a life thread
   */
  async doThreadResearch(thread, userContext) {
    console.log(`🔍 [NightOwl] Researching thread: "${thread.title}"`);

    const relatedContext = await this.getRelatedEntitiesContext(thread.relatedEntities || [], userContext);
    const userPrefs = this.buildUserPreferencesContext(userContext);

    const systemPrompt = `You are Night Owl, a thoughtful AI that helps the user navigate their ongoing life situations.

The user has a life thread they're tracking:
THREAD: "${thread.title}"
CATEGORY: ${thread.category}
STATUS: ${thread.status}
CONTEXT: ${thread.currentContext || 'No additional context'}
EMOTIONAL WEIGHT: ${thread.emotionalWeight}/10
${thread.nextMilestone ? `UPCOMING: ${thread.nextMilestone.description}` : ''}
${thread.userGuidance?.length ? `USER GUIDANCE: ${thread.userGuidance.join('; ')}` : ''}

Your job is to:
1. Research relevant information that could help them
2. Find perspectives or insights they might not have considered
3. Provide actionable suggestions

Be warm, supportive, and specific to THEIR situation. Use web search if helpful.
Always respect any user guidance about how to handle this situation.`;

    const userPrompt = `${relatedContext}
${userPrefs}

Research this life thread and provide helpful insights. Focus on what's most useful for their current status.`;

    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        tools: [WEB_SEARCH_TOOL],
        messages: [{ role: 'user', content: userPrompt }],
        system: systemPrompt
      });

      const { text, sources } = this.extractResponseContent(response);

      return {
        id: this.generateId('thread_insight'),
        threadId: thread.id,
        threadTitle: thread.title,
        insightType: 'research',
        content: text,
        conversationHook: this.generateThreadHook(thread, 'research'),
        sources,
        createdAt: Date.now(),
        status: 'pending'
      };

    } catch (error) {
      console.error(`❌ [NightOwl] Thread research failed:`, error.message);
      return null;
    }
  }

  /**
   * Help with a decision-related thread
   */
  async analyzeThreadDecision(thread, userContext) {
    console.log(`🤔 [NightOwl] Analyzing decision for thread: "${thread.title}"`);

    const relatedContext = await this.getRelatedEntitiesContext(thread.relatedEntities || [], userContext);
    const patternsContext = this.buildPatternsContext(userContext);

    const systemPrompt = `You are Night Owl, helping the user think through a decision.

SITUATION: "${thread.title}"
CATEGORY: ${thread.category}
CURRENT STATE: ${thread.status}
CONTEXT: ${thread.currentContext || 'No additional context'}
EMOTIONAL WEIGHT: ${thread.emotionalWeight}/10
${thread.userGuidance?.length ? `USER GUIDANCE: ${thread.userGuidance.join('; ')}` : ''}

Help them think through this decision by:
1. Identifying what they truly value in this situation
2. Weighing factors based on their patterns and history
3. Offering a perspective they might not have considered
4. NOT making the decision for them

Be thoughtful and personalized. Reference their patterns and known preferences.
Respect any guidance they've given about how to approach this.`;

    const userPrompt = `${relatedContext}
${patternsContext}

Help them think through this decision. Be warm and insightful.`;

    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [{ role: 'user', content: userPrompt }],
        system: systemPrompt
      });

      const { text } = this.extractResponseContent(response);

      return {
        id: this.generateId('thread_insight'),
        threadId: thread.id,
        threadTitle: thread.title,
        insightType: 'decision_analysis',
        content: text,
        conversationHook: this.generateThreadHook(thread, 'decision'),
        sources: [],
        createdAt: Date.now(),
        status: 'pending'
      };

    } catch (error) {
      console.error(`❌ [NightOwl] Thread decision analysis failed:`, error.message);
      return null;
    }
  }

  /**
   * Prepare for an upcoming interaction/milestone
   */
  async prepareThreadApproach(thread, userContext) {
    console.log(`🎯 [NightOwl] Preparing approach for thread: "${thread.title}"`);

    const relatedContext = await this.getRelatedEntitiesContext(thread.relatedEntities || [], userContext);

    const milestone = thread.nextMilestone;
    const daysUntil = milestone?.date 
      ? Math.ceil((milestone.date - Date.now()) / (24 * 60 * 60 * 1000))
      : null;

    const systemPrompt = `You are Night Owl, helping the user prepare for something important.

SITUATION: "${thread.title}"
CATEGORY: ${thread.category}
${milestone ? `UPCOMING: ${milestone.description} ${daysUntil !== null ? `(${daysUntil} days away)` : ''}` : ''}
CONTEXT: ${thread.currentContext || 'No additional context'}
${thread.userGuidance?.length ? `USER GUIDANCE: ${thread.userGuidance.join('; ')}` : ''}

Help them prepare by:
1. Anticipating what might come up
2. Suggesting approaches based on their style
3. Helping them feel more confident
4. Identifying things to think about beforehand

Be supportive and practical. Make them feel prepared, not anxious.`;

    const userPrompt = `${relatedContext}

Help them prepare for this. Focus on practical preparation and emotional readiness.`;

    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [{ role: 'user', content: userPrompt }],
        system: systemPrompt
      });

      const { text } = this.extractResponseContent(response);

      return {
        id: this.generateId('thread_insight'),
        threadId: thread.id,
        threadTitle: thread.title,
        insightType: 'preparation',
        content: text,
        conversationHook: this.generateThreadHook(thread, 'preparation'),
        sources: [],
        createdAt: Date.now(),
        status: 'pending'
      };

    } catch (error) {
      console.error(`❌ [NightOwl] Thread preparation failed:`, error.message);
      return null;
    }
  }

  /**
   * Reflection on a thread (especially for 'waiting' category)
   */
  async reflectOnThread(thread, userContext) {
    console.log(`💭 [NightOwl] Reflecting on thread: "${thread.title}"`);

    const patternsContext = this.buildPatternsContext(userContext);

    const systemPrompt = `You are Night Owl, offering thoughtful reflection on something the user is navigating.

SITUATION: "${thread.title}"
CATEGORY: ${thread.category}
STATUS: ${thread.status}
CONTEXT: ${thread.currentContext || 'No additional context'}
EMOTIONAL WEIGHT: ${thread.emotionalWeight}/10
${thread.userGuidance?.length ? `USER GUIDANCE: ${thread.userGuidance.join('; ')}` : ''}

${thread.category === 'waiting' ? 'They are waiting to hear back on something. Help them process the uncertainty.' : ''}

Offer:
1. A fresh perspective on where they are
2. Validation of their feelings
3. A gentle reframe if helpful
4. Something to consider that might bring peace or clarity

Be warm, not clinical. This is reflection, not problem-solving.`;

    const userPrompt = `${patternsContext}

Offer a thoughtful reflection. Be personal and warm.`;

    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        messages: [{ role: 'user', content: userPrompt }],
        system: systemPrompt
      });

      const { text } = this.extractResponseContent(response);

      return {
        id: this.generateId('thread_insight'),
        threadId: thread.id,
        threadTitle: thread.title,
        insightType: 'reflection',
        content: text,
        conversationHook: this.generateThreadHook(thread, 'reflection'),
        sources: [],
        createdAt: Date.now(),
        status: 'pending'
      };

    } catch (error) {
      console.error(`❌ [NightOwl] Thread reflection failed:`, error.message);
      return null;
    }
  }

  /**
   * General think-through for a thread
   */
  async thinkThroughThread(thread, userContext) {
    console.log(`💡 [NightOwl] Thinking through thread: "${thread.title}"`);

    const relatedContext = await this.getRelatedEntitiesContext(thread.relatedEntities || [], userContext);
    const patternsContext = this.buildPatternsContext(userContext);

    const systemPrompt = `You are Night Owl, offering overnight perspective on something the user is tracking.

SITUATION: "${thread.title}"
CATEGORY: ${thread.category}
STATUS: ${thread.status}
CONTEXT: ${thread.currentContext || 'No additional context'}
${thread.userGuidance?.length ? `USER GUIDANCE: ${thread.userGuidance.join('; ')}` : ''}

Offer something helpful:
- A perspective they might not have considered
- A connection to their patterns or history
- A practical next step
- An encouraging observation

Be concise but meaningful. This will be delivered in conversation.`;

    const userPrompt = `${relatedContext}
${patternsContext}

Think through this situation and offer something useful.`;

    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        messages: [{ role: 'user', content: userPrompt }],
        system: systemPrompt
      });

      const { text } = this.extractResponseContent(response);

      return {
        id: this.generateId('thread_insight'),
        threadId: thread.id,
        threadTitle: thread.title,
        insightType: 'perspective',
        content: text,
        conversationHook: this.generateThreadHook(thread, 'perspective'),
        sources: [],
        createdAt: Date.now(),
        status: 'pending'
      };

    } catch (error) {
      console.error(`❌ [NightOwl] Thread thinking failed:`, error.message);
      return null;
    }
  }

  /**
   * Generate a natural conversation hook for delivering a thread insight
   */
  generateThreadHook(thread, insightType) {
    const hooks = {
      research: [
        `I did some thinking about ${thread.title}...`,
        `Been mulling over the ${thread.title} situation...`,
        `I looked into some things about ${thread.title}...`
      ],
      decision: [
        `I thought about that decision you're weighing...`,
        `About ${thread.title} - I had some thoughts...`,
        `I've been thinking about your options with ${thread.title}...`
      ],
      preparation: [
        `Wanted to help you prepare for ${thread.nextMilestone?.description || 'what\'s coming'}...`,
        `Thinking about your upcoming ${thread.title} situation...`,
        `I thought of some things that might help with ${thread.title}...`
      ],
      reflection: [
        `I was reflecting on the ${thread.title} situation...`,
        `About ${thread.title} - had a thought...`,
        `Something occurred to me about ${thread.title}...`
      ],
      perspective: [
        `I had a thought about ${thread.title}...`,
        `About that ${thread.title} situation...`,
        `Something about ${thread.title} came to mind...`
      ]
    };

    const typeHooks = hooks[insightType] || hooks.perspective;
    return typeHooks[Math.floor(Math.random() * typeHooks.length)];
  }

  /**
   * Build patterns context for prompts
   */
  buildPatternsContext(userContext) {
    if (!userContext.patterns?.length) return '';

    const patterns = userContext.patterns.slice(0, 5).map(p => `- ${p.claim}`).join('\n');
    return `\nKNOWN PATTERNS ABOUT THEM:\n${patterns}`;
  }

  // ============================================================================
  // ITERATIVE RESEARCH SYSTEM
  // ============================================================================

  /**
   * Research depth configurations
   * REDUCED COSTS - was burning $$$
   * - quick: Fast surface-level research (~15s, ~$0.05)
   * - standard: Single-pass research (~30s, ~$0.10)  
   * - deep: Two iterations max (~1min, ~$0.25)
   */
  static RESEARCH_DEPTH_CONFIGS = {
    quick: {
      maxIterations: 1,
      maxSubQuestions: 2,
      maxSearchesPerIteration: 1,
      synthesisDepth: 'brief'
    },
    standard: {
      maxIterations: 1,  // Was 3 - too expensive
      maxSubQuestions: 3,  // Was 5
      maxSearchesPerIteration: 2,  // Was 3
      synthesisDepth: 'thorough'
    },
    deep: {
      maxIterations: 2,  // Was 8 - way too expensive!
      maxSubQuestions: 4,  // Was 8
      maxSearchesPerIteration: 2,  // Was 5
      synthesisDepth: 'comprehensive',
      enableRecursiveSubtopics: false,  // Was true - recursive = $$$
      minCompletenessThreshold: 0.7  // Was 0.9 - too aggressive
    }
  };

  async doResearch(loop, userContext, depth = 'standard') {
    const depthConfig = NightOwlService.RESEARCH_DEPTH_CONFIGS[depth] || NightOwlService.RESEARCH_DEPTH_CONFIGS.standard;
    
    // Cost estimation for logging
    const estimatedCalls = depthConfig.maxIterations * depthConfig.maxSubQuestions;
    const estimatedCost = (estimatedCalls * 0.03).toFixed(2); // ~$0.03 per call with web search
    console.log(`🔍 [NightOwl] Starting ${depth} research: "${loop.title}"`);
    console.log(`💰 [NightOwl] Estimated: ${estimatedCalls} API calls (~$${estimatedCost})`);

    const config = {
      maxIterations: depthConfig.maxIterations,
      maxSubQuestions: depthConfig.maxSubQuestions,
      maxSearchesPerIteration: depthConfig.maxSearchesPerIteration
    };

    try {
      // Build context once
      const userPrefs = this.buildUserPreferencesContext(userContext);
      const relatedContext = await this.getRelatedEntitiesContext(loop.relatedEntityIds || [], userContext);

      // PHASE 1: Plan the research
      console.log(`📋 [NightOwl] Planning research approach...`);
      const researchPlan = await this.planResearch(loop, userPrefs, relatedContext);

      if (!researchPlan || researchPlan.subQuestions.length === 0) {
        console.warn(`⚠️ [NightOwl] Could not generate research plan, falling back to simple research`);
        return await this.doSimpleResearch(loop, userContext);
      }

      console.log(`📋 [NightOwl] Research plan: ${researchPlan.subQuestions.length} sub-questions`);

      // PHASE 2 & 3: Execute and iterate
      const allFindings = [];
      let iteration = 0;
      let questionsToResearch = researchPlan.subQuestions.slice(0, config.maxSubQuestions);

      while (iteration < config.maxIterations && questionsToResearch.length > 0) {
        iteration++;
        console.log(`🔄 [NightOwl] Research iteration ${iteration}/${config.maxIterations}`);

        // Research each question in this iteration
        const iterationFindings = await this.executeResearchIteration(
          questionsToResearch,
          loop,
          userPrefs,
          config.maxSearchesPerIteration
        );

        allFindings.push(...iterationFindings);

        // Evaluate gaps and determine if we need another iteration
        if (iteration < config.maxIterations) {
          const completenessThreshold = depthConfig.minCompletenessThreshold || 0.8;
          const gaps = await this.evaluateResearchGaps(
            loop,
            allFindings,
            researchPlan.successCriteria,
            userPrefs,
            completenessThreshold
          );

          if (gaps.length === 0) {
            console.log(`✅ [NightOwl] Research complete - no significant gaps`);
            break;
          }

          console.log(`🔍 [NightOwl] Found ${gaps.length} gaps to investigate`);
          questionsToResearch = gaps.slice(0, config.maxSubQuestions);
        }
      }

      // PHASE 4: Synthesize all findings
      console.log(`📝 [NightOwl] Synthesizing ${allFindings.length} findings...`);
      const synthesis = await this.synthesizeResearchFindings(
        loop,
        allFindings,
        researchPlan,
        userPrefs,
        relatedContext
      );

      // Collect all sources
      const allSources = [...new Set(allFindings.flatMap(f => f.sources || []))];

      // PHASE 5: Generate staged actions
      console.log(`📝 [NightOwl] Generating staged actions...`);
      const stagedActions = await this.generateStagedActionsForResearch(loop, synthesis, allFindings);

      return {
        id: this.generateId('insight'),
        loopId: loop.id,
        loopTitle: loop.title,
        insightType: 'research',
        content: synthesis,
        conversationHook: this.generateConversationHook(loop, 'research'),
        sources: allSources,
        stagedActions,
        isQueued: true,  // Mark as user-requested, not autonomous
        metadata: {
          depth,
          iterations: iteration,
          maxIterations: config.maxIterations,
          subQuestionsResearched: allFindings.length,
          researchPlan: researchPlan.subQuestions
        },
        createdAt: Date.now(),
        status: 'pending'
      };

    } catch (error) {
      console.error(`❌ [NightOwl] Iterative research failed:`, error.message);
      // Fall back to simple research
      return await this.doSimpleResearch(loop, userContext);
    }
  }

  /**
   * PHASE 1: Break down research into sub-questions
   */
  async planResearch(loop, userPrefs, relatedContext) {
    const response = await this.anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `Break down this research task into specific sub-questions.

RESEARCH TOPIC: ${loop.title}
${loop.description ? `DETAILS: ${loop.description}` : ''}

USER CONTEXT:
${userPrefs}

${relatedContext ? `RELATED CONTEXT:\n${relatedContext}` : ''}

Generate 3-5 specific, searchable sub-questions that would thoroughly research this topic.
Consider what the user specifically needs given their context.

Respond in this exact JSON format:
{
  "subQuestions": [
    {"question": "specific question 1", "priority": 1, "rationale": "why this matters"},
    {"question": "specific question 2", "priority": 2, "rationale": "why this matters"}
  ],
  "successCriteria": ["what would make this research complete"],
  "userSpecificAngles": ["aspects to emphasize given user context"]
}`
      }],
      system: 'You are a research planner. Break down research tasks into specific, searchable questions. Respond only with valid JSON.'
    });

    try {
      const text = response.content[0]?.text || '';
      // Extract JSON from response (handle markdown code blocks)
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch (e) {
      console.warn(`⚠️ [NightOwl] Failed to parse research plan:`, e.message);
    }

    return null;
  }

  /**
   * PHASE 2: Execute one iteration of research
   */
  async executeResearchIteration(questions, loop, userPrefs, maxSearches) {
    const findings = [];

    for (const q of questions.slice(0, maxSearches)) {
      const question = typeof q === 'string' ? q : q.question;
      console.log(`  🔎 Researching: "${question.substring(0, 50)}..."`);

      try {
        const response = await this.anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1500,
          tools: [WEB_SEARCH_TOOL],
          messages: [{
            role: 'user',
            content: `Research this specific question thoroughly:

QUESTION: ${question}

BROADER CONTEXT: This is part of researching "${loop.title}"

USER CONTEXT:
${userPrefs}

Provide:
1. Direct answer to the question with specific facts/data
2. Key sources and their credibility
3. Any caveats or things to verify
4. Related information that might be useful

Be specific and factual. Include numbers, names, and concrete details where available.`
          }],
          system: 'You are a thorough researcher. Provide specific, factual answers with concrete details. Use web search to find current information.'
        });

        const { text, sources } = this.extractResponseContent(response);

        findings.push({
          question,
          answer: text,
          sources,
          timestamp: Date.now()
        });

      } catch (error) {
        console.warn(`  ⚠️ Failed to research "${question}":`, error.message);
      }
    }

    return findings;
  }

  /**
   * PHASE 3: Evaluate what's missing
   * @param {number} completenessThreshold - Minimum completeness to stop (0.8 for standard, 0.9 for deep)
   */
  async evaluateResearchGaps(loop, findings, successCriteria, userPrefs, completenessThreshold = 0.8) {
    const findingsSummary = findings.map(f =>
      `Q: ${f.question}\nA: ${f.answer.substring(0, 500)}...`
    ).join('\n\n');

    const response = await this.anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `Evaluate this research and identify gaps.

ORIGINAL TOPIC: ${loop.title}
${loop.description ? `DETAILS: ${loop.description}` : ''}

SUCCESS CRITERIA:
${(successCriteria || []).map(c => `- ${c}`).join('\n') || '- Comprehensive, actionable information'}

USER CONTEXT:
${userPrefs}

RESEARCH COMPLETED:
${findingsSummary}

What important questions remain unanswered? What needs deeper investigation?
Only list gaps that are significant and would meaningfully improve the research.

Respond in JSON format:
{
  "gaps": [
    {"question": "unanswered question", "importance": "high/medium", "reason": "why this matters"}
  ],
  "completeness": 0.0-1.0,
  "assessment": "brief assessment of research quality"
}`
      }],
      system: 'You are a research evaluator. Identify meaningful gaps, not trivial ones. Respond only with valid JSON.'
    });

    try {
      const text = response.content[0]?.text || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const evaluation = JSON.parse(jsonMatch[0]);
        console.log(`📊 [NightOwl] Research completeness: ${(evaluation.completeness * 100).toFixed(0)}% (threshold: ${(completenessThreshold * 100).toFixed(0)}%)`);

        // Only return gaps if completeness is below threshold
        if (evaluation.completeness < completenessThreshold) {
          return (evaluation.gaps || [])
            .filter(g => g.importance === 'high' || g.importance === 'medium')
            .map(g => g.question);
        }
      }
    } catch (e) {
      console.warn(`⚠️ [NightOwl] Failed to parse gap evaluation`);
    }

    return [];
  }

  /**
   * PHASE 4: Synthesize all findings into coherent insight
   */
  async synthesizeResearchFindings(loop, findings, researchPlan, userPrefs, relatedContext) {
    const findingsText = findings.map(f =>
      `### ${f.question}\n${f.answer}`
    ).join('\n\n');

    const response = await this.anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `Synthesize this research into a helpful, personalized summary.

ORIGINAL TOPIC: ${loop.title}
${loop.description ? `DETAILS: ${loop.description}` : ''}

USER CONTEXT:
${userPrefs}

${relatedContext ? `RELATED CONTEXT:\n${relatedContext}` : ''}

USER-SPECIFIC ANGLES TO EMPHASIZE:
${(researchPlan?.userSpecificAngles || []).map(a => `- ${a}`).join('\n') || '- General helpfulness'}

RESEARCH FINDINGS:
${findingsText}

Create a cohesive summary that:
1. Directly addresses what the user needs to know
2. Is personalized to their context and preferences
3. Highlights the most actionable information
4. Organizes information logically (not just question-by-question)
5. Calls out any important caveats or decisions they need to make
6. Suggests concrete next steps

Write conversationally - this will be delivered in a chat. Don't use headers like "Summary:" - just provide the helpful content.`
      }],
      system: 'You are synthesizing research into a helpful, personalized summary. Be conversational and actionable. Focus on what matters most to this specific user.'
    });

    return response.content[0]?.text?.trim() || 'Research synthesis failed.';
  }

  /**
   * Fallback: Simple single-shot research (original behavior)
   */
  async doSimpleResearch(loop, userContext) {
    console.log(`🔍 [NightOwl] Falling back to simple research: "${loop.title}"`);

    const userPrefs = this.buildUserPreferencesContext(userContext);
    const relatedContext = await this.getRelatedEntitiesContext(loop.relatedEntityIds || [], userContext);

    const systemPrompt = `You are a thoughtful personal assistant doing background research to help with planning and decision-making. 

Your research should be:
- Practical and actionable
- Personalized to the user's preferences and situation
- Well-sourced from current information
- Organized in a way that's easy to digest

Be conversational but informative. This will be delivered naturally in a future conversation.`;

    const userPrompt = `I need to research this for the user:

OPEN LOOP: ${loop.title}
${loop.description ? `Details: ${loop.description}` : ''}

USER CONTEXT:
${userPrefs}
${relatedContext}

Please research this thoroughly and provide practical, personalized findings. Use web search to find current, relevant information.`;

    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        tools: [WEB_SEARCH_TOOL],
        messages: [{ role: 'user', content: userPrompt }],
        system: systemPrompt
      });

      const { text, sources } = this.extractResponseContent(response);

      return {
        id: this.generateId('insight'),
        loopId: loop.id,
        loopTitle: loop.title,
        insightType: 'research',
        content: text,
        conversationHook: this.generateConversationHook(loop, 'research'),
        sources,
        isQueued: true,  // Mark as user-requested, not autonomous
        createdAt: Date.now(),
        status: 'pending'
      };

    } catch (error) {
      console.error(`❌ [NightOwl] Simple research failed:`, error.message);
      return null;
    }
  }

  // ============================================================================
  // DECISION ANALYSIS
  // ============================================================================

  async analyzeDecision(loop, userContext) {
    console.log(`⚖️ [NightOwl] Analyzing decision: "${loop.title}"`);

    const userPrefs = this.buildUserPreferencesContext(userContext);
    const patternsContext = this.buildPatternsContext(userContext);

    const systemPrompt = `You are a thoughtful advisor helping someone think through a decision. 

Your analysis should:
- Consider multiple perspectives fairly
- Connect to what you know about their values and patterns
- Highlight trade-offs clearly
- NOT make the decision for them, but help them think more clearly
- Surface considerations they might not have thought of

Be warm and supportive while being intellectually honest.`;

    const userPrompt = `Help me think through this decision:

DECISION: ${loop.title}
${loop.description ? `Context: ${loop.description}` : ''}

WHAT I KNOW ABOUT THE USER:
${userPrefs}

PATTERNS I'VE NOTICED:
${patternsContext}

Please provide 2-3 different perspectives on this decision, highlight key trade-offs, and note any patterns from their life that might be relevant. Don't tell them what to decide - help them think more clearly.`;

    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        tools: [WEB_SEARCH_TOOL], // In case we need to research aspects
        messages: [
          { role: 'user', content: userPrompt }
        ],
        system: systemPrompt
      });

      const { text, sources } = this.extractResponseContent(response);

      return {
        id: this.generateId('insight'),
        loopId: loop.id,
        loopTitle: loop.title,
        insightType: 'perspective',
        content: text,
        conversationHook: this.generateConversationHook(loop, 'decision'),
        sources,
        createdAt: Date.now(),
        status: 'pending'
      };

    } catch (error) {
      console.error(`❌ [NightOwl] Decision analysis failed:`, error.message);
      return null;
    }
  }

  // ============================================================================
  // APPROACH PREPARATION
  // ============================================================================

  async prepareApproach(loop, userContext) {
    console.log(`💬 [NightOwl] Preparing approach: "${loop.title}"`);

    const userPrefs = this.buildUserPreferencesContext(userContext);
    const relatedContext = await this.getRelatedEntitiesContext(loop.relatedEntityIds || [], userContext);

    const systemPrompt = `You are a thoughtful advisor helping someone prepare for a conversation or interaction.

Your preparation should:
- Consider the relationship dynamics involved
- Suggest different approaches they could take
- Anticipate potential responses or challenges
- Help them feel more prepared and confident
- Be practical and actionable

Be warm and supportive.`;

    const userPrompt = `Help me think through this upcoming interaction:

SITUATION: ${loop.title}
${loop.description ? `Details: ${loop.description}` : ''}

CONTEXT ABOUT THE USER:
${userPrefs}

RELEVANT RELATIONSHIPS:
${relatedContext}

Please suggest 2-3 approaches they could take, what to consider, and how to prepare mentally/emotionally.`;

    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        messages: [
          { role: 'user', content: userPrompt }
        ],
        system: systemPrompt
      });

      const { text } = this.extractResponseContent(response);

      return {
        id: this.generateId('insight'),
        loopId: loop.id,
        loopTitle: loop.title,
        insightType: 'preparation',
        content: text,
        conversationHook: this.generateConversationHook(loop, 'preparation'),
        sources: [],
        createdAt: Date.now(),
        status: 'pending'
      };

    } catch (error) {
      console.error(`❌ [NightOwl] Approach preparation failed:`, error.message);
      return null;
    }
  }

  // ============================================================================
  // GENERAL THINKING
  // ============================================================================

  async thinkThrough(loop, userContext) {
    console.log(`🤔 [NightOwl] Thinking through: "${loop.title}"`);

    const userPrefs = this.buildUserPreferencesContext(userContext);

    const systemPrompt = `You are a thoughtful personal assistant helping someone make progress on something they're thinking about.

Your response should:
- Offer a fresh perspective or angle they might not have considered
- Be practical and actionable
- Connect to what you know about them
- Help them feel less stuck

Be conversational and warm.`;

    const userPrompt = `Help me think through this:

OPEN ITEM: ${loop.title}
${loop.description ? `Details: ${loop.description}` : ''}

CONTEXT:
${userPrefs}

Please offer a helpful perspective or suggest a concrete next step they could take.`;

    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [
          { role: 'user', content: userPrompt }
        ],
        system: systemPrompt
      });

      const { text } = this.extractResponseContent(response);

      return {
        id: this.generateId('insight'),
        loopId: loop.id,
        loopTitle: loop.title,
        insightType: 'suggestion',
        content: text,
        conversationHook: this.generateConversationHook(loop, 'general'),
        sources: [],
        createdAt: Date.now(),
        status: 'pending'
      };

    } catch (error) {
      console.error(`❌ [NightOwl] Think-through failed:`, error.message);
      return null;
    }
  }

  // ============================================================================
  // CONTEXT BUILDERS
  // ============================================================================

  /**
   * Get HealthKit data synced from iOS
   * 
   * PLACEHOLDER: HealthKit data must be synced from iOS app to Supabase.
   * This reads whatever has been synced.
   * 
   * Expected sync structure in Supabase storage:
   * - system/health/sleep.json - Recent sleep data
   * - system/health/steps.json - Daily step counts
   * - system/health/workouts.json - Workout history
   * - system/health/heart_rate.json - Heart rate samples
   * - system/health/summary.json - Daily health summaries
   */
  async getHealthData() {
    try {
      const [sleep, steps, workouts, heartRate, summary] = await Promise.all([
        this.crsService.readFile('system/health/sleep.json').catch(() => null),
        this.crsService.readFile('system/health/steps.json').catch(() => null),
        this.crsService.readFile('system/health/workouts.json').catch(() => null),
        this.crsService.readFile('system/health/heart_rate.json').catch(() => null),
        this.crsService.readFile('system/health/summary.json').catch(() => null)
      ]);

      const hasData = sleep || steps || workouts || heartRate || summary;

      if (!hasData) {
        console.log('🦉 [NightOwl] No HealthKit data available (sync from iOS required)');
      }

      return {
        sleep: sleep?.data || [],
        steps: steps?.data || [],
        workouts: workouts?.data || [],
        heartRate: heartRate?.data || [],
        summary: summary || {},
        available: !!hasData
      };
    } catch (error) {
      console.warn('⚠️ [NightOwl] Failed to load health data:', error.message);
      return { sleep: [], steps: [], workouts: [], heartRate: [], summary: {}, available: false };
    }
  }

  /**
   * Get tracking data from unified tracking store
   * 
   * Reads 30 days of tracking data including:
   * - Metrics (weight, mood, sleep, etc.)
   * - Habits (meditation, exercise, etc.)
   * - Activities (workouts, meals, etc.)
   */
  async getTrackingData() {
    try {
      const trackingFile = await this.crsService.readFile('system/tracking/entries.json').catch(() => null);

      if (!trackingFile || !trackingFile.entries) {
        console.log('🦉 [NightOwl] No tracking data available');
        return { metrics: {}, habits: {}, activities: [], available: false };
      }

      const entries = trackingFile.entries;
      const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
      const recentEntries = entries.filter(e => e.date >= thirtyDaysAgo);

      // Organize by type
      const metrics = {};
      const habits = {};
      const activities = [];

      for (const entry of recentEntries) {
        if (entry.type === 'metric' && entry.value !== undefined) {
          if (!metrics[entry.name]) metrics[entry.name] = [];
          metrics[entry.name].push({ date: entry.date, value: entry.value });
        } else if (entry.type === 'habit' && entry.valueBool !== undefined) {
          if (!habits[entry.name]) habits[entry.name] = [];
          habits[entry.name].push({ date: entry.date, completed: entry.valueBool });
        } else if (entry.type === 'activity') {
          activities.push({
            date: entry.date,
            type: entry.category,
            name: entry.name,
            data: entry.data
          });
        }
      }

      console.log(`🦉 [NightOwl] Loaded tracking data: ${Object.keys(metrics).length} metrics, ${Object.keys(habits).length} habits, ${activities.length} activities`);

      return { metrics, habits, activities, available: true };
    } catch (error) {
      console.warn('⚠️ [NightOwl] Failed to load tracking data:', error.message);
      return { metrics: {}, habits: {}, activities: [], available: false };
    }
  }

  /**
   * Get calendar events (synced from iOS/iCloud)
   * 
   * PLACEHOLDER: Calendar data must be synced from iOS app to Supabase.
   */
  async getCalendarData() {
    try {
      const calendar = await this.crsService.readFile('system/calendar/events.json').catch(() => null);
      return calendar?.events || [];
    } catch (error) {
      console.warn('⚠️ [NightOwl] Failed to load calendar data:', error.message);
      return [];
    }
  }

  // ============================================================================
  // 2. ANTICIPATORY PREP
  // ============================================================================

  async processAnticipatoryPrep(userContext) {
    console.log('📅 [NightOwl] Processing anticipatory prep...');
    const insights = [];

    // Get upcoming events
    const calendarEvents = await this.getCalendarData();
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const nextWeek = new Date();
    nextWeek.setDate(nextWeek.getDate() + 7);

    // Check for tomorrow's meetings/events with people
    const tomorrowEvents = calendarEvents.filter(e => {
      const eventDate = new Date(e.startDate);
      return eventDate.toDateString() === tomorrow.toDateString();
    });

    for (const event of tomorrowEvents.slice(0, 2)) { // Max 2 prep insights
      const prep = await this.prepareForEvent(event, userContext);
      if (prep) insights.push(prep);
    }

    // Check for upcoming birthdays (from entities)
    const birthdayInsight = await this.checkUpcomingBirthdays(userContext, nextWeek);
    if (birthdayInsight) insights.push(birthdayInsight);

    // Check for upcoming trips (from life threads or calendar)
    const tripInsight = await this.prepareForTrips(userContext, calendarEvents);
    if (tripInsight) insights.push(tripInsight);

    return insights;
  }

  async prepareForEvent(event, userContext) {
    // Extract person name from event title
    const personNames = this.extractPersonNames(event.title, userContext.relevantEntities);
    if (personNames.length === 0) return null;

    // Get context about this person
    const personContext = await this.getPersonContext(personNames[0], userContext);
    if (!personContext) return null;

    console.log(`📅 [NightOwl] Preparing for event: "${event.title}"`);

    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: `Tomorrow the user has: "${event.title}"

Here's what we know about ${personNames[0]}:
${personContext}

Recent life threads involving them:
${await this.getThreadsInvolvingPerson(personNames[0])}

Please prepare a brief context summary: who this person is, recent context, any open items with them, and anything useful to remember going in.`
        }],
        system: 'You are preparing someone for an upcoming meeting/event. Be concise and practical. Focus on what would actually be useful to know going in.'
      });

      const { text } = this.extractResponseContent(response);

      const insight = {
        id: this.generateId('insight'),
        loopId: null,
        loopTitle: event.title,
        insightType: 'anticipatory',
        content: text,
        conversationHook: `You've got "${event.title}" tomorrow — here's some context...`,
        sources: [],
        createdAt: Date.now(),
        status: 'pending'
      };

      // Add staged actions for meeting prep
      insight.stagedActions = this.generateStagedActionsForAnticipatory(insight, 'meeting', {
        personName: personNames[0],
        eventTitle: event.title
      });

      return insight;
    } catch (error) {
      console.error(`❌ [NightOwl] Event prep failed:`, error.message);
      return null;
    }
  }

  async checkUpcomingBirthdays(userContext, withinDate) {
    // Look for birthday facts in entities
    const entities = userContext.relevantEntities || [];
    const facts = userContext.relevantFacts || [];

    const birthdayFacts = facts.filter(f =>
      f.content.toLowerCase().includes('birthday') ||
      f.content.toLowerCase().includes('born on')
    );

    if (birthdayFacts.length === 0) return null;

    // Parse and check dates (simplified - would need better date parsing)
    const now = new Date();
    const upcoming = [];

    for (const fact of birthdayFacts) {
      // Try to extract date - this is simplified
      const entity = entities.find(e => e.id === fact.entityId);
      if (entity && entity.id !== 'self') {
        // Check if birthday is within next 7 days (simplified check)
        upcoming.push({
          name: entity.name,
          fact: fact.content,
          relationship: entity.relationshipToSelf
        });
      }
    }

    if (upcoming.length === 0) return null;

    const person = upcoming[0];
    console.log(`🎂 [NightOwl] Upcoming birthday: ${person.name}`);

    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 800,
        tools: [WEB_SEARCH_TOOL],
        messages: [{
          role: 'user',
          content: `${person.name}'s birthday is coming up. They are the user's ${person.relationship || 'friend'}.

What we know about ${person.name}:
${await this.getPersonContext(person.name, userContext)}

Please suggest 2-3 thoughtful gift ideas or ways to celebrate, based on what we know about them and their relationship. Search for gift ideas if helpful.`
        }],
        system: 'You are helping someone prepare for a friend/family member\'s birthday. Be thoughtful and personalized based on the relationship.'
      });

      const { text, sources } = this.extractResponseContent(response);

      const insight = {
        id: this.generateId('insight'),
        loopId: null,
        loopTitle: `${person.name}'s birthday`,
        insightType: 'anticipatory',
        content: text,
        conversationHook: `${person.name}'s birthday is coming up...`,
        sources,
        createdAt: Date.now(),
        status: 'pending'
      };

      // Add staged actions for birthday
      insight.stagedActions = this.generateStagedActionsForAnticipatory(insight, 'birthday', {
        personName: person.name,
        relationship: person.relationship
      });

      return insight;
    } catch (error) {
      console.error(`❌ [NightOwl] Birthday prep failed:`, error.message);
      return null;
    }
  }

  async prepareForTrips(userContext, calendarEvents) {
    // Look for trip-related life threads
    const threads = await this.crsService.loadExistingSystemFiles('life_threads');
    const tripThreads = (threads || []).filter(t =>
      !t.resolved &&
      (t.category === 'logistics' ||
        t.title.toLowerCase().includes('trip') ||
        t.title.toLowerCase().includes('travel') ||
        t.title.toLowerCase().includes('vacation') ||
        t.title.toLowerCase().includes('visit'))
    );

    if (tripThreads.length === 0) return null;

    const trip = tripThreads[0];

    // Check if trip is within next 2 weeks (would need actual date parsing)
    console.log(`✈️ [NightOwl] Preparing for trip: "${trip.title}"`);

    try {
      const userPrefs = this.buildUserPreferencesContext(userContext);

      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1200,
        tools: [WEB_SEARCH_TOOL],
        messages: [{
          role: 'user',
          content: `Help prepare for this upcoming trip:

TRIP: ${trip.title}
${trip.description ? `Details: ${trip.description}` : ''}

USER CONTEXT:
${userPrefs}

Please provide:
1. A practical packing checklist (considering their preferences)
2. Key logistics to remember
3. Things they mentioned wanting to do (if any context available)
4. Any tips specific to their situation

Use web search for current, practical information about the destination.`
        }],
        system: 'You are helping someone prepare for an upcoming trip. Be practical and personalized.'
      });

      const { text, sources } = this.extractResponseContent(response);

      const insight = {
        id: this.generateId('insight'),
        loopId: trip.id,
        loopTitle: trip.title,
        insightType: 'anticipatory',
        content: text,
        conversationHook: `About that ${trip.title} — I put together some prep notes...`,
        sources,
        createdAt: Date.now(),
        status: 'pending'
      };

      // Add staged actions for trip prep
      insight.stagedActions = this.generateStagedActionsForAnticipatory(insight, 'trip', {
        destination: trip.title
      });

      return insight;
    } catch (error) {
      console.error(`❌ [NightOwl] Trip prep failed:`, error.message);
      return null;
    }
  }

  // ============================================================================
  // 3. PATTERN SURFACING
  // ============================================================================

  async surfacePatterns(userContext, healthData, trackingData = {}) {
    console.log('🔍 [NightOwl] Surfacing patterns...');
    const insights = [];

    const patterns = await this.crsService.loadExistingSystemFiles('patterns');

    // Find recently confirmed patterns that haven't been surfaced
    const recentPatterns = patterns.filter(p =>
      p.status === 'confirmed' &&
      p.updatedAt > Date.now() - 7 * 24 * 60 * 60 * 1000 && // Last 7 days
      !p.surfacedAt // Not yet surfaced
    );

    if (recentPatterns.length > 0) {
      const pattern = recentPatterns[0];

      // Include tracking data context if available
      let trackingContext = '';
      if (trackingData.available) {
        const metricNames = Object.keys(trackingData.metrics || {});
        const habitNames = Object.keys(trackingData.habits || {});
        if (metricNames.length > 0 || habitNames.length > 0) {
          trackingContext = `\n\nUSER'S TRACKED DATA:
Metrics being tracked: ${metricNames.join(', ') || 'none'}
Habits being tracked: ${habitNames.join(', ') || 'none'}
Recent activities: ${(trackingData.activities || []).slice(-5).map(a => a.name).join(', ') || 'none'}`;
        }
      }

      try {
        const response = await this.anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 600,
          messages: [{
            role: 'user',
            content: `I've noticed this pattern in the user's behavior/life:

PATTERN: ${pattern.claim}
DOMAIN: ${pattern.domain}
EVIDENCE: ${JSON.stringify(pattern.evidence || [])}${trackingContext}

Please explain this pattern in a warm, insightful way. What might be driving it? Is it helpful or something to be aware of? What could they do with this insight?`
          }],
          system: 'You are sharing a pattern you\'ve noticed with someone. Be warm and insightful, not clinical. Help them understand themselves better.'
        });

        const { text } = this.extractResponseContent(response);

        insights.push({
          id: this.generateId('insight'),
          loopId: null,
          loopTitle: pattern.claim,
          insightType: 'pattern',
          content: text,
          conversationHook: `I noticed something interesting about your patterns...`,
          sources: [],
          metadata: { patternId: pattern.id },
          createdAt: Date.now(),
          status: 'pending'
        });

        // Mark pattern as surfaced
        pattern.surfacedAt = Date.now();
        await this.crsService.writeFile(`system/patterns/pattern_${pattern.id}.json`, pattern);

      } catch (error) {
        console.error(`❌ [NightOwl] Pattern surfacing failed:`, error.message);
      }
    }

    return insights;
  }

  // ============================================================================
  // 4. SMART REMINDERS
  // ============================================================================

  async generateSmartReminders(userContext) {
    console.log('⏰ [NightOwl] Generating smart reminders...');
    const insights = [];

    const facts = userContext.relevantFacts || [];
    const threads = await this.crsService.loadExistingSystemFiles('life_threads');

    // Look for recent events that warrant follow-up
    const recentEventFacts = facts.filter(f => {
      const isRecent = f.createdAt > Date.now() - 2 * 24 * 60 * 60 * 1000; // Last 2 days
      const isEvent = f.category === 'event' ||
        f.content.toLowerCase().includes('interview') ||
        f.content.toLowerCase().includes('meeting') ||
        f.content.toLowerCase().includes('conversation with') ||
        f.content.toLowerCase().includes('talked to');
      return isRecent && isEvent;
    });

    for (const fact of recentEventFacts.slice(0, 1)) { // Max 1 reminder
      // Check if there's already an active thread for follow-up
      const hasThread = (threads || []).some(t =>
        !t.resolved &&
        (t.title.toLowerCase().includes('thank') ||
        t.title.toLowerCase().includes('follow up'))
      );

      if (hasThread) continue;

      // Generate contextual reminder
      try {
        const response = await this.anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 400,
          messages: [{
            role: 'user',
            content: `The user recently had this event/interaction:

"${fact.content}"

Should they follow up with anyone? Send a thank you note? Is there any action that would be appropriate?

If yes, suggest what they should do. If no follow-up is needed, say so briefly.`
          }],
          system: 'You are a thoughtful assistant noticing when follow-ups might be appropriate. Only suggest if it would genuinely be valuable.'
        });

        const { text } = this.extractResponseContent(response);

        // Only create insight if a follow-up is actually suggested
        if (!text.toLowerCase().includes('no follow-up') &&
          !text.toLowerCase().includes('not necessary')) {
          insights.push({
            id: this.generateId('insight'),
            loopId: null,
            loopTitle: 'Follow-up reminder',
            insightType: 'reminder',
            content: text,
            conversationHook: `About that ${fact.content.substring(0, 30)}...`,
            sources: [],
            metadata: { factId: fact.id },
            createdAt: Date.now(),
            status: 'pending'
          });
        }
      } catch (error) {
        console.error(`❌ [NightOwl] Reminder generation failed:`, error.message);
      }
    }

    return insights;
  }

  // ============================================================================
  // 5. ACCOUNTABILITY CHECK
  // ============================================================================

  async checkAccountability(userContext) {
    console.log('📊 [NightOwl] Checking accountability...');
    const insights = [];

    const threads = await this.crsService.loadExistingSystemFiles('life_threads');
    const facts = userContext.relevantFacts || [];

    // Find threads with upcoming milestones
    const commitments = (threads || []).filter(t =>
      !t.resolved &&
      t.nextMilestone?.date
    );

    const now = Date.now();
    const overdue = commitments.filter(c => c.nextMilestone?.date < now);
    const upcoming = commitments.filter(c => {
      const due = c.nextMilestone?.date;
      return due >= now && due < now + 3 * 24 * 60 * 60 * 1000; // Within 3 days
    });

    // Find stalled threads (no recent activity)
    const stalledThreads = (threads || []).filter(t => {
      if (t.resolved) return false;
      if (!['career', 'goal', 'creative'].includes(t.category)) return false;
      const lastUpdate = t.lastUpdate || t.createdAt;
      const daysSinceUpdate = (now - lastUpdate) / (24 * 60 * 60 * 1000);
      return daysSinceUpdate > 7; // No activity in 7+ days
    });

    if (overdue.length > 0 || upcoming.length > 0 || stalledThreads.length > 0) {
      try {
        const response = await this.anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 600,
          messages: [{
            role: 'user',
            content: `Here's the user's accountability status:

OVERDUE (need attention):
${overdue.map(c => `- "${c.title}" (milestone: ${new Date(c.nextMilestone?.date).toLocaleDateString()})`).join('\n') || 'None'}

UPCOMING (within 3 days):
${upcoming.map(c => `- "${c.title}" (milestone: ${new Date(c.nextMilestone?.date).toLocaleDateString()})`).join('\n') || 'None'}

STALLED (no progress in 7+ days):
${stalledThreads.map(t => `- "${t.title}" (${Math.floor((now - (t.lastUpdate || t.createdAt)) / (24 * 60 * 60 * 1000))} days)`).join('\n') || 'None'}

You are Ethan's RELENTLESS accountability partner. He's building toward being an Oscar-winning actor - every day matters.

Give a DIRECT accountability check:
- No sugarcoating - movie stars don't make excuses
- Challenge any avoidance or stalling immediately
- Remind him: "The Oscar winner version of you doesn't let things slide"
- If training/acting work is stalled: "When are you getting this done?"
- Keep the fire lit - that's your job`
          }],
          system: 'You are a relentless accountability partner for an aspiring Oscar-winning actor. Be direct, challenging, and keep the pressure on. No gentle coaching - hold him to the movie star standard.'
        });

        const { text } = this.extractResponseContent(response);

        insights.push({
          id: this.generateId('insight'),
          loopId: null,
          loopTitle: 'Accountability check',
          insightType: 'accountability',
          content: text,
          conversationHook: `Progress check. Show me where you're at.`,
          sources: [],
          createdAt: Date.now(),
          status: 'pending'
        });
      } catch (error) {
        console.error(`❌ [NightOwl] Accountability check failed:`, error.message);
      }
    }

    return insights;
  }

  // ============================================================================
  // 6. CONNECTION FINDING
  // ============================================================================

  async findConnections(userContext) {
    console.log('🔗 [NightOwl] Finding connections...');
    const insights = [];

    const facts = userContext.relevantFacts || [];
    const patterns = userContext.patterns || [];
    const narratives = await this.crsService.loadExistingSystemFiles('narratives');

    // Need enough data to find connections
    if (facts.length < 10 || patterns.length < 2) {
      return insights;
    }

    try {
      // Look for non-obvious connections
      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 800,
        messages: [{
          role: 'user',
          content: `Here's what we know about the user's life:

CONFIRMED PATTERNS:
${patterns.map(p => `- ${p.claim} (${p.domain})`).join('\n')}

KEY NARRATIVES:
${narratives.slice(0, 5).map(n => `- ${n.topic}: ${n.summary || ''}`).join('\n')}

RECENT INSIGHTS/FACTS:
${facts.filter(f => f.category === 'insight' || f.category === 'belief').slice(0, 10).map(f => `- ${f.content}`).join('\n')}

Are there any non-obvious connections between different areas of their life? Things they might not have noticed that connect? For example, a pattern in one area that might explain something in another area.

Only share if you find something genuinely insightful - not forced connections.`
        }],
        system: 'You are an insightful advisor who notices connections across different areas of someone\'s life. Share genuine insights, not forced connections.'
      });

      const { text } = this.extractResponseContent(response);

      // Only add if there's a real insight
      if (!text.toLowerCase().includes('no obvious connections') &&
        !text.toLowerCase().includes('don\'t see any')) {
        insights.push({
          id: this.generateId('insight'),
          loopId: null,
          loopTitle: 'Connection',
          insightType: 'connection',
          content: text,
          conversationHook: `I noticed something interesting connecting a few things...`,
          sources: [],
          createdAt: Date.now(),
          status: 'pending'
        });
      }
    } catch (error) {
      console.error(`❌ [NightOwl] Connection finding failed:`, error.message);
    }

    return insights;
  }

  // ============================================================================
  // 7. HEALTH CORRELATIONS
  // ============================================================================

  async analyzeHealthCorrelations(userContext, healthData, trackingData = {}) {
    console.log('❤️ [NightOwl] Analyzing health correlations...');
    const insights = [];

    // Skip if no health data AND no tracking data
    if (!healthData.available && !trackingData.available) {
      console.log('⏭️ [NightOwl] Skipping health analysis - no data available');
      return insights;
    }

    const facts = userContext.relevantFacts || [];
    const moodFacts = facts.filter(f =>
      f.category === 'emotional' ||
      f.content.toLowerCase().includes('mood') ||
      f.content.toLowerCase().includes('feel')
    );

    // Build tracking data context
    let trackingContext = '';
    if (trackingData.available) {
      const { metrics, habits, activities } = trackingData;

      // Format metrics
      const metricsStr = Object.entries(metrics || {}).map(([name, values]) => {
        const recent = values.slice(-7);
        return `${name}: ${recent.map(v => `${v.date}: ${v.value}`).join(', ')}`;
      }).join('\n');

      // Format habits
      const habitsStr = Object.entries(habits || {}).map(([name, values]) => {
        const recent = values.slice(-7);
        const completed = recent.filter(v => v.completed).length;
        return `${name}: ${completed}/${recent.length} days completed`;
      }).join('\n');

      trackingContext = `
TRACKED METRICS (last 7 days):
${metricsStr || 'No metrics tracked'}

TRACKED HABITS (last 7 days):
${habitsStr || 'No habits tracked'}

RECENT ACTIVITIES:
${(activities || []).slice(-7).map(a => `- ${a.date}: ${a.name}`).join('\n') || 'No activities logged'}
`;
    }

    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 800,
        messages: [{
          role: 'user',
          content: `Here's the user's recent health data, tracking data, and emotional patterns:

SLEEP (last 7 days):
${JSON.stringify(healthData.sleep?.slice(-7) || [], null, 2)}

STEPS (last 7 days):
${JSON.stringify(healthData.steps?.slice(-7) || [], null, 2)}

WORKOUTS (last 7 days):
${JSON.stringify(healthData.workouts?.slice(-7) || [], null, 2)}
${trackingContext}
MOOD/EMOTIONAL FACTS:
${moodFacts.slice(-10).map(f => `- [${f.createdAt ? new Date(f.createdAt).toLocaleDateString() : 'unknown'}] ${f.content}`).join('\n')}

Look for correlations:
- Does sleep quality seem to affect mood?
- Do exercise days correlate with better emotional states?
- Are there patterns in tracked metrics (mood, weight, etc.)?
- How do habit completions relate to wellbeing?
- Any patterns worth noting?

Only share if you find meaningful correlations.`
        }],
        system: 'You are analyzing health and tracking data to find correlations that could help someone understand their wellbeing better. Be insightful but not preachy.'
      });

      const { text } = this.extractResponseContent(response);

      if (!text.toLowerCase().includes('no clear correlation') &&
        !text.toLowerCase().includes('not enough data')) {
        insights.push({
          id: this.generateId('insight'),
          loopId: null,
          loopTitle: 'Health correlation',
          insightType: 'health',
          content: text,
          conversationHook: `I noticed something interesting in your health patterns...`,
          sources: [],
          createdAt: Date.now(),
          status: 'pending'
        });
      }
    } catch (error) {
      console.error(`❌ [NightOwl] Health correlation analysis failed:`, error.message);
    }

    return insights;
  }

  // ============================================================================
  // 8. LEARNING SYNTHESIS
  // ============================================================================

  async synthesizeLearning(userContext) {
    console.log('📚 [NightOwl] Synthesizing learning...');
    const insights = [];

    const facts = userContext.relevantFacts || [];

    // Find learning-related facts
    const learningFacts = facts.filter(f =>
      f.category === 'insight' ||
      f.content.toLowerCase().includes('learning') ||
      f.content.toLowerCase().includes('reading') ||
      f.content.toLowerCase().includes('studying') ||
      f.content.toLowerCase().includes('realized') ||
      f.content.toLowerCase().includes('understood')
    );

    // Need enough learning content
    if (learningFacts.length < 5) {
      return insights;
    }

    // Get goals to connect learning to
    const threads = await this.crsService.loadExistingSystemFiles('life_threads');
    const goals = (threads || []).filter(t =>
      !t.resolved &&
      (t.category === 'goal' ||
        t.title.toLowerCase().includes('goal') ||
        t.title.toLowerCase().includes('learn'))
    );

    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 800,
        messages: [{
          role: 'user',
          content: `Here's what the user has been learning/realizing recently:

INSIGHTS & LEARNING:
${learningFacts.slice(-15).map(f => `- ${f.content}`).join('\n')}

THEIR GOALS:
${goals.map(g => `- ${g.title}`).join('\n') || 'No explicit goals noted'}

Please:
1. Synthesize what they've been learning - what themes emerge?
2. Identify any gaps or next things to explore
3. Connect their learning to their goals if relevant

Be insightful and help them see the bigger picture of their learning journey.`
        }],
        system: 'You are helping someone see the bigger picture of what they\'ve been learning. Connect dots, identify themes, and suggest what might come next.'
      });

      const { text } = this.extractResponseContent(response);

      insights.push({
        id: this.generateId('insight'),
        loopId: null,
        loopTitle: 'Learning synthesis',
        insightType: 'learning',
        content: text,
        conversationHook: `I was thinking about what you've been learning lately...`,
        sources: [],
        createdAt: Date.now(),
        status: 'pending'
      });
    } catch (error) {
      console.error(`❌ [NightOwl] Learning synthesis failed:`, error.message);
    }

    return insights;
  }

  // ============================================================================
  // 9. PLAN ITERATION (research, refine, unblock)
  // ============================================================================

  async iterateOnPlans(userContext) {
    console.log('🎯 [NightOwl] Iterating on plans...');
    const insights = [];

    try {
      const threads = await this.crsService.loadExistingSystemFiles('life_threads');

      // PRIORITIZE MILESTONES FIRST
      const milestoneThreads = (threads || []).filter(t =>
        !t.resolved && t.nextMilestone
      ).sort((a, b) => {
        const aTime = a.nextMilestone?.date || Infinity;
        const bTime = b.nextMilestone?.date || Infinity;
        return aTime - bTime;
      });

      const planThreads = (threads || []).filter(t =>
        !t.resolved &&
        t.category === 'goal' &&
        t.emotionalWeight >= 5
      );

      // Process milestones first (up to 2)
      for (const milestone of milestoneLoops.slice(0, 2)) {
        console.log(`🎯 [NightOwl] Processing MILESTONE: "${milestone.title}"`);
        const insight = await this.prepareMilestone(milestone, userContext);
        if (insight) insights.push(insight);
      }

      // Then regular plans (up to 2 if room)
      const remainingSlots = Math.max(0, 2 - milestoneLoops.length);
      for (const plan of planLoops.slice(0, remainingSlots)) {
        console.log(`🎯 [NightOwl] Analyzing plan: "${plan.title}"`);

        // Determine what kind of iteration this plan needs
        const iterationType = await this.determinePlanIterationType(plan, userContext);

        let planInsight = null;
        switch (iterationType) {
          case 'research':
            planInsight = await this.researchPlan(plan, userContext);
            break;
          case 'refine':
            planInsight = await this.refinePlan(plan, userContext);
            break;
          case 'unblock':
            planInsight = await this.unblockPlan(plan, userContext);
            break;
          case 'breakdown':
            planInsight = await this.breakdownPlan(plan, userContext);
            break;
          default:
            planInsight = await this.generalPlanAnalysis(plan, userContext);
        }

        if (planInsight) {
          insights.push(planInsight);
        }
      }

    } catch (error) {
      console.error('❌ [NightOwl] Plan iteration failed:', error.message);
    }

    return insights;
  }

  async prepareMilestone(milestone, userContext) {
    console.log(`🌟 [NightOwl] Deep prep for milestone: "${milestone.title}"`);

    // Get related entity context
    const relatedContext = await this.getRelatedEntitiesContext(milestone.relatedEntityIds || [], userContext);

    const systemPrompt = `You are helping someone prepare for a highly significant upcoming event/milestone.

This is IMPORTANT to them - they've been counting down to it. Your preparation should:
- Acknowledge the emotional significance
- Help them mentally/emotionally prepare
- Surface any practical considerations
- Offer perspective that might help them be present for it
- Be warm and supportive, not clinical

This isn't just logistics - it's something meaningful to them.`;

    const userPrompt = `Help prepare for this significant milestone:

MILESTONE: ${milestone.title}
${milestone.dueDate ? `Date: ${milestone.dueDate}` : ''}
${milestone.description ? `Context: ${milestone.description}` : ''}

RELATED CONTEXT:
${relatedContext}

USER PATTERNS:
${this.buildPatternsContext(userContext)}

Please provide:
1. Emotional/mental preparation thoughts
2. Practical considerations they might want to think through
3. How to be fully present for this moment
4. Any patterns from their life relevant to this

Be warm and recognize this matters to them.`;

    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        tools: [WEB_SEARCH_TOOL],
        messages: [{ role: 'user', content: userPrompt }],
        system: systemPrompt
      });

      const { text, sources } = this.extractResponseContent(response);

      return {
        id: this.generateId('milestone_insight'),
        loopId: milestone.id,
        loopTitle: milestone.title,
        insightType: 'milestone_prep',
        content: text,
        conversationHook: `About ${milestone.dueDate || 'the big day'}...`,
        sources,
        isMilestone: true,
        createdAt: Date.now(),
        status: 'pending'
      };

    } catch (error) {
      console.error(`❌ [NightOwl] Milestone prep failed:`, error.message);
      return null;
    }
  }

  async determinePlanIterationType(plan, userContext) {
    const daysSinceUpdate = (Date.now() - (plan.updatedAt || plan.createdAt)) / (24 * 60 * 60 * 1000);

    // If stalled for 5+ days, likely blocked
    if (daysSinceUpdate >= 5) return 'unblock';

    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 50,
        messages: [{
          role: 'user',
          content: `What does this plan need most?

PLAN: "${plan.title}"
${plan.description ? `Details: ${plan.description}` : ''}

Options:
- research: Needs information gathering, exploring options
- refine: Has direction but needs more concrete steps
- breakdown: Too vague, needs to be split into tasks
- general: Just needs fresh perspective

Reply with ONLY the option name.`
        }],
        system: 'Classify what this plan needs. Reply with only one word.'
      });

      const type = response.content[0]?.text?.trim().toLowerCase();
      return ['research', 'refine', 'breakdown', 'general'].includes(type) ? type : 'general';

    } catch {
      return 'general';
    }
  }

  // ============================================================================
  // ITERATIVE PLAN RESEARCH SYSTEM
  // ============================================================================

  /**
   * Research a plan iteratively - discovers user context, researches solutions,
   * filters for fit, and creates actionable steps
   */
  async researchPlan(plan, userContext) {
    console.log(`🔍 [NightOwl] Starting iterative plan research: "${plan.title}"`);

    const config = {
      maxIterations: 3,
      maxQuestionsPerPhase: 4
    };

    try {
      // PHASE 1: Discover what we know about the user relevant to this plan
      console.log(`🔎 [NightOwl] Phase 1: Discovering user context...`);
      const userDiscovery = await this.discoverRelevantUserContext(plan, userContext);

      // PHASE 2: Diagnose - what are the key questions/factors for this plan?
      console.log(`🔎 [NightOwl] Phase 2: Diagnosing key factors...`);
      const diagnosis = await this.diagnosePlanFactors(plan, userDiscovery, userContext);

      // PHASE 3: Research solutions iteratively
      console.log(`🔎 [NightOwl] Phase 3: Researching solutions...`);
      const allFindings = [];
      let questionsToResearch = diagnosis.researchQuestions.slice(0, config.maxQuestionsPerPhase);
      let iteration = 0;

      while (iteration < config.maxIterations && questionsToResearch.length > 0) {
        iteration++;
        console.log(`  🔄 Research iteration ${iteration}/${config.maxIterations}`);

        const findings = await this.executeResearchIteration(
          questionsToResearch,
          plan,
          this.buildUserPreferencesContext(userContext),
          config.maxQuestionsPerPhase
        );

        allFindings.push(...findings);

        // Check for gaps
        if (iteration < config.maxIterations) {
          const gaps = await this.evaluatePlanResearchGaps(
            plan,
            allFindings,
            diagnosis,
            userDiscovery
          );

          if (gaps.length === 0) {
            console.log(`  ✅ Research complete`);
            break;
          }

          questionsToResearch = gaps.slice(0, config.maxQuestionsPerPhase);
        }
      }

      // PHASE 4: Filter and personalize
      console.log(`🔎 [NightOwl] Phase 4: Filtering for user fit...`);
      const filteredPlan = await this.filterAndPersonalizePlan(
        plan,
        allFindings,
        userDiscovery,
        diagnosis,
        userContext
      );

      // Collect sources
      const allSources = [...new Set(allFindings.flatMap(f => f.sources || []))];

      // PHASE 5: Generate staged actions for user approval
      console.log(`🔎 [NightOwl] Phase 5: Generating staged actions...`);
      const stagedActions = await this.generateStagedActionsForPlan(plan, filteredPlan, allFindings);

      return {
        id: this.generateId('plan_insight'),
        loopId: plan.id,
        loopTitle: plan.title,
        insightType: 'plan_research',
        content: filteredPlan,
        conversationHook: await this.generatePlanConversationHook(plan, 'research', filteredPlan),
        sources: allSources,
        stagedActions,
        metadata: {
          iterations: iteration,
          questionsResearched: allFindings.length,
          userFactorsConsidered: userDiscovery.relevantFactors,
          diagnosis: diagnosis.summary
        },
        createdAt: Date.now(),
        status: 'pending'
      };

    } catch (error) {
      console.error(`❌ [NightOwl] Iterative plan research failed:`, error.message);
      return await this.doSimplePlanResearch(plan, userContext);
    }
  }

  /**
   * PHASE 1: Discover what we know about the user relevant to this plan
   */
  async discoverRelevantUserContext(plan, userContext) {
    const { relevantFacts, relevantEntities, patterns } = userContext;

    // Let Claude identify what's relevant
    const response = await this.anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1200,
      messages: [{
        role: 'user',
        content: `Analyze what we know about this user that's relevant to their plan.

PLAN: ${plan.title}
${plan.description ? `DETAILS: ${plan.description}` : ''}

USER FACTS:
${(relevantFacts || []).slice(0, 30).map(f => `- [${f.category || 'general'}] ${f.content}`).join('\n') || 'No facts recorded'}

USER PATTERNS:
${(patterns || []).map(p => `- ${p.claim} (${p.domain})`).join('\n') || 'No patterns identified'}

ENTITIES IN THEIR LIFE:
${(relevantEntities || []).slice(0, 10).map(e => `- ${e.name} (${e.category}): ${e.description || 'no description'}`).join('\n') || 'None recorded'}

Identify:
1. What relevant information do we HAVE about them for this plan?
2. What relevant information are we MISSING that would help?
3. What constraints or preferences should we account for?
4. Any patterns that might affect success?

Respond in JSON:
{
  "relevantFactors": ["factor1", "factor2"],
  "knownConstraints": ["budget-conscious", "time-limited", etc],
  "knownPreferences": ["prefers natural products", etc],
  "missingInformation": ["skin type unknown", "current routine unknown", etc],
  "relevantPatterns": ["tends to start strong then fade", etc],
  "summary": "Brief synthesis of what we know"
}`
      }],
      system: 'You are analyzing user data to understand their context for a plan. Be specific about what we know vs don\'t know. Respond only with valid JSON.'
    });

    try {
      const text = response.content[0]?.text || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch (e) {
      console.warn(`⚠️ [NightOwl] Failed to parse user discovery`);
    }

    return {
      relevantFactors: [],
      knownConstraints: [],
      knownPreferences: [],
      missingInformation: ['Unable to analyze user context'],
      relevantPatterns: [],
      summary: 'Could not analyze user context'
    };
  }

  /**
   * PHASE 2: Diagnose key factors and generate research questions
   */
  async diagnosePlanFactors(plan, userDiscovery, userContext) {
    const response = await this.anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      tools: [WEB_SEARCH_TOOL],
      messages: [{
        role: 'user',
        content: `Diagnose the key factors for this plan and generate research questions.

PLAN: ${plan.title}
${plan.description ? `DETAILS: ${plan.description}` : ''}

WHAT WE KNOW ABOUT THE USER:
${userDiscovery.summary}

Known constraints: ${userDiscovery.knownConstraints.join(', ') || 'none identified'}
Known preferences: ${userDiscovery.knownPreferences.join(', ') || 'none identified'}
Missing information: ${userDiscovery.missingInformation.join(', ') || 'none'}
Relevant patterns: ${userDiscovery.relevantPatterns.join(', ') || 'none'}

Based on current best practices and the user's situation:
1. What are the key factors/variables that determine success for this type of plan?
2. What are the main approaches or schools of thought?
3. What specific research questions should we investigate given THEIR situation?

Use web search to understand current best practices before generating questions.

Respond in JSON:
{
  "keyFactors": ["factor1 and why it matters", "factor2 and why it matters"],
  "mainApproaches": [
    {"name": "approach1", "description": "what it involves", "bestFor": "who it's best for"}
  ],
  "researchQuestions": [
    {"question": "specific searchable question", "priority": 1, "rationale": "why this matters for them"}
  ],
  "hypotheses": ["Based on what we know, X approach might work because Y"],
  "summary": "Brief diagnosis of their situation"
}`
      }],
      system: 'You are diagnosing a plan to understand what research is needed. Use web search to ground your diagnosis in current best practices. Respond only with valid JSON.'
    });

    try {
      const text = response.content[0]?.text || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch (e) {
      console.warn(`⚠️ [NightOwl] Failed to parse diagnosis`);
    }

    // Fallback
    return {
      keyFactors: [],
      mainApproaches: [],
      researchQuestions: [{ question: `How to ${plan.title}`, priority: 1, rationale: 'Main question' }],
      hypotheses: [],
      summary: 'Could not complete diagnosis'
    };
  }

  /**
   * Evaluate gaps specific to plan research
   */
  async evaluatePlanResearchGaps(plan, findings, diagnosis, userDiscovery) {
    const findingsSummary = findings.map(f =>
      `Q: ${f.question}\nA: ${f.answer.substring(0, 400)}...`
    ).join('\n\n');

    const response = await this.anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `Evaluate research completeness for creating an actionable plan.

PLAN: ${plan.title}

USER'S SITUATION:
${userDiscovery.summary}
Constraints: ${userDiscovery.knownConstraints.join(', ') || 'none'}
Preferences: ${userDiscovery.knownPreferences.join(', ') || 'none'}

KEY FACTORS IDENTIFIED:
${diagnosis.keyFactors.join('\n')}

RESEARCH COMPLETED:
${findingsSummary}

Can we create an actionable, personalized plan with this research?
What critical gaps remain that would significantly improve the plan?

Respond in JSON:
{
  "gaps": [
    {"question": "what we still need to know", "importance": "high/medium", "reason": "why"}
  ],
  "completeness": 0.0-1.0,
  "canCreatePlan": true/false,
  "assessment": "brief assessment"
}`
      }],
      system: 'Evaluate if research is sufficient for an actionable plan. Only flag gaps that would meaningfully improve it. Respond only with valid JSON.'
    });

    try {
      const text = response.content[0]?.text || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const evaluation = JSON.parse(jsonMatch[0]);

        if (evaluation.completeness >= 0.75 || evaluation.canCreatePlan) {
          return [];
        }

        return (evaluation.gaps || [])
          .filter(g => g.importance === 'high')
          .map(g => g.question);
      }
    } catch (e) {
      console.warn(`⚠️ [NightOwl] Failed to parse gap evaluation`);
    }

    return [];
  }

  /**
   * PHASE 4: Filter findings and create personalized plan
   */
  async filterAndPersonalizePlan(plan, findings, userDiscovery, diagnosis, userContext) {
    const findingsText = findings.map(f =>
      `### ${f.question}\n${f.answer}`
    ).join('\n\n');

    const response = await this.anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2500,
      messages: [{
        role: 'user',
        content: `Create a personalized, actionable plan based on this research.

GOAL: ${plan.title}
${plan.description ? `CONTEXT: ${plan.description}` : ''}

USER'S SITUATION:
${userDiscovery.summary}

CONSTRAINTS TO WORK WITHIN:
${userDiscovery.knownConstraints.map(c => `- ${c}`).join('\n') || '- None identified'}

PREFERENCES TO HONOR:
${userDiscovery.knownPreferences.map(p => `- ${p}`).join('\n') || '- None identified'}

PATTERNS TO ACCOUNT FOR:
${userDiscovery.relevantPatterns.map(p => `- ${p}`).join('\n') || '- None identified'}

HYPOTHESES ABOUT WHAT MIGHT WORK FOR THEM:
${diagnosis.hypotheses.map(h => `- ${h}`).join('\n') || '- No specific hypotheses'}

RESEARCH FINDINGS:
${findingsText}

Create a personalized plan that:
1. Is specifically tailored to THEIR situation, constraints, and preferences
2. Accounts for their patterns (e.g., if they tend to fade, build in accountability)
3. Starts with quick wins to build momentum
4. Has clear, concrete steps (not vague advice)
5. Includes specific product/resource recommendations where appropriate
6. Explains WHY each recommendation fits them specifically
7. Acknowledges what we don't know and how they can figure it out
8. Has a realistic timeline

Write conversationally - this will be delivered in chat. Don't use generic headers like "Personalized Plan:" - just provide the helpful, specific content.`
      }],
      system: 'Create a highly personalized, actionable plan. Every recommendation should be justified by their specific situation. Be concrete and specific, not generic.'
    });

    return response.content[0]?.text?.trim() || 'Could not create personalized plan.';
  }

  /**
   * Fallback: Simple plan research
   */
  async doSimplePlanResearch(plan, userContext) {
    console.log(`🔍 [NightOwl] Falling back to simple plan research`);

    const userPrefs = this.buildUserPreferencesContext(userContext);

    const response = await this.anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      tools: [WEB_SEARCH_TOOL],
      messages: [{
        role: 'user',
        content: `Research and create a plan for: ${plan.title}
${plan.description ? `Details: ${plan.description}` : ''}

User context:
${userPrefs}

Provide practical, actionable recommendations.`
      }],
      system: 'Create a helpful, personalized plan based on research. Use web search for current information.'
    });

    const { text, sources } = this.extractResponseContent(response);

    return {
      id: this.generateId('plan_insight'),
      loopId: plan.id,
      loopTitle: plan.title,
      insightType: 'plan_research',
      content: text,
      conversationHook: await this.generatePlanConversationHook(plan, 'research', text),
      sources,
      createdAt: Date.now(),
      status: 'pending'
    };
  }

  /**
   * Refine a plan - now uses iterative approach to make it more concrete
   */
  async refinePlan(plan, userContext) {
    console.log(`🎨 [NightOwl] Refining plan iteratively: "${plan.title}"`);

    try {
      // Discover context
      const userDiscovery = await this.discoverRelevantUserContext(plan, userContext);

      // Analyze current plan state
      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: `Analyze this plan and identify what needs refinement.

PLAN: ${plan.title}
${plan.description ? `CURRENT STATE: ${plan.description}` : 'No details yet'}

USER CONTEXT:
${userDiscovery.summary}
Constraints: ${userDiscovery.knownConstraints.join(', ') || 'none'}
Preferences: ${userDiscovery.knownPreferences.join(', ') || 'none'}

What aspects of this plan are:
1. Too vague and need specifics?
2. Missing important considerations?
3. Not aligned with their constraints/preferences?
4. Lacking concrete next steps?

Respond in JSON:
{
  "vagueAreas": ["area1", "area2"],
  "missingConsiderations": ["consideration1"],
  "alignmentIssues": ["issue1"],
  "refinementQuestions": ["specific question to research to refine this"],
  "assessment": "overall assessment"
}`
        }],
        system: 'Analyze a plan to identify refinement needs. Respond only with valid JSON.'
      });

      let refinementNeeds;
      try {
        const text = response.content[0]?.text || '';
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        refinementNeeds = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
      } catch (e) {
        refinementNeeds = null;
      }

      // Research refinements if needed
      const findings = [];
      if (refinementNeeds?.refinementQuestions?.length > 0) {
        const researchFindings = await this.executeResearchIteration(
          refinementNeeds.refinementQuestions.slice(0, 3),
          plan,
          this.buildUserPreferencesContext(userContext),
          3
        );
        findings.push(...researchFindings);
      }

      // Generate refined plan
      const refinedPlan = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: `Refine this plan to be more specific and actionable.

ORIGINAL PLAN: ${plan.title}
${plan.description ? `CURRENT STATE: ${plan.description}` : ''}

REFINEMENT ANALYSIS:
${refinementNeeds ? JSON.stringify(refinementNeeds, null, 2) : 'No specific analysis'}

ADDITIONAL RESEARCH:
${findings.map(f => `Q: ${f.question}\nA: ${f.answer}`).join('\n\n') || 'None'}

USER CONTEXT:
${userDiscovery.summary}
Constraints: ${userDiscovery.knownConstraints.join(', ') || 'none'}  
Preferences: ${userDiscovery.knownPreferences.join(', ') || 'none'}

Create a refined version that:
1. Makes vague areas specific
2. Addresses missing considerations
3. Aligns with their constraints and preferences
4. Has clear, concrete next steps with timelines
5. Builds in checkpoints or accountability

Be conversational - this goes in chat.`
        }],
        system: 'Refine plans to be specific and actionable. Every step should be concrete enough to act on.'
      });

      const sources = [...new Set(findings.flatMap(f => f.sources || []))];

      return {
        id: this.generateId('plan_insight'),
        loopId: plan.id,
        loopTitle: plan.title,
        insightType: 'plan_refinement',
        content: refinedPlan.content[0]?.text?.trim(),
        conversationHook: await this.generatePlanConversationHook(plan, 'refine', refinedPlan.content[0]?.text),
        sources,
        createdAt: Date.now(),
        status: 'pending'
      };

    } catch (error) {
      console.error(`❌ [NightOwl] Plan refinement failed:`, error.message);
      return null;
    }
  }

  /**
   * Unblock a stalled plan - diagnose why it's stuck and find solutions
   */
  async unblockPlan(plan, userContext) {
    console.log(`🔓 [NightOwl] Unblocking plan: "${plan.title}"`);

    const daysSinceUpdate = Math.floor((Date.now() - (plan.updatedAt || plan.createdAt)) / (24 * 60 * 60 * 1000));

    try {
      // Discover user context including patterns
      const userDiscovery = await this.discoverRelevantUserContext(plan, userContext);

      // Diagnose the block
      const diagnosisResponse = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: `Diagnose why this plan has stalled.

PLAN: ${plan.title}
${plan.description ? `DETAILS: ${plan.description}` : ''}
STALLED FOR: ${daysSinceUpdate} days

USER PATTERNS:
${userDiscovery.relevantPatterns.map(p => `- ${p}`).join('\n') || '- No patterns identified'}

USER CONSTRAINTS:
${userDiscovery.knownConstraints.map(c => `- ${c}`).join('\n') || '- None identified'}

Common reasons plans stall:
- Too vague / unclear next step
- Overwhelm / too big
- Missing resource or information
- Competing priorities
- Psychological resistance (fear, perfectionism)
- External blocker
- Lost motivation / forgot why it matters

What's most likely blocking THIS plan for THIS person?

Respond in JSON:
{
  "likelyBlockers": [
    {"blocker": "description", "likelihood": "high/medium/low", "evidence": "why you think this"}
  ],
  "questionsToResearch": ["specific question that might help unblock"],
  "quickWins": ["small action that could rebuild momentum"],
  "assessment": "overall diagnosis"
}`
        }],
        system: 'Diagnose why plans stall. Consider both practical and psychological factors. Respond only with valid JSON.'
      });

      let diagnosis;
      try {
        const text = diagnosisResponse.content[0]?.text || '';
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        diagnosis = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
      } catch (e) {
        diagnosis = null;
      }

      // Research solutions for the blockers
      const findings = [];
      if (diagnosis?.questionsToResearch?.length > 0) {
        const researchFindings = await this.executeResearchIteration(
          diagnosis.questionsToResearch.slice(0, 2),
          plan,
          this.buildUserPreferencesContext(userContext),
          2
        );
        findings.push(...researchFindings);
      }

      // Generate unblock strategy
      const unblockResponse = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        messages: [{
          role: 'user',
          content: `Create a strategy to unblock this stalled plan.

PLAN: ${plan.title}
STALLED FOR: ${daysSinceUpdate} days

DIAGNOSIS:
${diagnosis ? JSON.stringify(diagnosis, null, 2) : 'Could not diagnose'}

RESEARCH ON SOLUTIONS:
${findings.map(f => `Q: ${f.question}\nA: ${f.answer}`).join('\n\n') || 'None'}

USER CONTEXT:
${userDiscovery.summary}
Their patterns: ${userDiscovery.relevantPatterns.join(', ') || 'none identified'}

Create an unblocking strategy that:
1. Acknowledges what's likely really going on (empathetically)
2. Addresses the specific blockers identified
3. Provides ONE clear, small next step they can take TODAY
4. Rebuilds momentum gradually
5. Accounts for their patterns (to prevent re-stalling)
6. Reframes or reconnects to why this matters

Be warm and encouraging, not preachy. This goes in chat.`
        }],
        system: 'Help people get unstuck on stalled plans. Be empathetic and practical. Small steps matter.'
      });

      const sources = [...new Set(findings.flatMap(f => f.sources || []))];

      return {
        id: this.generateId('plan_insight'),
        loopId: plan.id,
        loopTitle: plan.title,
        insightType: 'plan_unblock',
        content: unblockResponse.content[0]?.text?.trim(),
        conversationHook: await this.generatePlanConversationHook(plan, 'blocked', unblockResponse.content[0]?.text),
        sources,
        metadata: {
          daysSinceUpdate,
          diagnosis: diagnosis?.assessment
        },
        createdAt: Date.now(),
        status: 'pending'
      };

    } catch (error) {
      console.error(`❌ [NightOwl] Plan unblocking failed:`, error.message);
      return null;
    }
  }

  /**
   * Break down a vague plan into concrete steps
   */
  async breakdownPlan(plan, userContext) {
    console.log(`📋 [NightOwl] Breaking down plan: "${plan.title}"`);

    try {
      // Discover context
      const userDiscovery = await this.discoverRelevantUserContext(plan, userContext);

      // Research how to approach this type of goal
      const approachFindings = await this.executeResearchIteration(
        [
          `Step by step guide to ${plan.title}`,
          `Common mistakes when trying to ${plan.title}`,
          `How long does it take to ${plan.title}`
        ],
        plan,
        this.buildUserPreferencesContext(userContext),
        3
      );

      // Generate breakdown
      const breakdownResponse = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: `Break down this goal into a concrete, actionable plan.

GOAL: ${plan.title}
${plan.description ? `CONTEXT: ${plan.description}` : ''}

RESEARCH ON APPROACH:
${approachFindings.map(f => `### ${f.question}\n${f.answer}`).join('\n\n')}

USER CONTEXT:
${userDiscovery.summary}
Constraints: ${userDiscovery.knownConstraints.join(', ') || 'none'}
Preferences: ${userDiscovery.knownPreferences.join(', ') || 'none'}
Patterns: ${userDiscovery.relevantPatterns.join(', ') || 'none'}

Create a breakdown that:
1. Starts with a single "first step" they can do in under 15 minutes
2. Organizes steps into phases (e.g., Week 1-2, Week 3-4)
3. Makes each step specific enough to act on without thinking
4. Includes how to know when each step is "done"
5. Builds in early wins to create momentum
6. Accounts for their patterns and constraints
7. Flags decision points where they'll need to choose a path
8. Estimates realistic timeframes

Be conversational - this goes in chat. Make it feel achievable, not overwhelming.`
        }],
        system: 'Break down goals into concrete, actionable steps. Make it feel achievable. First steps should be tiny.'
      });

      const sources = [...new Set(approachFindings.flatMap(f => f.sources || []))];

      return {
        id: this.generateId('plan_insight'),
        loopId: plan.id,
        loopTitle: plan.title,
        insightType: 'plan_breakdown',
        content: breakdownResponse.content[0]?.text?.trim(),
        conversationHook: await this.generatePlanConversationHook(plan, 'breakdown', breakdownResponse.content[0]?.text),
        sources,
        createdAt: Date.now(),
        status: 'pending'
      };

    } catch (error) {
      console.error(`❌ [NightOwl] Plan breakdown failed:`, error.message);
      return null;
    }
  }

  /**
   * General plan analysis - provides strategic insight
   */
  async generalPlanAnalysis(plan, userContext) {
    console.log(`🤔 [NightOwl] Analyzing plan: "${plan.title}"`);

    try {
      const userDiscovery = await this.discoverRelevantUserContext(plan, userContext);

      // Research relevant strategic considerations
      const findings = await this.executeResearchIteration(
        [`Best practices for ${plan.title}`, `What to consider when ${plan.title}`],
        plan,
        this.buildUserPreferencesContext(userContext),
        2
      );

      const analysisResponse = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        messages: [{
          role: 'user',
          content: `Provide strategic insight on this plan.

PLAN: ${plan.title}
${plan.description ? `DETAILS: ${plan.description}` : ''}

RESEARCH:
${findings.map(f => `### ${f.question}\n${f.answer}`).join('\n\n')}

USER CONTEXT:
${userDiscovery.summary}
Constraints: ${userDiscovery.knownConstraints.join(', ') || 'none'}
Patterns: ${userDiscovery.relevantPatterns.join(', ') || 'none'}

Provide strategic analysis:
1. What's the most important thing to get right?
2. What's a non-obvious approach they should consider?
3. What pitfalls should they watch for given their patterns?
4. How does this connect to their broader life/goals?
5. What would make this 10x more likely to succeed?

Be insightful, not generic. This goes in chat.`
        }],
        system: 'Provide strategic insight on plans. Go beyond obvious advice. Be specific to their situation.'
      });

      const sources = [...new Set(findings.flatMap(f => f.sources || []))];

      return {
        id: this.generateId('plan_insight'),
        loopId: plan.id,
        loopTitle: plan.title,
        insightType: 'plan_analysis',
        content: analysisResponse.content[0]?.text?.trim(),
        conversationHook: await this.generatePlanConversationHook(plan, 'analysis', analysisResponse.content[0]?.text),
        sources,
        createdAt: Date.now(),
        status: 'pending'
      };

    } catch (error) {
      console.error(`❌ [NightOwl] Plan analysis failed:`, error.message);
      return null;
    }
  }

  // ============================================================================
  // PERSONALITY-DRIVEN CONVERSATION HOOKS
  // ============================================================================

  /**
   * Generate natural conversation hook through personality system
   */
  async generatePlanConversationHook(plan, type, insightContent) {
    // Try to get personality traits from RTCS
    let personality = null;
    try {
      personality = await this.crsService.readFile('system/personality/traits.json');
    } catch (e) {
      // Fall back to neutral
    }

    const traits = personality?.traits || {
      warmth: 0.7,
      directness: 0.5,
      playfulness: 0.3,
      formality: 0.3
    };

    const typeContext = {
      research: 'substantial research findings to share',
      stalled: 'observations about why the plan has stalled',
      blocked: 'ideas for getting past blockers',
      refine: 'suggestions for making steps more concrete',
      breakdown: 'a step-by-step breakdown of the plan',
      analysis: 'strategic insights about the plan'
    };

    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 150,
        messages: [{
          role: 'user',
          content: `Generate a single natural conversation opener for sharing ${typeContext[type]} about "${plan.title}".

PERSONALITY TRAITS:
- Warmth: ${traits.warmth}/1.0 ${traits.warmth > 0.7 ? '(warm, caring)' : traits.warmth < 0.3 ? '(reserved)' : '(balanced)'}
- Directness: ${traits.directness}/1.0 ${traits.directness > 0.7 ? '(gets to the point)' : traits.directness < 0.3 ? '(gentle, indirect)' : '(balanced)'}
- Playfulness: ${traits.playfulness}/1.0 ${traits.playfulness > 0.7 ? '(light, playful)' : traits.playfulness < 0.3 ? '(serious)' : '(balanced)'}
- Formality: ${traits.formality}/1.0 ${traits.formality > 0.7 ? '(formal)' : traits.formality < 0.3 ? '(casual)' : '(balanced)'}

RULES:
- One sentence only
- Must invite engagement (not just announce)
- Should feel like a friend who's been thinking about this, not a notification
- Match the personality traits above
- Don't be sycophantic or over-eager

Return ONLY the opener, nothing else.`
        }],
        system: 'Generate natural, personality-consistent conversation openers. Return only the opener text.'
      });

      return response.content[0]?.text?.trim() || this.getFallbackHook(plan, type);

    } catch (error) {
      console.warn('⚠️ [NightOwl] Hook generation failed, using fallback');
      return this.getFallbackHook(plan, type);
    }
  }

  /**
   * Fallback if dynamic generation fails
   */
  getFallbackHook(plan, type) {
    const fallbacks = {
      research: `I looked into ${plan.title} — want to hear what I found?`,
      stalled: `Can we talk about ${plan.title}?`,
      blocked: `I have some thoughts on ${plan.title} — interested?`,
      refine: `I've been thinking about ${plan.title}.`,
      breakdown: `I broke down ${plan.title} into steps — want to see?`,
      analysis: `I have some strategic thoughts on ${plan.title}.`
    };
    return fallbacks[type] || `About ${plan.title}...`;
  }

  // ============================================================================
  // HELPER METHODS
  // ============================================================================

  extractPersonNames(text, entities) {
    const names = [];
    for (const entity of entities) {
      if (entity.category !== 'people' || entity.id === 'self') continue;
      if (text.toLowerCase().includes(entity.name.toLowerCase())) {
        names.push(entity.name);
      }
      for (const alias of (entity.aliases || [])) {
        if (text.toLowerCase().includes(alias.toLowerCase())) {
          names.push(entity.name);
          break;
        }
      }
    }
    return [...new Set(names)];
  }

  async getPersonContext(name, userContext) {
    const entity = userContext.relevantEntities?.find(e =>
      e.name.toLowerCase() === name.toLowerCase()
    );
    if (!entity) return null;

    const facts = userContext.relevantFacts?.filter(f => f.entityId === entity.id) || [];

    let context = `${entity.name}`;
    if (entity.relationshipToSelf) context += ` (${entity.relationshipToSelf})`;
    if (entity.description) context += `: ${entity.description}`;
    context += '\n';

    if (facts.length > 0) {
      context += 'Facts:\n' + facts.slice(0, 5).map(f => `- ${f.content}`).join('\n');
    }

    return context;
  }

  async getThreadsInvolvingPerson(name) {
    const threads = await this.crsService.loadExistingSystemFiles('life_threads');
    const involving = (threads || []).filter(t =>
      !t.resolved &&
      t.title.toLowerCase().includes(name.toLowerCase())
    );

    if (involving.length === 0) return 'None';
    return involving.map(t => `- ${t.title}`).join('\n');
  }

  buildUserPreferencesContext(userContext) {
    const parts = [];

    if (userContext.selfIdentity?.diet) {
      parts.push(`- Diet: ${userContext.selfIdentity.diet}`);
    }

    if (userContext.selfIdentity?.preferences?.length > 0) {
      parts.push(`- Preferences: ${userContext.selfIdentity.preferences.slice(0, 5).join('; ')}`);
    }

    // Add relevant facts
    const importantFacts = userContext.relevantFacts
      ?.filter(f => f.confidence > 0.7)
      ?.slice(0, 10)
      ?.map(f => `- ${f.content}`);

    if (importantFacts?.length > 0) {
      parts.push(...importantFacts);
    }

    return parts.length > 0 ? parts.join('\n') : 'No specific preferences known yet.';
  }

  buildPatternsContext(userContext) {
    const patterns = userContext.patterns
      ?.slice(0, 5)
      ?.map(p => `- ${p.claim}`)
      ?.join('\n');

    return patterns || 'No confirmed patterns yet.';
  }

  async getRelatedEntitiesContext(entityIds, userContext) {
    if (!entityIds || entityIds.length === 0) return '';

    const relatedEntities = userContext.relevantEntities
      ?.filter(e => entityIds.includes(e.id))
      ?.map(e => {
        let desc = `- ${e.name} (${e.category})`;
        if (e.description) desc += `: ${e.description}`;
        if (e.relationshipToSelf) desc += ` [${e.relationshipToSelf}]`;
        return desc;
      });

    return relatedEntities?.length > 0
      ? `Related people/things:\n${relatedEntities.join('\n')}`
      : '';
  }

  // ============================================================================
  // RESPONSE PARSING
  // ============================================================================

  extractResponseContent(response) {
    let text = '';
    const sources = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        text += block.text;
      }
      if (block.type === 'web_search_tool_result') {
        // Extract sources from search results
        for (const result of block.content || []) {
          if (result.url) {
            sources.push(result.url);
          }
        }
      }
    }

    return { text: text.trim(), sources: [...new Set(sources)] };
  }

  // ============================================================================
  // CONVERSATION HOOKS
  // ============================================================================

  generateConversationHook(loop, type) {
    const title = loop.title;

    const hooks = {
      research: [
        `I did some research on ${title}...`,
        `I was thinking about ${title} and looked into some things...`,
        `About ${title} — I found some interesting stuff...`
      ],
      decision: [
        `I've been thinking about that decision regarding ${title}...`,
        `About ${title} — I had some thoughts that might help...`,
        `I was mulling over ${title}...`
      ],
      preparation: [
        `About ${title} — I thought through some approaches...`,
        `I was thinking about how to handle ${title}...`,
        `Regarding ${title}, I had some ideas...`
      ],
      general: [
        `I was thinking about ${title}...`,
        `About ${title} — had a thought...`,
        `Something came to mind about ${title}...`
      ]
    };

    const typeHooks = hooks[type] || hooks.general;
    return typeHooks[Math.floor(Math.random() * typeHooks.length)];
  }

  // ============================================================================
  // PERSISTENCE
  // ============================================================================

  async saveInsight(insight) {
    try {
      const path = `system/nightowl/insight_${insight.id}.json`;
      await this.crsService.writeFile(path, insight);
      console.log(`💾 [NightOwl] Saved insight: ${insight.id}`);
    } catch (error) {
      console.error(`❌ [NightOwl] Failed to save insight:`, error.message);
    }
  }

  async getPendingInsights() {
    try {
      const files = await this.crsService.listFiles('system/nightowl');
      const insights = [];

      for (const file of files) {
        if (file.name.startsWith('insight_') && file.name.endsWith('.json')) {
          const insight = await this.crsService.readFile(`system/nightowl/${file.name}`);
          if (insight && insight.status === 'pending') {
            insights.push(insight);
          }
        }
      }

      // Sort by createdAt DESCENDING - newest first (most relevant for immediate processing)
      return insights.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    } catch (error) {
      console.error(`❌ [NightOwl] Failed to get pending insights:`, error.message);
      return [];
    }
  }

  async markInsightDelivered(insightId) {
    try {
      const path = `system/nightowl/insight_${insightId}.json`;
      const insight = await this.crsService.readFile(path);
      if (insight) {
        insight.status = 'delivered';
        insight.deliveredAt = Date.now();
        await this.crsService.writeFile(path, insight);
      }
    } catch (error) {
      console.error(`❌ [NightOwl] Failed to mark insight delivered:`, error.message);
    }
  }

  async dismissInsight(insightId) {
    try {
      const path = `system/nightowl/insight_${insightId}.json`;
      const insight = await this.crsService.readFile(path);
      if (insight) {
        insight.status = 'dismissed';
        insight.dismissedAt = Date.now();
        await this.crsService.writeFile(path, insight);
      }
    } catch (error) {
      console.error(`❌ [NightOwl] Failed to dismiss insight:`, error.message);
    }
  }

  /**
   * Clear all insights (pending, delivered, dismissed)
   */
  async clearAllInsights() {
    try {
      const files = await this.crsService.listFiles('system/nightowl');
      let deleted = 0;
      let failed = 0;

      console.log(`🦉 [NightOwl] Found ${files.length} files in system/nightowl`);

      for (const file of files) {
        if (file.name.startsWith('insight_') && file.name.endsWith('.json')) {
          const filePath = `system/nightowl/${file.name}`;
          console.log(`🦉 [NightOwl] Deleting: ${filePath}`);
          
          const success = await this.crsService.deleteFile(filePath);
          if (success) {
            deleted++;
          } else {
            failed++;
            console.error(`❌ [NightOwl] Failed to delete: ${filePath}`);
          }
        }
      }

      console.log(`🦉 [NightOwl] Cleared ${deleted} insights (${failed} failed)`);
      return { success: failed === 0, deleted, failed };
    } catch (error) {
      console.error(`❌ [NightOwl] Failed to clear insights:`, error.message);
      return { success: false, error: error.message, deleted: 0 };
    }
  }

  // ============================================================================
  // STAGED ACTION GENERATION
  // ============================================================================

  /**
   * Generate staged actions based on plan research
   * These are suggestions that the main service can execute when user approves
   */
  async generateStagedActionsForPlan(plan, researchContent, findings) {
    const actions = [];

    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: `Based on this research for "${plan.title}", what concrete actions could be staged for the user to approve?

RESEARCH SUMMARY:
${researchContent.substring(0, 2000)}

Possible action types:
- create_note: Save this research as a note
- update_loop: Update the plan with new details/steps
- create_loop: Create new sub-tasks or related loops
- add_calendar_event: Schedule something (if timing was discussed)

Return JSON array of suggested actions:
[
  {
    "type": "create_note",
    "description": "Save Alaska trip research as a note",
    "payload": { "title": "Alaska Trip Research", "content": "..." }
  },
  {
    "type": "update_loop",
    "description": "Add researched steps to the plan",
    "payload": { "loopId": "${plan.id}", "updates": { "description": "..." } }
  }
]

Only suggest actions that make sense. Return empty array [] if no actions are warranted.
Return ONLY the JSON array, nothing else.`
        }],
        system: 'Generate staged actions for user approval. Return only valid JSON array.'
      });

      const text = response.content[0]?.text || '[]';
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        for (const action of parsed) {
          actions.push({
            id: this.generateId('action'),
            type: action.type,
            description: action.description,
            payload: action.payload,
            requiresApproval: true,
            status: 'pending'
          });
        }
      }
    } catch (error) {
      console.warn('⚠️ [NightOwl] Failed to generate staged actions:', error.message);
    }

    // Always offer to save research as a note if we have content
    if (actions.length === 0 && researchContent) {
      actions.push({
        id: this.generateId('action'),
        type: 'create_note',
        description: `Save "${plan.title}" research as a note`,
        payload: {
          title: `Research: ${plan.title}`,
          content: researchContent,
          tags: ['night-owl', 'research'],
          sourceLoopId: plan.id
        },
        requiresApproval: true,
        status: 'pending'
      });
    }

    return actions;
  }

  /**
   * Generate staged actions for research insights (non-plan loops)
   */
  async generateStagedActionsForResearch(loop, researchContent, findings) {
    const actions = [];

    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 800,
        messages: [{
          role: 'user',
          content: `Based on this research for "${loop.title}", what concrete actions could be staged?

RESEARCH SUMMARY:
${researchContent.substring(0, 1500)}

LOOP TYPE: ${loop.loopType || 'general'}

Possible action types:
- create_note: Save this research as a note
- resolve_loop: Mark this loop as resolved (if research answers the question)
- create_loop: Create follow-up tasks
- add_fact: Record an important fact learned

Return JSON array of suggested actions (max 3):
[
  {
    "type": "create_note",
    "description": "Brief description",
    "payload": { ... }
  }
]

Only suggest what makes sense. Return [] if nothing is warranted.
Return ONLY the JSON array.`
        }],
        system: 'Generate staged actions for user approval. Return only valid JSON array.'
      });

      const text = response.content[0]?.text || '[]';
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        for (const action of parsed.slice(0, 3)) { // Max 3 actions
          actions.push({
            id: this.generateId('action'),
            type: action.type,
            description: action.description,
            payload: action.payload || {},
            requiresApproval: true,
            status: 'pending'
          });
        }
      }
    } catch (error) {
      console.warn('⚠️ [NightOwl] Failed to generate research staged actions:', error.message);
    }

    // Default: offer to save as note
    if (actions.length === 0 && researchContent) {
      actions.push({
        id: this.generateId('action'),
        type: 'create_note',
        description: `Save "${loop.title}" research as a note`,
        payload: {
          title: `Research: ${loop.title}`,
          content: researchContent,
          tags: ['night-owl', 'research'],
          sourceLoopId: loop.id
        },
        requiresApproval: true,
        status: 'pending'
      });
    }

    return actions;
  }

  /**
   * Generate staged actions for anticipatory prep (birthdays, trips, meetings)
   */
  generateStagedActionsForAnticipatory(insight, eventType, eventDetails = {}) {
    const actions = [];

    switch (eventType) {
      case 'birthday':
        actions.push({
          id: this.generateId('action'),
          type: 'create_loop',
          description: `Create reminder to buy gift for ${eventDetails.personName || 'them'}`,
          payload: {
            title: `Buy gift for ${eventDetails.personName || insight.loopTitle}`,
            loopType: 'task',
            priority: 2,
            description: insight.content,
            dueDate: eventDetails.date
          },
          requiresApproval: true,
          status: 'pending'
        });
        break;

      case 'trip':
        actions.push({
          id: this.generateId('action'),
          type: 'create_note',
          description: 'Save packing list and trip prep notes',
          payload: {
            title: `Trip Prep: ${eventDetails.destination || insight.loopTitle}`,
            content: insight.content,
            tags: ['trip', 'planning', 'night-owl']
          },
          requiresApproval: true,
          status: 'pending'
        });

        // Also suggest creating a trip prep task
        if (eventDetails.date) {
          const prepDate = new Date(eventDetails.date);
          prepDate.setDate(prepDate.getDate() - 3); // 3 days before
          actions.push({
            id: this.generateId('action'),
            type: 'create_loop',
            description: 'Create trip preparation reminder',
            payload: {
              title: `Pack for ${eventDetails.destination || 'trip'}`,
              loopType: 'task',
              priority: 2,
              dueDate: prepDate.toISOString()
            },
            requiresApproval: true,
            status: 'pending'
          });
        }
        break;

      case 'meeting':
        actions.push({
          id: this.generateId('action'),
          type: 'create_note',
          description: `Save meeting prep notes for ${eventDetails.personName || 'meeting'}`,
          payload: {
            title: `Meeting Prep: ${eventDetails.personName || insight.loopTitle}`,
            content: insight.content,
            tags: ['meeting', 'prep', 'night-owl']
          },
          requiresApproval: true,
          status: 'pending'
        });
        break;

      default:
        // Generic: just offer to save as note
        if (insight.content) {
          actions.push({
            id: this.generateId('action'),
            type: 'create_note',
            description: `Save insight as a note`,
            payload: {
              title: insight.loopTitle || 'Night Owl Insight',
              content: insight.content,
              tags: ['night-owl', 'insight']
            },
            requiresApproval: true,
            status: 'pending'
          });
        }
    }

    return actions;
  }

  /**
   * Generate staged actions for pattern insights
   */
  generateStagedActionsForPattern(insight, patternType) {
    const actions = [];

    // Patterns are informational - main action is to record as a fact
    actions.push({
      id: this.generateId('action'),
      type: 'add_fact',
      description: `Record this pattern as a personal insight`,
      payload: {
        category: 'pattern',
        content: `${insight.title || 'Pattern'}: ${insight.content?.substring(0, 200)}...`,
        source: 'night-owl',
        domain: patternType || 'behavioral'
      },
      requiresApproval: true,
      status: 'pending'
    });

    // If the pattern suggests action, create a loop
    if (insight.content?.toLowerCase().includes('consider') || 
        insight.content?.toLowerCase().includes('try') ||
        insight.content?.toLowerCase().includes('might help')) {
      actions.push({
        id: this.generateId('action'),
        type: 'create_loop',
        description: 'Create a follow-up to act on this pattern',
        payload: {
          title: `Follow up: ${insight.title || 'Pattern insight'}`,
          loopType: 'follow_up',
          priority: 3,
          description: `Based on Night Owl pattern analysis: ${insight.content?.substring(0, 300)}`
        },
        requiresApproval: true,
        status: 'pending'
      });
    }

    return actions;
  }

  // ============================================================================
  // UTILITIES
  // ============================================================================

  generateId(prefix) {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `${prefix}_${timestamp}_${random}`;
  }
}

export default NightOwlService;
