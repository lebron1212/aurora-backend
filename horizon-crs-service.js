/**
 * Horizon CRS Service
 * Cognitive Representation System for Aurora
 * 
 * Handles:
 * - Processing journals/conversations into entities, facts, loops, patterns, narratives
 * - Exporting CRS outputs to /system file structure in Supabase
 * - Generating update manifests for RTCS sync
 * - Nightly processing cron jobs
 * 
 * Uses OpenAI GPT-4 for intelligent extraction
 */

import { createClient } from '@supabase/supabase-js';
import cron from 'node-cron';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const openaiApiKey = process.env.OPENAI_API_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error('Missing Supabase configuration. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables.');
}

if (!openaiApiKey) {
  console.warn('⚠️ [CRS] OPENAI_API_KEY not set. CRS processing will be limited.');
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

// ============================================================================
// OPENAI HELPER
// ============================================================================

async function callOpenAI(systemPrompt, userPrompt, temperature = 0.3) {
  if (!openaiApiKey) {
    throw new Error('OpenAI API key not configured');
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${openaiApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature,
      response_format: { type: 'json_object' }
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI API error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  const content = data.choices[0]?.message?.content;
  
  if (!content) {
    throw new Error('No content in OpenAI response');
  }

  return JSON.parse(content);
}

// ============================================================================
// ID GENERATION
// ============================================================================

function generateId(prefix = '') {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return prefix ? `${prefix}_${timestamp}_${random}` : `${timestamp}_${random}`;
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .substring(0, 30);
}

// ============================================================================
// CRS SERVICE
// ============================================================================

class HorizonCRSService {
  constructor() {
    this.isProcessing = false;
    this.lastProcessingTime = null;
  }

  /**
   * Initialize the CRS service and start cron jobs
   */
  async initialize() {
    console.log('🧠 [CRS] Initializing Horizon CRS Service...');
    
    // Ensure system directories exist in storage
    await this.ensureSystemDirectories();
    
    // Start nightly cron job at 2 AM
    cron.schedule('0 2 * * *', async () => {
      console.log('🌙 [CRS] Starting nightly processing...');
      await this.runNightlyProcessing();
    });

    // Optional: Add a manual trigger endpoint for testing
    this.setupManualTrigger();

    console.log('✅ [CRS] Service initialized. Nightly processing scheduled for 2 AM.');
  }

  /**
   * Ensure all system directories exist in Supabase storage
   */
  async ensureSystemDirectories() {
    const systemDirs = [
      'system/entities/people',
      'system/entities/projects', 
      'system/entities/places',
      'system/entities/concepts',
      'system/facts',
      'system/open_loops',
      'system/open_loops/resolved',
      'system/patterns',
      'system/narratives',
      'system/updates'
    ];

    for (const dir of systemDirs) {
      try {
        // Create a placeholder file to ensure directory exists
        await this.writeFile(`${dir}/.keep`, { created: Date.now() });
      } catch (error) {
        console.error(`❌ [CRS] Failed to create directory ${dir}:`, error.message);
      }
    }
  }

  /**
   * Run complete nightly processing pipeline
   */
  async runNightlyProcessing() {
    if (this.isProcessing) {
      console.log('⚠️ [CRS] Nightly processing already in progress, skipping...');
      return;
    }

    this.isProcessing = true;
    const startTime = Date.now();

    try {
      console.log('📊 [CRS] Starting cognitive processing...');

      // 1. Load raw data (journals, conversations, existing system files)
      const rawData = await this.loadRawData();
      
      // 2. Process into CRS outputs
      const crsOutputs = await this.processCognitiveData(rawData);
      
      // 3. Export to /system file structure
      await this.exportCRSOutputsToSystemFS(crsOutputs);
      
      // 4. Generate update manifest
      await this.generateUpdateManifest(crsOutputs);
      
      const processingTime = Date.now() - startTime;
      this.lastProcessingTime = Date.now();
      
      console.log(`✅ [CRS] Nightly processing completed in ${processingTime}ms`);
      console.log(`📈 [CRS] Processed: ${crsOutputs.entities.length} entities, ${crsOutputs.facts.length} facts, ${crsOutputs.loops.length} loops, ${crsOutputs.patterns.length} patterns, ${crsOutputs.narratives.length} narratives`);

    } catch (error) {
      console.error('❌ [CRS] Nightly processing failed:', error);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Load all raw input data for processing
   */
  async loadRawData() {
    console.log('📥 [CRS] Loading raw data...');
    
    // Load existing system files for incremental processing
    const existingEntities = await this.loadExistingSystemFiles('entities');
    const existingFacts = await this.loadExistingSystemFiles('facts');
    const existingLoops = await this.loadExistingSystemFiles('open_loops');
    const existingPatterns = await this.loadExistingSystemFiles('patterns');
    const existingNarratives = await this.loadExistingSystemFiles('narratives');

    // Load raw input files
    const journals = await this.readFile('journals.json') || {};
    const conversations = await this.readFile('conversations.json') || {};

    // Flatten journals by date into array
    const allJournals = [];
    for (const [date, entries] of Object.entries(journals)) {
      for (const entry of entries) {
        allJournals.push({ ...entry, date });
      }
    }

    // Flatten conversations by date into array
    const allConversations = [];
    for (const [date, convos] of Object.entries(conversations)) {
      for (const conv of convos) {
        allConversations.push({ ...conv, date });
      }
    }

    console.log(`📥 [CRS] Loaded ${allJournals.length} journals, ${allConversations.length} conversations`);
    console.log(`📥 [CRS] Existing: ${existingEntities.length} entities, ${existingFacts.length} facts`);

    return {
      journals: allJournals,
      conversations: allConversations,
      existing: {
        entities: existingEntities,
        facts: existingFacts,
        loops: existingLoops,
        patterns: existingPatterns,
        narratives: existingNarratives
      }
    };
  }

  /**
   * Process raw data into cognitive representations
   */
  async processCognitiveData(rawData) {
    console.log('🧠 [CRS] Processing cognitive data with OpenAI...');

    if (!openaiApiKey) {
      console.warn('⚠️ [CRS] No OpenAI key - returning existing data only');
      return {
        entities: rawData.existing.entities || [],
        facts: rawData.existing.facts || [],
        loops: rawData.existing.loops || [],
        patterns: rawData.existing.patterns || [],
        narratives: rawData.existing.narratives || []
      };
    }

    // Combine journal content for processing
    const recentJournals = rawData.journals.slice(-30); // Last 30 entries
    const journalText = recentJournals
      .map(j => `[${j.date}] ${j.content || j.text || ''}`)
      .join('\n\n');

    if (!journalText.trim()) {
      console.log('⚠️ [CRS] No journal content to process');
      return {
        entities: rawData.existing.entities || [],
        facts: rawData.existing.facts || [],
        loops: rawData.existing.loops || [],
        patterns: rawData.existing.patterns || [],
        narratives: rawData.existing.narratives || []
      };
    }

    // Process each type
    const entities = await this.processEntities(journalText, rawData.existing.entities);
    const facts = await this.processFacts(journalText, entities, rawData.existing.facts);
    const loops = await this.processOpenLoops(journalText, entities, rawData.existing.loops);
    const patterns = await this.processPatterns(journalText, facts, rawData.existing.patterns);
    const narratives = await this.processNarratives(journalText, entities, facts, rawData.existing.narratives);

    return { entities, facts, loops, patterns, narratives };
  }

  // ============================================================================
  // ENTITY EXTRACTION
  // ============================================================================

  async processEntities(journalText, existingEntities) {
    console.log('👥 [CRS] Extracting entities...');

    const existingNames = existingEntities.map(e => e.name.toLowerCase());
    
    const systemPrompt = `You are a cognitive memory system extracting ENTITIES from personal journals.

ENTITY TYPES:
- people: Named individuals (friends, family, colleagues, doctors, etc.)
- projects: Named projects, goals, or ongoing efforts
- places: Specific locations (cities, offices, restaurants, etc.)
- concepts: Important abstract concepts, values, or themes

RULES:
1. Extract SPECIFIC named entities, not generic terms
2. Include aliases (nicknames, abbreviations)
3. Determine salience (0.0-1.0) based on importance/frequency
4. Category must be one of: people, projects, places, concepts
5. Skip generic terms like "work", "home" unless they're clearly named entities

Return JSON: { "entities": [...] }`;

    const userPrompt = `Extract entities from these journal entries. Return NEW entities not in this existing list: ${existingNames.join(', ')}

JOURNALS:
${journalText}

For each entity return:
{
  "name": "Entity Name",
  "category": "people|projects|places|concepts",
  "aliases": ["nickname", "abbreviation"],
  "salience": 0.0-1.0,
  "description": "Brief description based on journal context"
}`;

    try {
      const result = await callOpenAI(systemPrompt, userPrompt);
      const newEntities = (result.entities || []).map(e => ({
        id: `entity_${slugify(e.name)}_${generateId()}`,
        name: e.name,
        category: e.category || 'concepts',
        aliases: e.aliases || [],
        salience: e.salience || 0.5,
        description: e.description || '',
        lastMentionedAt: Date.now(),
        mentionCount: 1,
        factIds: [],
        relationshipGraph: [],
        decayRate: 0.01,
        lastDecayAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now()
      }));

      // Ensure self entity exists
      const allEntities = [...existingEntities];
      if (!allEntities.find(e => e.id === 'self' || e.name.toLowerCase() === 'self')) {
        allEntities.push({
          id: 'self',
          name: 'Self',
          category: 'people',
          aliases: ['I', 'me', 'myself'],
          salience: 1.0,
          description: 'The user themselves',
          lastMentionedAt: Date.now(),
          mentionCount: 1,
          factIds: [],
          relationshipGraph: [],
          decayRate: 0.01,
          lastDecayAt: Date.now(),
          createdAt: Date.now(),
          updatedAt: Date.now()
        });
      }

      // Merge new entities (avoid duplicates)
      for (const newEntity of newEntities) {
        const exists = allEntities.find(e => 
          e.name.toLowerCase() === newEntity.name.toLowerCase()
        );
        if (!exists) {
          allEntities.push(newEntity);
        } else {
          // Update existing entity
          exists.lastMentionedAt = Date.now();
          exists.mentionCount = (exists.mentionCount || 0) + 1;
          exists.updatedAt = Date.now();
        }
      }

      console.log(`👥 [CRS] Extracted ${newEntities.length} new entities, total: ${allEntities.length}`);
      return allEntities;

    } catch (error) {
      console.error('❌ [CRS] Entity extraction failed:', error.message);
      return existingEntities;
    }
  }

  // ============================================================================
  // FACT EXTRACTION
  // ============================================================================

  async processFacts(journalText, entities, existingFacts) {
    console.log('📝 [CRS] Extracting facts...');

    const entityList = entities.map(e => `${e.name} (${e.category})`).join(', ');
    
    const systemPrompt = `You are a cognitive memory system extracting FACTS from personal journals.

A FACT is an atomic, timestamped truth about the user or their world.

FACT CATEGORIES:
- self: Facts about the user (beliefs, preferences, identity)
- relationship: Facts about relationships with others
- habit: Behavioral patterns or routines
- health: Physical or mental health observations
- emotional: Emotional states or reactions
- progress: Progress on goals or projects
- insight: Realizations or learnings
- event: Specific events that happened

RULES:
1. Facts must be SPECIFIC and ATOMIC (one truth per fact)
2. Link facts to relevant entities by name
3. Assign confidence (0.0-1.0) based on how certain the statement is
4. temporality: "current" (still true), "past" (was true), "permanent" (always true)

Return JSON: { "facts": [...] }`;

    const userPrompt = `Extract facts from these journals. Link to these entities where relevant: ${entityList}

JOURNALS:
${journalText}

For each fact return:
{
  "content": "The atomic fact statement",
  "entityName": "Primary entity this relates to (or 'Self')",
  "category": "self|relationship|habit|health|emotional|progress|insight|event",
  "confidence": 0.0-1.0,
  "temporality": "current|past|permanent",
  "relatedEntities": ["other", "related", "entity", "names"]
}`;

    try {
      const result = await callOpenAI(systemPrompt, userPrompt);
      const newFacts = (result.facts || []).map(f => {
        // Find entity ID
        const entity = entities.find(e => 
          e.name.toLowerCase() === (f.entityName || 'self').toLowerCase()
        );
        const entityId = entity?.id || 'self';

        // Find related entity IDs
        const relatedEntityIds = (f.relatedEntities || [])
          .map(name => entities.find(e => e.name.toLowerCase() === name.toLowerCase())?.id)
          .filter(Boolean);

        return {
          id: generateId('fact'),
          content: f.content,
          entityId,
          category: f.category || 'insight',
          confidence: f.confidence || 0.7,
          temporality: f.temporality || 'current',
          relatedEntityIds,
          createdAt: Date.now(),
          lastReinforcedAt: Date.now(),
          reinforcementCount: 1,
          supersedes: null,
          supersededBy: null
        };
      });

      // Merge with existing (simple append, deduplication by content)
      const existingContents = new Set(existingFacts.map(f => f.content.toLowerCase()));
      const uniqueNewFacts = newFacts.filter(f => !existingContents.has(f.content.toLowerCase()));
      
      const allFacts = [...existingFacts, ...uniqueNewFacts];
      
      console.log(`📝 [CRS] Extracted ${uniqueNewFacts.length} new facts, total: ${allFacts.length}`);
      return allFacts;

    } catch (error) {
      console.error('❌ [CRS] Fact extraction failed:', error.message);
      return existingFacts;
    }
  }

  // ============================================================================
  // OPEN LOOP EXTRACTION
  // ============================================================================

  async processOpenLoops(journalText, entities, existingLoops) {
    console.log('🔄 [CRS] Extracting open loops...');

    const entityList = entities.map(e => e.name).join(', ');
    
    const systemPrompt = `You are a cognitive memory system extracting OPEN LOOPS from personal journals.

An OPEN LOOP is an unresolved item that needs attention:
- Unanswered questions
- Pending decisions
- Unfinished tasks
- Unresolved conflicts
- Things to follow up on
- Commitments made

LOOP TYPES:
- question: Something the user is wondering about
- decision: A choice that needs to be made
- task: Something that needs to be done
- followup: Something to check back on
- conflict: An unresolved interpersonal issue
- commitment: A promise or obligation

PRIORITY:
- 1: Urgent (needs attention soon)
- 2: Important (should address this week)
- 3: Normal (address when convenient)

Return JSON: { "loops": [...] }`;

    const userPrompt = `Extract open loops from these journals. Known entities: ${entityList}

JOURNALS:
${journalText}

For each loop return:
{
  "title": "Brief title of the open loop",
  "description": "What needs to be resolved",
  "loopType": "question|decision|task|followup|conflict|commitment",
  "priority": 1-3,
  "relatedEntities": ["entity", "names"],
  "nextStep": "Suggested next action (optional)"
}`;

    try {
      const result = await callOpenAI(systemPrompt, userPrompt);
      const newLoops = (result.loops || []).map(l => {
        const relatedEntityIds = (l.relatedEntities || [])
          .map(name => entities.find(e => e.name.toLowerCase() === name.toLowerCase())?.id)
          .filter(Boolean);

        return {
          id: generateId('loop'),
          title: l.title,
          description: l.description || '',
          loopType: l.loopType || 'task',
          priority: l.priority || 2,
          status: 'open',
          relatedEntityIds,
          nextStep: l.nextStep || null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          resolvedAt: null
        };
      });

      // Check if existing loops should be marked resolved
      const existingTitles = new Set(existingLoops.map(l => l.title.toLowerCase()));
      const uniqueNewLoops = newLoops.filter(l => !existingTitles.has(l.title.toLowerCase()));

      const allLoops = [...existingLoops, ...uniqueNewLoops];
      
      console.log(`🔄 [CRS] Extracted ${uniqueNewLoops.length} new loops, total: ${allLoops.length}`);
      return allLoops;

    } catch (error) {
      console.error('❌ [CRS] Open loop extraction failed:', error.message);
      return existingLoops;
    }
  }

  // ============================================================================
  // PATTERN DETECTION
  // ============================================================================

  async processPatterns(journalText, facts, existingPatterns) {
    console.log('🔍 [CRS] Detecting patterns...');

    const factSummary = facts.slice(-50).map(f => `[${f.category}] ${f.content}`).join('\n');
    
    const systemPrompt = `You are a cognitive memory system detecting PATTERNS in personal journals.

A PATTERN is a recurring behavioral or emotional regularity:
- Triggers that cause certain states
- Time-based patterns (e.g., "stressed on Sunday nights")
- Correlations between activities and outcomes
- Repeated behaviors or reactions
- Cause-and-effect relationships

PATTERN STATUS:
- provisional: Hypothesis based on limited data
- confirmed: Strong evidence across multiple instances

DOMAINS:
- emotional: Patterns in emotional states
- behavioral: Patterns in actions/behaviors
- relational: Patterns in relationships
- productivity: Patterns in work/output
- health: Patterns in physical/mental health
- creative: Patterns in creative work

Return JSON: { "patterns": [...] }`;

    const userPrompt = `Detect behavioral patterns from these journals and facts:

JOURNALS:
${journalText}

RECENT FACTS:
${factSummary}

For each pattern return:
{
  "claim": "Clear statement of the pattern (e.g., 'You tend to feel anxious before important meetings')",
  "hypothesis": "Longer explanation of the pattern",
  "domain": "emotional|behavioral|relational|productivity|health|creative",
  "status": "provisional|confirmed",
  "strength": 0.0-1.0,
  "evidence": ["Brief evidence point 1", "Brief evidence point 2"],
  "testableBy": "How to test if this pattern is real"
}`;

    try {
      const result = await callOpenAI(systemPrompt, userPrompt, 0.4);
      const newPatterns = (result.patterns || []).map(p => ({
        id: generateId('pattern'),
        claim: p.claim,
        hypothesis: p.hypothesis || p.claim,
        domain: p.domain || 'behavioral',
        status: p.status || 'provisional',
        strength: p.strength || 0.5,
        supportingFactIds: [],
        evidence: p.evidence || [],
        testableBy: p.testableBy || '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        confirmedAt: p.status === 'confirmed' ? Date.now() : null
      }));

      // Merge patterns (avoid duplicates by claim similarity)
      const existingClaims = existingPatterns.map(p => p.claim.toLowerCase());
      const uniqueNewPatterns = newPatterns.filter(p => 
        !existingClaims.some(existing => 
          existing.includes(p.claim.toLowerCase().substring(0, 30)) ||
          p.claim.toLowerCase().includes(existing.substring(0, 30))
        )
      );

      const allPatterns = [...existingPatterns, ...uniqueNewPatterns];
      
      console.log(`🔍 [CRS] Detected ${uniqueNewPatterns.length} new patterns, total: ${allPatterns.length}`);
      return allPatterns;

    } catch (error) {
      console.error('❌ [CRS] Pattern detection failed:', error.message);
      return existingPatterns;
    }
  }

  // ============================================================================
  // NARRATIVE GENERATION
  // ============================================================================

  async processNarratives(journalText, entities, facts, existingNarratives) {
    console.log('📖 [CRS] Generating narratives...');

    const peopleEntities = entities.filter(e => e.category === 'people' && e.id !== 'self');
    const projectEntities = entities.filter(e => e.category === 'projects');
    const entityNames = [...peopleEntities, ...projectEntities].map(e => e.name).join(', ');
    
    const systemPrompt = `You are a cognitive memory system generating NARRATIVES from personal journals.

A NARRATIVE is a story arc that tracks development over time:
- Relationship arcs (how a relationship is evolving)
- Project/goal arcs (progress toward something)
- Personal growth arcs (self-development journeys)
- Challenge arcs (dealing with difficulties)

TRAJECTORY:
- improving: Things are getting better
- declining: Things are getting worse
- stable: Steady state
- chaotic: Unpredictable changes
- transforming: Major shift happening

Return JSON: { "narratives": [...] }`;

    const userPrompt = `Generate narrative arcs from these journals. Key entities: ${entityNames}

JOURNALS:
${journalText}

For each narrative return:
{
  "topic": "What/who this narrative is about",
  "type": "relationship|project|growth|challenge",
  "summary": "2-3 sentence summary of the current arc",
  "trajectory": "improving|declining|stable|chaotic|transforming",
  "characters": ["entity", "names", "involved"],
  "keyMoments": ["Important moment 1", "Important moment 2"],
  "currentChallenge": "What's the main challenge right now (if any)",
  "contextPacket": "A paragraph the AI can use to understand this narrative when talking to the user"
}`;

    try {
      const result = await callOpenAI(systemPrompt, userPrompt, 0.5);
      const newNarratives = (result.narratives || []).map(n => {
        const characterIds = (n.characters || [])
          .map(name => entities.find(e => e.name.toLowerCase() === name.toLowerCase())?.id)
          .filter(Boolean);

        return {
          id: generateId('narrative'),
          topic: n.topic,
          type: n.type || 'growth',
          summary: n.summary,
          trajectory: n.trajectory || 'stable',
          characterIds,
          keyMoments: n.keyMoments || [],
          currentChallenge: n.currentChallenge || null,
          contextPacket: n.contextPacket || n.summary,
          lastReferencedAt: Date.now(),
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
      });

      // Merge narratives (update existing by topic)
      const allNarratives = [...existingNarratives];
      for (const newNarrative of newNarratives) {
        const existingIndex = allNarratives.findIndex(n => 
          n.topic.toLowerCase() === newNarrative.topic.toLowerCase()
        );
        if (existingIndex >= 0) {
          // Update existing narrative
          allNarratives[existingIndex] = {
            ...allNarratives[existingIndex],
            summary: newNarrative.summary,
            trajectory: newNarrative.trajectory,
            keyMoments: [...new Set([...allNarratives[existingIndex].keyMoments, ...newNarrative.keyMoments])],
            currentChallenge: newNarrative.currentChallenge,
            contextPacket: newNarrative.contextPacket,
            updatedAt: Date.now()
          };
        } else {
          allNarratives.push(newNarrative);
        }
      }
      
      console.log(`📖 [CRS] Generated ${newNarratives.length} narratives, total: ${allNarratives.length}`);
      return allNarratives;

    } catch (error) {
      console.error('❌ [CRS] Narrative generation failed:', error.message);
      return existingNarratives;
    }
  }

  // ============================================================================
  // EXPORT TO FILESYSTEM
  // ============================================================================

  async exportCRSOutputsToSystemFS(crsOutputs) {
    console.log('📤 [CRS] Exporting to /system file structure...');

    const { entities, facts, loops, patterns, narratives } = crsOutputs;

    // Export entities by category
    for (const entity of entities) {
      const category = entity.category || 'concepts';
      const path = `system/entities/${category}/entity_${entity.id}.json`;
      await this.writeFile(path, entity);
    }

    // Export facts by entity
    for (const fact of facts) {
      const entityId = fact.entityId || 'self';
      // Ensure facts directory for entity exists
      const path = `system/facts/${entityId}/fact_${fact.id}.json`;
      await this.writeFile(path, fact);
    }

    // Export loops
    for (const loop of loops) {
      const dir = loop.status === 'resolved' ? 'resolved/' : '';
      const path = `system/open_loops/${dir}loop_${loop.id}.json`;
      await this.writeFile(path, loop);
    }

    // Export patterns
    for (const pattern of patterns) {
      const path = `system/patterns/pattern_${pattern.id}.json`;
      await this.writeFile(path, pattern);
    }

    // Export narratives
    for (const narrative of narratives) {
      const path = `system/narratives/narrative_${narrative.id}.json`;
      await this.writeFile(path, narrative);
    }

    console.log(`✅ [CRS] Exported ${entities.length} entities, ${facts.length} facts, ${loops.length} loops, ${patterns.length} patterns, ${narratives.length} narratives`);
  }

  /**
   * Generate update manifest for RTCS sync
   */
  async generateUpdateManifest(crsOutputs) {
    const { entities, facts, loops, patterns, narratives } = crsOutputs;

    const manifest = {
      timestamp: Date.now(),
      processedAt: new Date().toISOString(),
      updatedEntities: entities.map(e => e.id),
      updatedFacts: facts.map(f => f.id),
      updatedLoops: loops.map(l => l.id),
      updatedPatterns: patterns.map(p => p.id),
      updatedNarratives: narratives.map(n => n.id),
      totalEntities: entities.length,
      totalFacts: facts.length,
      totalLoops: loops.length,
      totalPatterns: patterns.length,
      totalNarratives: narratives.length,
      processingTimeMs: this.lastProcessingTime ? Date.now() - this.lastProcessingTime : null
    };

    await this.writeFile('system/updates/latest.json', manifest);
    
    // Also write with timestamp for history
    const timestampedPath = `system/updates/manifest_${Date.now()}.json`;
    await this.writeFile(timestampedPath, manifest);
    
    console.log('✅ [CRS] Update manifest generated and stored');
    return manifest;
  }

  // ============================================================================
  // FILE OPERATIONS
  // ============================================================================

  async loadExistingSystemFiles(type) {
    try {
      const { data: files } = await supabase.storage
        .from('horizon-files')
        .list(`system/${type}`, { recursive: true });

      if (!files) return [];

      const systemFiles = [];
      for (const file of files) {
        if (file.name.endsWith('.json') && file.name !== '.keep') {
          // Handle nested directories (like entities/people/)
          const path = file.id ? `system/${type}/${file.name}` : `system/${type}/${file.name}`;
          const content = await this.readFile(path);
          if (content && typeof content === 'object') {
            systemFiles.push(content);
          }
        }
      }

      return systemFiles;
    } catch (error) {
      console.error(`❌ [CRS] Failed to load existing ${type}:`, error.message);
      return [];
    }
  }

  async writeFile(path, data) {
    try {
      const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
      
      const { error } = await supabase.storage
        .from('horizon-files')
        .upload(path, content, { 
          contentType: 'application/json',
          upsert: true 
        });

      if (error) {
        throw error;
      }

      return true;
    } catch (error) {
      console.error(`❌ [CRS] Failed to write file ${path}:`, error.message);
      throw error;
    }
  }

  async readFile(path) {
    try {
      const { data, error } = await supabase.storage
        .from('horizon-files')
        .download(path);

      if (error || !data) {
        return null;
      }

      const text = await data.text();
      return JSON.parse(text);
    } catch (error) {
      // Don't log for expected "not found" cases
      if (!error.message?.includes('not found')) {
        console.error(`❌ [CRS] Failed to read file ${path}:`, error.message);
      }
      return null;
    }
  }

  async listFiles(path) {
    try {
      const { data: files, error } = await supabase.storage
        .from('horizon-files')
        .list(path, { recursive: true });

      if (error) {
        throw error;
      }

      return files || [];
    } catch (error) {
      console.error(`❌ [CRS] Failed to list files in ${path}:`, error.message);
      return [];
    }
  }

  async deleteFile(path) {
    try {
      const { error } = await supabase.storage
        .from('horizon-files')
        .remove([path]);

      if (error) {
        throw error;
      }

      return true;
    } catch (error) {
      console.error(`❌ [CRS] Failed to delete file ${path}:`, error.message);
      return false;
    }
  }

  // ============================================================================
  // MANUAL TRIGGER & STATUS
  // ============================================================================

  setupManualTrigger() {
    return {
      trigger: async () => {
        console.log('🔧 [CRS] Manual processing triggered...');
        await this.runNightlyProcessing();
      },
      status: () => ({
        isProcessing: this.isProcessing,
        lastProcessingTime: this.lastProcessingTime
      })
    };
  }

  async getSystemExport() {
    try {
      const entities = await this.loadExistingSystemFiles('entities');
      const facts = await this.loadExistingSystemFiles('facts');
      const openLoops = await this.loadExistingSystemFiles('open_loops');
      const narratives = await this.loadExistingSystemFiles('narratives');
      const patterns = await this.loadExistingSystemFiles('patterns');
      const manifest = await this.readFile('system/updates/latest.json');

      return {
        entities: this.groupBy(entities, 'category'),
        facts: this.groupBy(facts, 'entityId'),
        openLoops,
        narratives,
        patterns,
        manifest
      };
    } catch (error) {
      console.error('❌ [CRS] Failed to get system export:', error.message);
      throw error;
    }
  }

  async getSystemFile(filePath) {
    const fullPath = filePath.startsWith('system/') ? filePath : `system/${filePath}`;
    return await this.readFile(fullPath);
  }

  async getSystemManifest() {
    return await this.readFile('system/updates/latest.json');
  }

  groupBy(array, property) {
    return array.reduce((groups, item) => {
      const key = item[property] || 'unknown';
      if (!groups[key]) {
        groups[key] = [];
      }
      groups[key].push(item);
      return groups;
    }, {});
  }
}

export default HorizonCRSService;
