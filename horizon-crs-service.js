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
    
    const systemPrompt = `You are a cognitive memory system extracting DURABLE ENTITIES from personal journals.

BE SELECTIVE - only extract entities that will persist over time and be referenced again.

ENTITY TYPES (strict criteria):
1. people: Named individuals ONLY (Sarah, Dr. Smith, Mom). Must be a proper name or clear identity.
2. projects: Specific named projects or major goals ("Aurora app", "house renovation", "job search"). NOT generic activities.
3. places: Specific named locations that recur ("the downtown office", "Blue Bottle Coffee", "Chicago")

DO NOT CREATE ENTITIES FOR:
- Generic activities: "working out", "meditation", "programming"
- Abstract concepts: "anxiety", "confidence", "creativity"  
- Time references: "morning", "Tuesday", "next week"
- Skills or traits: "programming skills", "AI features"
- One-off events: "coffee meeting" (unless it's a recurring thing)

These belong in FACTS or PATTERNS, not entities.

ENTITY TEST: Ask "Will I reference this specific thing by name in future conversations?"
- "Sarah" → YES, she's a person I'll mention again
- "The AI project" → YES, it's an ongoing named effort
- "morning hours" → NO, that's just a time preference (→ goes in patterns)
- "technical architecture" → NO, that's a topic (→ goes in facts)

Return JSON: { "entities": [...] } - aim for 1-4 entities max per processing run.`;

    const userPrompt = `Extract ONLY durable, referenceable entities from these journals.

EXISTING ENTITIES (do not duplicate): ${existingNames.join(', ') || 'none yet'}

JOURNALS:
${journalText}

Remember: People = YES. Named projects = YES. Generic concepts/activities = NO.

For each entity return:
{
  "name": "Entity Name (proper noun or specific name)",
  "category": "people|projects|places",
  "aliases": ["nickname", "abbreviation"],
  "salience": 0.0-1.0,
  "description": "Brief: who/what this is",
  "relationshipToSelf": "friend|family|colleague|doctor|acquaintance|partner|mentor|other"
}`;

    try {
      const result = await callOpenAI(systemPrompt, userPrompt);
      const newEntities = (result.entities || []).map(e => ({
        id: `entity_${slugify(e.name)}`,
        name: e.name,
        category: e.category || 'concepts',
        aliases: e.aliases || [],
        salience: e.salience || 0.7,
        description: e.description || '',
        relationshipToSelf: e.relationshipToSelf || null,
        lastMentionedAt: Date.now(),
        mentionCount: 1,
        factIds: [],
        relationshipGraph: e.category === 'people' ? [{ entityId: 'self', relationship: e.relationshipToSelf || 'known', strength: e.salience || 0.7 }] : [],
        decayRate: 0.01,
        lastDecayAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now()
      }));

      // Ensure self entity exists
      const allEntities = [...existingEntities];
      let selfEntity = allEntities.find(e => e.id === 'self' || e.name.toLowerCase() === 'self');
      if (!selfEntity) {
        selfEntity = {
          id: 'self',
          name: 'Self',
          category: 'people',
          aliases: ['I', 'me', 'myself'],
          salience: 1.0,
          description: 'The user themselves',
          relationshipToSelf: null,
          lastMentionedAt: Date.now(),
          mentionCount: 1,
          factIds: [],
          relationshipGraph: [],
          decayRate: 0.01,
          lastDecayAt: Date.now(),
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
        allEntities.push(selfEntity);
      }

      // Merge new entities (avoid duplicates) and build Self's relationship graph
      for (const newEntity of newEntities) {
        const existingIndex = allEntities.findIndex(e => 
          e.name.toLowerCase() === newEntity.name.toLowerCase()
        );
        if (existingIndex === -1) {
          allEntities.push(newEntity);
          
          // Add to Self's relationship graph if it's a person
          if (newEntity.category === 'people' && selfEntity) {
            const existingRelation = selfEntity.relationshipGraph.find(r => r.entityId === newEntity.id);
            if (!existingRelation) {
              selfEntity.relationshipGraph.push({
                entityId: newEntity.id,
                relationship: newEntity.relationshipToSelf || 'known',
                strength: newEntity.salience || 0.7
              });
            }
          }
        } else {
          // Update existing entity
          allEntities[existingIndex].lastMentionedAt = Date.now();
          allEntities[existingIndex].mentionCount = (allEntities[existingIndex].mentionCount || 0) + 1;
          allEntities[existingIndex].updatedAt = Date.now();
          // Update salience if new one is higher
          if (newEntity.salience > (allEntities[existingIndex].salience || 0)) {
            allEntities[existingIndex].salience = newEntity.salience;
          }
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

    const entityList = entities.map(e => `${e.name} (${e.category}, id: ${e.id})`).join('\n- ');
    const existingFactContents = existingFacts.slice(-50).map(f => f.content).join('; ');
    
    const systemPrompt = `You are a cognitive memory system extracting SALIENT FACTS from personal journals.

SELECTIVE EXTRACTION: Only extract facts that are:
1. DURABLE - likely to remain true and be useful in future
2. SPECIFIC - about a known entity (person, project, self)
3. NON-OBVIOUS - provides real insight, not just restating events

FACT CATEGORIES:
- biographical: Who someone is, their role, background
- preference: What someone likes/dislikes  
- belief: What someone believes or values
- relationship: How two entities relate
- habit: Recurring behavioral patterns
- health: Physical or mental health states
- emotional: Significant emotional states
- progress: Meaningful progress on goals
- insight: Important realizations
- skill: Abilities or expertise

DO NOT EXTRACT:
- Event summaries ("Had coffee with Sarah") → not durable
- Temporary states ("Feeling tired today") → too transient
- Generic observations → not insightful
- Anything that just restates the journal text

GOOD FACTS (durable, insightful):
- "Sarah is excited about AI technology"
- "User is more productive in morning hours"
- "Sarah works on the same project as user"

BAD FACTS (just restating events):
- "User had a meeting with Sarah"
- "User went to coffee shop"
- "User discussed the project"

TARGET: 3-6 high-quality facts total, not one per sentence.

Return JSON: { "facts": [...] }`;

    const userPrompt = `Extract ONLY the most salient, durable facts from these journals.

KNOWN ENTITIES:
- ${entityList}

EXISTING FACTS (don't duplicate similar ones):
${existingFactContents || 'none yet'}

JOURNALS:
${journalText}

Extract 3-6 facts MAX that provide real insight. Skip event summaries.

For each fact return:
{
  "content": "Durable insight (8-15 words)",
  "entityName": "Entity this fact is ABOUT",
  "category": "biographical|preference|belief|relationship|habit|health|emotional|progress|insight|skill",
  "confidence": 0.0-1.0,
  "temporality": "current|past|permanent",
  "relatedEntities": ["other entities involved"]
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
    const existingLoopTitles = existingLoops.filter(l => l.status === 'open').map(l => `- ${l.title}`).join('\n');
    
    const systemPrompt = `You are a cognitive memory system extracting OPEN LOOPS from personal journals.

BE SELECTIVE - only extract CONCRETE action items or decisions, not vague concerns.

OPEN LOOP = something specific that needs resolution:
- Scheduled meeting/event coming up
- Decision that must be made
- Task with a deadline
- Commitment to someone
- Question awaiting answer

DO NOT EXTRACT:
- Vague feelings ("I should exercise more")
- General concerns ("worried about work")
- Ongoing situations without action item
- Things already in existing loops

LOOP TYPES:
- task: Something specific to do
- decision: A choice to make
- followup: Something to check on
- commitment: A promise made

TARGET: 0-2 loops per processing run. If nothing concrete, return empty array.

Return JSON: { "loops": [...] }`;

    const userPrompt = `Extract ONLY concrete open loops with clear next actions.

EXISTING OPEN LOOPS (do not duplicate):
${existingLoopTitles || 'none'}

KNOWN ENTITIES: ${entityList || 'none'}

JOURNALS:
${journalText}

Return 0-2 loops MAX. Must be concrete with clear action.

For each loop return:
{
  "title": "Specific action item (e.g., 'Coffee meeting with Sarah Tuesday')",
  "loopType": "task|decision|followup|commitment",
  "priority": 1-3,
  "relatedEntities": ["entity names"],
  "dueDate": "if mentioned (YYYY-MM-DD or 'this week' etc)"
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
          loopType: l.loopType || 'task',
          priority: l.priority || 2,
          status: 'open',
          relatedEntityIds,
          dueDate: l.dueDate || null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          resolvedAt: null
        };
      });

      // Better deduplication - check for semantic overlap
      const uniqueNewLoops = newLoops.filter(newLoop => {
        const newWords = new Set(newLoop.title.toLowerCase().split(/\s+/).filter(w => w.length > 2));
        
        return !existingLoops.some(existing => {
          if (existing.status === 'resolved') return false;
          const existingWords = new Set(existing.title.toLowerCase().split(/\s+/).filter(w => w.length > 2));
          const overlap = [...newWords].filter(w => existingWords.has(w)).length;
          const similarity = overlap / Math.max(newWords.size, existingWords.size);
          return similarity > 0.5; // 50% word overlap = duplicate
        });
      });

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

    const factSummary = facts.slice(-30).map(f => `[${f.category}] ${f.content}`).join('\n');
    const existingPatternClaims = existingPatterns.map(p => `- ${p.claim}`).join('\n');
    
    const systemPrompt = `You are a cognitive memory system detecting BEHAVIORAL PATTERNS from personal journals.

BE HIGHLY SELECTIVE - only identify patterns with clear evidence across MULTIPLE instances.

A PATTERN must have:
1. RECURRENCE - seen multiple times, not just once
2. CAUSALITY - clear trigger → outcome relationship
3. ACTIONABILITY - user could test or act on this insight

GOOD PATTERNS:
- "Morning hours are most productive for creative work" (testable, recurring)
- "Exercise improves mood for several hours after" (causal, recurring)
- "Meetings with Sarah boost confidence" (specific, observable)

BAD PATTERNS (don't extract):
- "User sometimes feels anxious" (too vague)
- "User had a good meeting" (one-off event, not pattern)
- "User likes coffee" (preference, not behavioral pattern)

DOMAINS:
- productivity: Work output patterns
- emotional: Mood/feeling patterns  
- health: Physical/mental health patterns
- relational: Relationship interaction patterns

TARGET: 1-3 high-confidence patterns MAX. If no clear patterns, return empty array.

Return JSON: { "patterns": [...] }`;

    const userPrompt = `Detect ONLY clear, recurring behavioral patterns.

EXISTING PATTERNS (do not duplicate or rephrase):
${existingPatternClaims || 'none yet'}

RECENT FACTS:
${factSummary}

JOURNALS:
${journalText}

Return 1-3 patterns MAX. Each must show clear recurrence. If nothing recurring, return empty array.

For each pattern return:
{
  "claim": "Concise pattern statement (10-15 words)",
  "domain": "productivity|emotional|health|relational",
  "status": "provisional",
  "strength": 0.0-1.0,
  "evidence": ["evidence 1", "evidence 2"]
}`;

    try {
      const result = await callOpenAI(systemPrompt, userPrompt, 0.3);
      const newPatterns = (result.patterns || []).map(p => ({
        id: generateId('pattern'),
        claim: p.claim,
        domain: p.domain || 'behavioral',
        status: p.status || 'provisional',
        strength: p.strength || 0.5,
        supportingFactIds: [],
        evidence: p.evidence || [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      }));

      // Better deduplication - check for semantic overlap
      const uniqueNewPatterns = newPatterns.filter(newP => {
        const newWords = new Set(newP.claim.toLowerCase().split(/\s+/).filter(w => w.length > 3));
        
        return !existingPatterns.some(existingP => {
          const existingWords = new Set(existingP.claim.toLowerCase().split(/\s+/).filter(w => w.length > 3));
          // Calculate word overlap
          const overlap = [...newWords].filter(w => existingWords.has(w)).length;
          const similarity = overlap / Math.max(newWords.size, existingWords.size);
          return similarity > 0.5; // 50% word overlap = duplicate
        });
      });

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
    const existingNarrativeTopics = existingNarratives.map(n => `- ${n.topic} (${n.type})`).join('\n');
    
    const systemPrompt = `You are a cognitive memory system generating NARRATIVE ARCS from personal journals.

BE HIGHLY SELECTIVE - only create narratives for major ongoing storylines.

NARRATIVE TYPES:
- relationship: A significant relationship with a specific person (combine all interactions with same person)
- project: A named project or major goal  
- growth: Personal development theme (combine related growth areas)

RULES:
1. ONE narrative per person (not separate for "relationship" and "project" with same person)
2. ONE narrative per project (not duplicates with slightly different names)
3. Combine related themes into single narratives
4. Max 2-3 narratives total per processing run

GOOD NARRATIVES:
- "Collaboration with Sarah" (combines all Sarah interactions)
- "Career transition" (combines job search, skills, confidence)
- "Health & fitness journey" (combines exercise, diet, energy)

BAD NARRATIVES (too fragmented):
- "Relationship with Sarah" AND "Project with Sarah" (should be one)
- "The project" AND "The new project" AND "Work project" (should be one)
- "Confidence" AND "Programming skills" AND "Personal growth" (should be one)

TRAJECTORY: improving | declining | stable | uncertain

Return JSON: { "narratives": [...] }`;

    const userPrompt = `Generate 1-3 HIGH-LEVEL narrative arcs. Combine related themes.

KEY ENTITIES: ${entityNames || 'none yet'}

EXISTING NARRATIVES (update these, don't create duplicates):
${existingNarrativeTopics || 'none yet'}

JOURNALS:
${journalText}

For each narrative return:
{
  "topic": "Clear topic name (e.g., 'Collaboration with Sarah')",
  "type": "relationship|project|growth",
  "summary": "1-2 sentences on current state",
  "trajectory": "improving|declining|stable|uncertain",
  "characters": ["entity names involved"],
  "currentChallenge": "Main challenge (if any)"
}`;

    try {
      const result = await callOpenAI(systemPrompt, userPrompt, 0.4);
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
          currentChallenge: n.currentChallenge || null,
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
      });

      // Better deduplication - check for semantic overlap on topic
      const allNarratives = [...existingNarratives];
      for (const newNarrative of newNarratives) {
        // Find existing narrative with similar topic (word overlap)
        const newWords = new Set(newNarrative.topic.toLowerCase().split(/\s+/).filter(w => w.length > 2));
        
        const existingIndex = allNarratives.findIndex(existing => {
          const existingWords = new Set(existing.topic.toLowerCase().split(/\s+/).filter(w => w.length > 2));
          const overlap = [...newWords].filter(w => existingWords.has(w)).length;
          const similarity = overlap / Math.max(newWords.size, existingWords.size);
          return similarity > 0.4 || // 40% word overlap
                 existing.topic.toLowerCase().includes(newNarrative.topic.toLowerCase()) ||
                 newNarrative.topic.toLowerCase().includes(existing.topic.toLowerCase());
        });

        if (existingIndex >= 0) {
          // Update existing narrative
          allNarratives[existingIndex] = {
            ...allNarratives[existingIndex],
            summary: newNarrative.summary,
            trajectory: newNarrative.trajectory,
            currentChallenge: newNarrative.currentChallenge,
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
      const basePath = `system/${type}`;
      const allFiles = [];
      
      // First list the base directory
      const { data: items } = await supabase.storage
        .from('horizon-files')
        .list(basePath);

      if (!items) return [];

      for (const item of items) {
        if (item.name === '.keep') continue;
        
        // Check if it's a directory (no metadata means directory in Supabase)
        if (!item.metadata || item.id === null) {
          // It's a subdirectory, list its contents
          const subPath = `${basePath}/${item.name}`;
          const { data: subItems } = await supabase.storage
            .from('horizon-files')
            .list(subPath);
          
          if (subItems) {
            for (const subItem of subItems) {
              if (subItem.name.endsWith('.json') && subItem.name !== '.keep') {
                const filePath = `${subPath}/${subItem.name}`;
                const content = await this.readFile(filePath);
                if (content && typeof content === 'object') {
                  allFiles.push(content);
                }
              }
            }
          }
        } else if (item.name.endsWith('.json')) {
          // It's a file at the base level
          const filePath = `${basePath}/${item.name}`;
          const content = await this.readFile(filePath);
          if (content && typeof content === 'object') {
            allFiles.push(content);
          }
        }
      }

      return allFiles;
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
