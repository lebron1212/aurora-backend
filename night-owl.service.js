/**
 * Night Owl Service
 * 
 * Autonomous background intelligence that works on open loops while you sleep.
 * 
 * CAPABILITIES:
 * 
 * 1. OPEN LOOP PROCESSING
 *    - Research: "Planning Alaska trip" → destinations, activities, logistics
 *    - Decisions: "Should I take the job?" → weighs against values/patterns
 *    - Preparation: "Talk to Sarah about X" → approaches, anticipation
 * 
 * 2. ANTICIPATORY PREP
 *    - Tomorrow's calendar → pulls context on people, open loops
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
 * @typedef {Object} OpenLoop
 * @property {string} id
 * @property {string} title
 * @property {string} loopType - task|decision|followup|commitment|question|plan
 * @property {number} priority - 1-3
 * @property {string} [description]
 * @property {string[]} [relatedEntityIds]
 * @property {string} status - open|resolved
 */

/**
 * @typedef {Object} NightOwlInsight
 * @property {string} id
 * @property {string} loopId
 * @property {string} loopTitle
 * @property {string} insightType - research|perspective|suggestion|preparation
 * @property {string} content - The actual insight/research
 * @property {string} conversationHook - Natural way to bring it up
 * @property {string[]} sources - URLs if web research was used
 * @property {number} createdAt
 * @property {string} status - pending|delivered|dismissed
 */

/**
 * @typedef {Object} UserContext
 * @property {Object} selfIdentity
 * @property {Array} relevantFacts
 * @property {Array} relevantEntities
 * @property {Array} patterns
 */

// ============================================================================
// NIGHT OWL SERVICE
// ============================================================================

class NightOwlService {
  constructor(crsService, config = {}) {
    this.crsService = crsService;
    this.anthropicApiKey = config.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
    this.maxLoopsPerRun = config.maxLoopsPerRun || 3;
    this.minPriority = config.minPriority || 2; // Process priority 1 and 2
    
    if (!this.anthropicApiKey) {
      console.warn('⚠️ [NightOwl] ANTHROPIC_API_KEY not set. Night Owl will be disabled.');
    }
    
    this.anthropic = this.anthropicApiKey ? new Anthropic({
      apiKey: this.anthropicApiKey
    }) : null;
  }

  // ============================================================================
  // MAIN PROCESSING
  // ============================================================================

  /**
   * Run Night Owl processing - full suite
   * Call this after CRS nightly processing completes
   */
  async process() {
    if (!this.anthropic) {
      console.log('🦉 [NightOwl] Skipping - no API key configured');
      return { insights: [], processed: 0 };
    }

    console.log('🦉 [NightOwl] Starting autonomous processing...');
    const startTime = Date.now();
    const allInsights = [];

    try {
      // Load user context once for all processors
      const userContext = await this.getUserContext();
      const healthData = await this.getHealthData(); // HealthKit sync'd data

      // ============================================================
      // 1. OPEN LOOP PROCESSING (existing)
      // ============================================================
      const loopInsights = await this.processOpenLoops(userContext);
      allInsights.push(...loopInsights);

      // ============================================================
      // 2. ANTICIPATORY PREP (calendar, birthdays, trips)
      // ============================================================
      const prepInsights = await this.processAnticipatoryPrep(userContext);
      allInsights.push(...prepInsights);

      // ============================================================
      // 3. PATTERN SURFACING
      // ============================================================
      const patternInsights = await this.surfacePatterns(userContext, healthData);
      allInsights.push(...patternInsights);

      // ============================================================
      // 4. SMART REMINDERS
      // ============================================================
      const reminderInsights = await this.generateSmartReminders(userContext);
      allInsights.push(...reminderInsights);

      // ============================================================
      // 5. ACCOUNTABILITY CHECK
      // ============================================================
      const accountabilityInsights = await this.checkAccountability(userContext);
      allInsights.push(...accountabilityInsights);

      // ============================================================
      // 6. CONNECTION FINDING
      // ============================================================
      const connectionInsights = await this.findConnections(userContext);
      allInsights.push(...connectionInsights);

      // ============================================================
      // 7. HEALTH CORRELATIONS
      // ============================================================
      const healthInsights = await this.analyzeHealthCorrelations(userContext, healthData);
      allInsights.push(...healthInsights);

      // ============================================================
      // 8. LEARNING SYNTHESIS (if learning content exists)
      // ============================================================
      const learningInsights = await this.synthesizeLearning(userContext);
      allInsights.push(...learningInsights);

      // ============================================================
      // 9. PLAN ITERATION (research, refine, unblock)
      // ============================================================
      const planInsights = await this.iterateOnPlans(userContext);
      allInsights.push(...planInsights);

      // Save all insights
      for (const insight of allInsights) {
        await this.saveInsight(insight);
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`🦉 [NightOwl] Completed in ${elapsed}s. Generated ${allInsights.length} insights.`);

      return { 
        insights: allInsights, 
        processed: allInsights.length,
        breakdown: {
          loops: loopInsights.length,
          prep: prepInsights.length,
          patterns: patternInsights.length,
          reminders: reminderInsights.length,
          accountability: accountabilityInsights.length,
          connections: connectionInsights.length,
          health: healthInsights.length,
          learning: learningInsights.length,
          plans: planInsights.length
        }
      };

    } catch (error) {
      console.error('❌ [NightOwl] Processing failed:', error);
      return { insights: allInsights, processed: allInsights.length, error: error.message };
    }
  }

  /**
   * Process open loops (original functionality)
   */
  async processOpenLoops(userContext) {
    const loops = await this.getWorkableLoops();
    console.log(`🦉 [NightOwl] Processing ${loops.length} open loops...`);

    const insights = [];
    for (const loop of loops) {
      try {
        const insight = await this.processLoop(loop, userContext);
        if (insight) insights.push(insight);
      } catch (error) {
        console.error(`❌ [NightOwl] Failed to process loop "${loop.title}":`, error.message);
      }
    }
    return insights;
  }

  // ============================================================================
  // LOOP SELECTION
  // ============================================================================

  /**
   * Get loops that are worth autonomous work
   */
  async getWorkableLoops() {
    const allLoops = await this.crsService.loadExistingSystemFiles('open_loops');
    
    // Filter to open, high-priority, workable loops
    const workable = allLoops
      .filter(loop => {
        if (loop.status !== 'open') return false;
        if (loop.priority > this.minPriority) return false;
        
        // Focus on types that benefit from research/thinking
        const workableTypes = ['decision', 'plan', 'question', 'task'];
        if (!workableTypes.includes(loop.loopType)) return false;
        
        return true;
      })
      .sort((a, b) => {
        // Sort by priority (1 first), then by creation date
        if (a.priority !== b.priority) return a.priority - b.priority;
        return (b.createdAt || 0) - (a.createdAt || 0);
      })
      .slice(0, this.maxLoopsPerRun);

    return workable;
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
  // LOOP PROCESSING
  // ============================================================================

  /**
   * Process a single loop and generate insight
   */
  async processLoop(loop, userContext) {
    const strategy = this.determineStrategy(loop);
    
    switch (strategy) {
      case 'research':
        return await this.doResearch(loop, userContext);
      case 'decision':
        return await this.analyzeDecision(loop, userContext);
      case 'preparation':
        return await this.prepareApproach(loop, userContext);
      default:
        return await this.thinkThrough(loop, userContext);
    }
  }

  /**
   * Determine what kind of work this loop needs
   */
  determineStrategy(loop) {
    const titleLower = loop.title.toLowerCase();
    const descLower = (loop.description || '').toLowerCase();
    const combined = titleLower + ' ' + descLower;

    // Research needed
    if (combined.includes('trip') || combined.includes('travel') || 
        combined.includes('visit') || combined.includes('vacation') ||
        combined.includes('research') || combined.includes('find out') ||
        combined.includes('look into') || combined.includes('options for')) {
      return 'research';
    }

    // Decision analysis
    if (loop.loopType === 'decision' || combined.includes('should i') ||
        combined.includes('decide') || combined.includes('choice') ||
        combined.includes('whether to')) {
      return 'decision';
    }

    // Conversation/approach preparation
    if (combined.includes('talk to') || combined.includes('conversation with') ||
        combined.includes('approach') || combined.includes('discuss with')) {
      return 'preparation';
    }

    return 'general';
  }

  // ============================================================================
  // RESEARCH (with web search)
  // ============================================================================

  async doResearch(loop, userContext) {
    console.log(`🔍 [NightOwl] Researching: "${loop.title}"`);

    // Build context about user preferences
    const userPrefs = this.buildUserPreferencesContext(userContext);
    
    // Get related entities for more context
    const relatedContext = await this.getRelatedEntitiesContext(loop.relatedEntityIds || [], userContext);

    const systemPrompt = `You are a thoughtful personal assistant doing background research to help with planning and decision-making. 

Your research should be:
- Practical and actionable
- Personalized to the user's preferences and situation
- Well-sourced from current information
- Organized in a way that's easy to digest

When presenting research, structure it as:
1. Key findings relevant to their situation
2. Specific recommendations based on their preferences
3. Things to consider or watch out for
4. Next steps they could take

Be conversational but informative. This will be delivered naturally in a future conversation.`;

    const userPrompt = `I need to research this for the user:

OPEN LOOP: ${loop.title}
${loop.description ? `Details: ${loop.description}` : ''}

USER CONTEXT:
${userPrefs}
${relatedContext}

Please research this thoroughly and provide practical, personalized findings. Use web search to find current, relevant information.

Focus on what would actually help them make progress on this.`;

    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        tools: [{ type: 'web_search_20250305' }],
        messages: [
          { role: 'user', content: userPrompt }
        ],
        system: systemPrompt
      });

      // Extract text and sources from response
      const { text, sources } = this.extractResponseContent(response);

      return {
        id: this.generateId('insight'),
        loopId: loop.id,
        loopTitle: loop.title,
        insightType: 'research',
        content: text,
        conversationHook: this.generateConversationHook(loop, 'research'),
        sources,
        createdAt: Date.now(),
        status: 'pending'
      };

    } catch (error) {
      console.error(`❌ [NightOwl] Research failed:`, error.message);
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
        tools: [{ type: 'web_search_20250305' }], // In case we need to research aspects
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

    // Check for upcoming trips (from open loops or calendar)
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

Recent open loops involving them:
${await this.getLoopsInvolvingPerson(personNames[0])}

Please prepare a brief context summary: who this person is, recent context, any open items with them, and anything useful to remember going in.`
        }],
        system: 'You are preparing someone for an upcoming meeting/event. Be concise and practical. Focus on what would actually be useful to know going in.'
      });

      const { text } = this.extractResponseContent(response);

      return {
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
        tools: [{ type: 'web_search_20250305' }],
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

      return {
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
    } catch (error) {
      console.error(`❌ [NightOwl] Birthday prep failed:`, error.message);
      return null;
    }
  }

  async prepareForTrips(userContext, calendarEvents) {
    // Look for trip-related open loops
    const loops = await this.crsService.loadExistingSystemFiles('open_loops');
    const tripLoops = loops.filter(l => 
      l.status === 'open' &&
      (l.title.toLowerCase().includes('trip') ||
       l.title.toLowerCase().includes('travel') ||
       l.title.toLowerCase().includes('vacation') ||
       l.title.toLowerCase().includes('visit'))
    );

    if (tripLoops.length === 0) return null;

    const trip = tripLoops[0];
    
    // Check if trip is within next 2 weeks (would need actual date parsing)
    console.log(`✈️ [NightOwl] Preparing for trip: "${trip.title}"`);

    try {
      const userPrefs = this.buildUserPreferencesContext(userContext);

      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1200,
        tools: [{ type: 'web_search_20250305' }],
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

      return {
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
    } catch (error) {
      console.error(`❌ [NightOwl] Trip prep failed:`, error.message);
      return null;
    }
  }

  // ============================================================================
  // 3. PATTERN SURFACING
  // ============================================================================

  async surfacePatterns(userContext, healthData) {
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
      
      try {
        const response = await this.anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 600,
          messages: [{
            role: 'user',
            content: `I've noticed this pattern in the user's behavior/life:

PATTERN: ${pattern.claim}
DOMAIN: ${pattern.domain}
EVIDENCE: ${JSON.stringify(pattern.evidence || [])}

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
    const loops = await this.crsService.loadExistingSystemFiles('open_loops');

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
      // Check if there's already an open loop for follow-up
      const hasLoop = loops.some(l => 
        l.status === 'open' && 
        l.title.toLowerCase().includes('thank') ||
        l.title.toLowerCase().includes('follow up')
      );

      if (hasLoop) continue;

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

    const loops = await this.crsService.loadExistingSystemFiles('open_loops');
    const facts = userContext.relevantFacts || [];

    // Find commitments with deadlines that are approaching or passed
    const commitments = loops.filter(l => 
      l.status === 'open' &&
      (l.loopType === 'commitment' || l.loopType === 'decision') &&
      l.dueDate
    );

    const now = Date.now();
    const overdue = commitments.filter(c => new Date(c.dueDate).getTime() < now);
    const upcoming = commitments.filter(c => {
      const due = new Date(c.dueDate).getTime();
      return due >= now && due < now + 3 * 24 * 60 * 60 * 1000; // Within 3 days
    });

    // Find stalled projects (open loops with no recent activity)
    const stalledLoops = loops.filter(l => {
      if (l.status !== 'open') return false;
      if (l.loopType !== 'task' && l.loopType !== 'plan') return false;
      const lastUpdate = l.updatedAt || l.createdAt;
      const daysSinceUpdate = (now - lastUpdate) / (24 * 60 * 60 * 1000);
      return daysSinceUpdate > 7; // No activity in 7+ days
    });

    if (overdue.length > 0 || upcoming.length > 0 || stalledLoops.length > 0) {
      try {
        const response = await this.anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 600,
          messages: [{
            role: 'user',
            content: `Here's the user's accountability status:

OVERDUE (need attention):
${overdue.map(c => `- "${c.title}" (due: ${c.dueDate})`).join('\n') || 'None'}

UPCOMING (within 3 days):
${upcoming.map(c => `- "${c.title}" (due: ${c.dueDate})`).join('\n') || 'None'}

STALLED (no progress in 7+ days):
${stalledLoops.map(l => `- "${l.title}" (${Math.floor((now - (l.updatedAt || l.createdAt)) / (24*60*60*1000))} days)`).join('\n') || 'None'}

Please provide a gentle, supportive accountability check. Not nagging - just honest and helpful. If everything looks good, say so briefly.`
          }],
          system: 'You are providing a gentle accountability check. Be supportive, not judgmental. Help them see reality clearly while being kind.'
        });

        const { text } = this.extractResponseContent(response);

        insights.push({
          id: this.generateId('insight'),
          loopId: null,
          loopTitle: 'Accountability check',
          insightType: 'accountability',
          content: text,
          conversationHook: `Quick check-in on some things you've got going...`,
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

  async analyzeHealthCorrelations(userContext, healthData) {
    console.log('❤️ [NightOwl] Analyzing health correlations...');
    const insights = [];

    // Skip if no health data
    if (!healthData.available) {
      console.log('⏭️ [NightOwl] Skipping health analysis - no data synced from HealthKit');
      return insights;
    }

    const facts = userContext.relevantFacts || [];
    const moodFacts = facts.filter(f => 
      f.category === 'emotional' || 
      f.content.toLowerCase().includes('mood') ||
      f.content.toLowerCase().includes('feel')
    );

    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 800,
        messages: [{
          role: 'user',
          content: `Here's the user's recent health data and emotional patterns:

SLEEP (last 7 days):
${JSON.stringify(healthData.sleep.slice(-7), null, 2)}

STEPS (last 7 days):
${JSON.stringify(healthData.steps.slice(-7), null, 2)}

WORKOUTS (last 7 days):
${JSON.stringify(healthData.workouts.slice(-7), null, 2)}

MOOD/EMOTIONAL FACTS:
${moodFacts.slice(-10).map(f => `- [${f.createdAt ? new Date(f.createdAt).toLocaleDateString() : 'unknown'}] ${f.content}`).join('\n')}

Look for correlations:
- Does sleep quality seem to affect mood?
- Do exercise days correlate with better emotional states?
- Any patterns worth noting?

Only share if you find meaningful correlations.`
        }],
        system: 'You are analyzing health data to find correlations that could help someone understand their wellbeing better. Be insightful but not preachy.'
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
    const loops = await this.crsService.loadExistingSystemFiles('open_loops');
    const goals = loops.filter(l => 
      l.loopType === 'plan' || 
      l.title.toLowerCase().includes('goal') ||
      l.title.toLowerCase().includes('learn')
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
      // Get all plans from open loops
      const loops = await this.crsService.loadExistingSystemFiles('open_loops');
      const plans = loops.filter(l => 
        l.status === 'open' && 
        l.loopType === 'plan' &&
        l.priority <= 2 // Only high-priority plans
      );

      if (plans.length === 0) {
        console.log('⏭️ [NightOwl] No high-priority plans to iterate on');
        return insights;
      }

      // Work on up to 2 plans per run
      for (const plan of plans.slice(0, 2)) {
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

  async determinePlanIterationType(plan, userContext) {
    const titleLower = plan.title.toLowerCase();
    const descLower = (plan.description || '').toLowerCase();
    const combined = titleLower + ' ' + descLower;

    // Check if plan has been stalled
    const daysSinceUpdate = (Date.now() - (plan.updatedAt || plan.createdAt)) / (24 * 60 * 60 * 1000);
    
    // If stalled for 5+ days, it might be blocked
    if (daysSinceUpdate >= 5) {
      return 'unblock';
    }

    // Check if plan needs more research
    if (combined.includes('research') || combined.includes('figure out') || 
        combined.includes('find') || combined.includes('how to') ||
        combined.includes('options') || combined.includes('possibilities')) {
      return 'research';
    }

    // Check if plan is too vague and needs breakdown
    if (combined.length < 50 || 
        combined.includes('eventually') || combined.includes('someday') ||
        combined.includes('figure out how to') || combined.includes('work on')) {
      return 'breakdown';
    }

    // Default to refinement
    return 'refine';
  }

  async researchPlan(plan, userContext) {
    console.log(`🔍 [NightOwl] Researching plan: "${plan.title}"`);
    
    const systemPrompt = `You are a research assistant helping someone develop their plan by gathering information and insights.

Your research should:
- Provide practical, actionable information
- Consider the person's context and constraints
- Offer multiple approaches or options where relevant
- Be specific and detailed enough to be useful
- Include current, relevant information from web search

Structure your response as:
1. Key research findings
2. Practical approaches they could take
3. Important considerations or potential challenges
4. Specific next steps they could take

Be thorough but focused on actionable insights.`;

    const userPrompt = `I need deep research on this plan:

PLAN: ${plan.title}
${plan.description ? `Details: ${plan.description}` : ''}

USER CONTEXT:
${this.buildUserPreferencesContext(userContext)}

Please research this thoroughly and provide:
- Current best practices and approaches
- Multiple options they could pursue
- Key considerations for their situation
- Specific, actionable next steps

Use web search to find current, relevant information.`;

    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        tools: [{ type: 'web_search_20250305' }],
        messages: [{ role: 'user', content: userPrompt }],
        system: systemPrompt
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

    } catch (error) {
      console.error(`❌ [NightOwl] Plan research failed:`, error.message);
      return null;
    }
  }

  async refinePlan(plan, userContext) {
    console.log(`🎨 [NightOwl] Refining plan: "${plan.title}"`);
    
    const systemPrompt = `You are a strategic advisor helping someone refine and improve their plan.

Your refinement should:
- Make the plan more specific and actionable
- Identify potential improvements or optimizations
- Suggest better approaches based on current best practices
- Help them anticipate and prepare for challenges
- Connect the plan to their broader goals and context

Be strategic and thoughtful, focusing on making the plan more effective.`;

    const userPrompt = `Help refine this plan:

PLAN: ${plan.title}
${plan.description ? `Current approach: ${plan.description}` : ''}

USER CONTEXT:
${this.buildUserPreferencesContext(userContext)}

THEIR PATTERNS:
${this.buildPatternsContext(userContext)}

Please provide:
1. Specific improvements to make the plan more effective
2. Better approaches they might not have considered
3. Ways to anticipate and handle potential challenges
4. How to connect this plan to their broader goals
5. Concrete next steps with clear milestones

Make the plan more strategic and actionable.`;

    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        tools: [{ type: 'web_search_20250305' }],
        messages: [{ role: 'user', content: userPrompt }],
        system: systemPrompt
      });

      const { text, sources } = this.extractResponseContent(response);

      return {
        id: this.generateId('plan_insight'),
        loopId: plan.id,
        loopTitle: plan.title,
        insightType: 'plan_refinement',
        content: text,
        conversationHook: await this.generatePlanConversationHook(plan, 'refine', text),
        sources,
        createdAt: Date.now(),
        status: 'pending'
      };

    } catch (error) {
      console.error(`❌ [NightOwl] Plan refinement failed:`, error.message);
      return null;
    }
  }

  async unblockPlan(plan, userContext) {
    console.log(`🔓 [NightOwl] Unblocking plan: "${plan.title}"`);
    
    const daysSinceUpdate = Math.floor((Date.now() - (plan.updatedAt || plan.createdAt)) / (24 * 60 * 60 * 1000));
    
    const systemPrompt = `You are a strategic advisor helping someone identify and overcome what's blocking their progress on a plan.

Your analysis should:
- Identify likely reasons for the stall (psychological, practical, resource, clarity)
- Suggest specific ways to overcome these blocks
- Provide alternative approaches that might work better
- Help them rebuild momentum
- Be encouraging while being realistic about challenges

Focus on actionable solutions to get them unstuck.`;

    const userPrompt = `This plan has been stalled for ${daysSinceUpdate} days:

PLAN: ${plan.title}
${plan.description ? `Details: ${plan.description}` : ''}

USER CONTEXT:
${this.buildUserPreferencesContext(userContext)}

THEIR PATTERNS:
${this.buildPatternsContext(userContext)}

Please analyze:
1. What's likely blocking progress (be specific)
2. Strategies to overcome these specific blocks
3. Alternative approaches that might work better
4. Small, concrete steps to rebuild momentum
5. How to prevent future stalls on this plan

Help them get unstuck and move forward.`;

    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        messages: [{ role: 'user', content: userPrompt }],
        system: systemPrompt
      });

      const { text } = this.extractResponseContent(response);

      return {
        id: this.generateId('plan_insight'),
        loopId: plan.id,
        loopTitle: plan.title,
        insightType: 'plan_unblock',
        content: text,
        conversationHook: await this.generatePlanConversationHook(plan, 'blocked', text),
        sources: [],
        createdAt: Date.now(),
        status: 'pending'
      };

    } catch (error) {
      console.error(`❌ [NightOwl] Plan unblocking failed:`, error.message);
      return null;
    }
  }

  async breakdownPlan(plan, userContext) {
    console.log(`📋 [NightOwl] Breaking down plan: "${plan.title}"`);
    
    const systemPrompt = `You are a strategic advisor helping someone break down a vague plan into specific, actionable steps.

Your breakdown should:
- Turn the broad plan into concrete, manageable tasks
- Organize steps in a logical sequence
- Identify dependencies and prerequisites
- Make each step specific enough that they'll know exactly what to do
- Include rough time estimates where helpful

Focus on making the abstract concrete and actionable.`;

    const userPrompt = `This plan needs to be broken down into actionable steps:

PLAN: ${plan.title}
${plan.description ? `Current description: ${plan.description}` : ''}

USER CONTEXT:
${this.buildUserPreferencesContext(userContext)}

Please provide:
1. Specific, actionable steps to achieve this plan
2. Logical order and dependencies between steps
3. Prerequisites or preparation needed
4. Rough time estimates for each major phase
5. Early wins or quick victories they could pursue
6. How to track progress along the way

Transform this from a vague plan into a clear roadmap.`;

    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        tools: [{ type: 'web_search_20250305' }],
        messages: [{ role: 'user', content: userPrompt }],
        system: systemPrompt
      });

      const { text, sources } = this.extractResponseContent(response);

      return {
        id: this.generateId('plan_insight'),
        loopId: plan.id,
        loopTitle: plan.title,
        insightType: 'plan_breakdown',
        content: text,
        conversationHook: await this.generatePlanConversationHook(plan, 'breakdown', text),
        sources,
        createdAt: Date.now(),
        status: 'pending'
      };

    } catch (error) {
      console.error(`❌ [NightOwl] Plan breakdown failed:`, error.message);
      return null;
    }
  }

  async generalPlanAnalysis(plan, userContext) {
    console.log(`🤔 [NightOwl] General analysis of plan: "${plan.title}"`);
    
    const systemPrompt = `You are a thoughtful advisor providing strategic insight on someone's plan.

Your analysis should:
- Offer a fresh perspective or angle they might not have considered
- Identify opportunities and potential challenges
- Suggest improvements or optimizations
- Connect the plan to their broader context and goals
- Be practical and actionable

Provide value through insight and strategic thinking.`;

    const userPrompt = `Provide strategic insight on this plan:

PLAN: ${plan.title}
${plan.description ? `Details: ${plan.description}` : ''}

USER CONTEXT:
${this.buildUserPreferencesContext(userContext)}

Please offer:
1. Strategic perspective on this plan
2. Opportunities they might not have considered
3. Potential challenges to anticipate
4. Ways to improve or optimize their approach
5. How this connects to their broader goals
6. Specific next actions they should consider

Give them valuable strategic insight.`;

    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{ role: 'user', content: userPrompt }],
        system: systemPrompt
      });

      const { text } = this.extractResponseContent(response);

      return {
        id: this.generateId('plan_insight'),
        loopId: plan.id,
        loopTitle: plan.title,
        insightType: 'plan_analysis',
        content: text,
        conversationHook: await this.generatePlanConversationHook(plan, 'analysis', text),
        sources: [],
        createdAt: Date.now(),
        status: 'pending'
      };

    } catch (error) {
      console.error(`❌ [NightOwl] General plan analysis failed:`, error.message);
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

  async getLoopsInvolvingPerson(name) {
    const loops = await this.crsService.loadExistingSystemFiles('open_loops');
    const involving = loops.filter(l => 
      l.status === 'open' &&
      l.title.toLowerCase().includes(name.toLowerCase())
    );
    
    if (involving.length === 0) return 'None';
    return involving.map(l => `- ${l.title}`).join('\n');
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

      return insights.sort((a, b) => a.createdAt - b.createdAt);
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
