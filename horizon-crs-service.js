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
    this.fileLocks = new Map(); // ADD THIS LINE
  }

  /**
   * Acquire a lock for a specific file path
   * Returns a release function that must be called when done
   */
  async acquireFileLock(filePath) {
    // If there's already a lock for this file, wait for it
    while (this.fileLocks.has(filePath)) {
      await this.fileLocks.get(filePath);
    }
    
    // Create a new lock
    let releaseLock;
    const lockPromise = new Promise(resolve => {
      releaseLock = resolve;
    });
    this.fileLocks.set(filePath, lockPromise);
    
    // Return the release function
    return () => {
      this.fileLocks.delete(filePath);
      releaseLock();
    };
  }

  /**
   * Atomic read-modify-write operation for JSON files
   * Prevents race conditions when multiple operations target the same file
   */
  async atomicUpdate(filePath, updateFn) {
    const release = await this.acquireFileLock(filePath);
    
    try {
      // Read current data
      const currentData = await this.readFile(filePath) || {};
      
      // Apply the update function
      const newData = await updateFn(currentData);
      
      // Write back
      await this.writeFile(filePath, newData);
      
      return newData;
    } finally {
      release();
    }
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
      console.log(`🗓️ [CRS] Processing date ${date}: ${entries?.length || 0} entries`);
      if (entries && entries.length > 0) {
        const totalChars = entries.reduce((sum, e) => sum + (e.content?.length || 0), 0);
        console.log(`📊 [CRS] Date ${date}: ${totalChars} total characters`);
      }
      for (const entry of entries) {
        allJournals.push({ ...entry, date });
      }
    }
    console.log(`📈 [CRS] Total journal entries loaded: ${allJournals.length}`)

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
    console.log(`📝 [CRS] Processing ${recentJournals.length} journal entries`);
    recentJournals.forEach((j, i) => {
      const contentLength = (j.content || j.text || '').length;
      console.log(`  ${i+1}. [${j.date}] ${contentLength} chars: "${(j.content || j.text || '').substring(0, 50)}..."`);
    });
    
    const journalText = recentJournals
      .map(j => `[${j.date}] ${j.content || j.text || ''}`)
      .join('\n\n');

    console.log(`📖 [CRS] Total journal text length: ${journalText.length} characters`);

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
    let entities = await this.processEntities(journalText, rawData.existing.entities);
    let facts = await this.processFacts(journalText, entities, rawData.existing.facts);
    let loops = await this.processOpenLoops(journalText, entities, rawData.existing.loops);
    let patterns = await this.processPatterns(journalText, facts, rawData.existing.patterns);
    let narratives = await this.processNarratives(journalText, entities, facts, rawData.existing.narratives);

    // ========================================
    // POST-PROCESSING REFINEMENTS
    // ========================================
    
    // 1. Apply entity decay (reduce salience of entities not mentioned this run)
    entities = this.applyEntityDecay(entities, rawData.existing.entities);
    
    // 2. Reinforce repeated facts (increase confidence)
    facts = this.reinforceFacts(facts, rawData.existing.facts);
    
    // 3. Upgrade patterns (hypothesis → confirmed after 2+ datapoints)
    patterns = this.upgradePatterns(patterns, facts);
    
    // 4. Merge similar open loops
    loops = this.mergeOpenLoops(loops);

    console.log('✨ [CRS] Post-processing refinements applied');

    return { entities, facts, loops, patterns, narratives };
  }

  // ============================================================================
  // POST-PROCESSING REFINEMENTS
  // ============================================================================

  /**
   * Apply decay to entities not mentioned in this run
   * Entities lose 0.05 salience per day without mention (min 0.1)
   */
  applyEntityDecay(currentEntities, previousEntities) {
    const now = Date.now();
    const ONE_DAY = 24 * 60 * 60 * 1000;
    
    return currentEntities.map(entity => {
      // Find if this entity existed before
      const previous = previousEntities.find(p => p.id === entity.id);
      
      if (previous && entity.lastMentionedAt === previous.lastMentionedAt) {
        // Entity wasn't mentioned this run - apply decay
        const daysSinceLastMention = Math.floor((now - entity.lastMentionedAt) / ONE_DAY);
        const decay = daysSinceLastMention * (entity.decayRate || 0.05);
        const newSalience = Math.max(0.1, (entity.salience || 0.5) - decay);
        
        if (newSalience < entity.salience) {
          console.log(`📉 [DECAY] ${entity.name}: ${entity.salience?.toFixed(2)} → ${newSalience.toFixed(2)}`);
          return {
            ...entity,
            salience: newSalience,
            lastDecayAt: now
          };
        }
      }
      
      return entity;
    });
  }

  /**
   * Reinforce facts that appear in multiple runs
   * Increases confidence by 0.1 per reinforcement (max 1.0)
   */
  reinforceFacts(currentFacts, previousFacts) {
    return currentFacts.map(fact => {
      // Check if similar fact existed before
      const similar = previousFacts.find(p => {
        const similarity = this.calculateTextSimilarity(p.content, fact.content);
        return similarity > 0.7 && p.entityId === fact.entityId;
      });
      
      if (similar && similar.id !== fact.id) {
        // This is a reinforcement of an existing fact
        const newConfidence = Math.min(1.0, (similar.confidence || 0.7) + 0.1);
        const newCount = (similar.reinforcementCount || 1) + 1;
        
        console.log(`📈 [REINFORCE] "${fact.content.substring(0, 40)}..." confidence: ${newConfidence.toFixed(2)} (×${newCount})`);
        
        return {
          ...similar,
          content: fact.content, // Use latest wording
          confidence: newConfidence,
          reinforcementCount: newCount,
          lastReinforcedAt: Date.now(),
          updatedAt: Date.now()
        };
      }
      
      return fact;
    });
  }

  /**
   * Upgrade patterns from hypothesis to confirmed
   * After 2+ supporting facts or mentions, status becomes "confirmed"
   */
  upgradePatterns(patterns, facts) {
    return patterns.map(pattern => {
      if (pattern.status === 'confirmed') return pattern;
      
      // Count supporting evidence
      const patternWords = new Set(pattern.claim.toLowerCase().split(/\s+/).filter(w => w.length > 3));
      
      let supportCount = 0;
      for (const fact of facts) {
        const factWords = new Set(fact.content.toLowerCase().split(/\s+/).filter(w => w.length > 3));
        const overlap = [...patternWords].filter(w => factWords.has(w)).length;
        if (overlap >= 2) supportCount++;
      }
      
      // Also count existing evidence
      supportCount += (pattern.evidence?.length || 0);
      
      if (supportCount >= 2 && pattern.status === 'hypothesis') {
        console.log(`🎯 [UPGRADE] Pattern "${pattern.claim.substring(0, 40)}..." → CONFIRMED (${supportCount} datapoints)`);
        return {
          ...pattern,
          status: 'confirmed',
          strength: Math.min(1.0, (pattern.strength || 0.5) + 0.2),
          confirmedAt: Date.now(),
          updatedAt: Date.now()
        };
      }
      
      return pattern;
    });
  }

  /**
   * Merge similar open loops into single loops with combined context
   */
  mergeOpenLoops(loops) {
    const openLoops = loops.filter(l => l.status === 'open');
    const resolvedLoops = loops.filter(l => l.status === 'resolved');
    const merged = [];
    const mergedIds = new Set();
    
    for (const loop of openLoops) {
      if (mergedIds.has(loop.id)) continue;
      
      // Find similar loops
      const similar = openLoops.filter(other => {
        if (other.id === loop.id || mergedIds.has(other.id)) return false;
        const similarity = this.calculateTextSimilarity(loop.title, other.title);
        return similarity > 0.6;
      });
      
      if (similar.length > 0) {
        // Merge into primary loop
        const allRelatedEntities = [...new Set([
          ...(loop.relatedEntityIds || []),
          ...similar.flatMap(s => s.relatedEntityIds || [])
        ])];
        
        // Use earliest due date
        const dueDates = [loop.dueDate, ...similar.map(s => s.dueDate)].filter(Boolean);
        const earliestDue = dueDates.sort()[0] || null;
        
        console.log(`🔗 [MERGE] Combining ${similar.length + 1} similar loops: "${loop.title}"`);
        
        merged.push({
          ...loop,
          relatedEntityIds: allRelatedEntities,
          dueDate: earliestDue,
          priority: Math.min(loop.priority || 2, ...similar.map(s => s.priority || 2)),
          updatedAt: Date.now()
        });
        
        similar.forEach(s => mergedIds.add(s.id));
      } else {
        merged.push(loop);
      }
      
      mergedIds.add(loop.id);
    }
    
    return [...merged, ...resolvedLoops];
  }

  /**
   * Calculate text similarity (word overlap ratio)
   */
  calculateTextSimilarity(text1, text2) {
    const words1 = new Set(text1.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    const words2 = new Set(text2.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    const overlap = [...words1].filter(w => words2.has(w)).length;
    return overlap / Math.max(words1.size, words2.size);
  }

  // ============================================================================
  // ENTITY EXTRACTION
  // ============================================================================

  async processEntities(journalText, existingEntities) {
    console.log('👥 [CRS] Extracting entities (v3 balanced)...');

    const existingNames = existingEntities.map(e => e.name.toLowerCase());
    
    const systemPrompt = `You are a cognitive memory system extracting ENTITIES from personal journals.

ENTITY RULES (v3 Balanced):

✅ ALWAYS create an entity for:
- Proper nouns referring to people (Sarah, Mom, Dr. Lee, Mike)
- Recurring project/work items (AI Project, Marketing Plan, "the project")
- Organizations or teams (Our team, OpenAI, Department)
- Named events that will happen (Architecture Meeting, Tuesday Coffee)

✅ CREATE if it appears 2+ times:
- A specific place (downtown coffee shop, the gym, the office)
- A long-term concept (anxiety, confidence, morning creativity)

🚫 DO NOT create entities for:
- Activities (working out, coding, sleeping)
- Adjectives or states (excited, stressed, confident)
- Generic concepts (programming skills, AI features, technical architecture)
- Time phrases (morning hours, next week)

QUANTITY RULES:
- MINIMUM: 1 entity if any person is mentioned by name
- MAXIMUM: 4 entities per processing run
- If a person is named (Sarah, Mike, etc.) → MUST create entity

Return JSON: { "entities": [...] }`;

    const userPrompt = `Extract entities from these journals.

EXISTING ENTITIES (don't duplicate): ${existingNames.join(', ') || 'none yet'}

JOURNALS:
${journalText}

CRITICAL: If you see ANY person's name (Sarah, Mom, Dr. Smith, etc.), you MUST create an entity for them.

Return 1-4 entities. For each:
{
  "name": "Entity Name",
  "category": "people|projects|places",
  "aliases": [],
  "salience": 0.5-1.0,
  "description": "Brief description",
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
    console.log('📝 [CRS] Extracting facts (v3 balanced)...');

    const entityList = entities.map(e => `${e.name} (${e.category})`).join(', ');
    const existingFactContents = existingFacts.slice(-20).map(f => f.content).join('; ');
    
    const systemPrompt = `You are a cognitive memory system extracting FACTS from personal journals.

CRITICAL: Facts belong to the entity they are ABOUT, not the narrator.
- "Sarah is excited about AI" → entityName: "Sarah" (it's about Sarah)
- "I feel anxious" → entityName: "Self" (it's about the user)
- "Sarah and I had coffee" → entityName: "Self" BUT relatedEntities: ["Sarah"] (user's action, Sarah involved)
- "Sarah suggested meditation" → entityName: "Sarah" (Sarah's action/attribute)

FACT CATEGORIES:
- biographical: Who someone is, their role, background (including where they live / are from)
- preference: What someone likes/dislikes
- belief: What someone believes or values  
- relationship: How two entities relate to each other
- habit: Behavioral patterns
- health: Physical or mental health
- emotional: Emotional states (especially when tied to specific people/events)
- progress: Progress on goals
- insight: Realizations or learnings
- skill: Abilities or expertise
- plan: Future intentions

RELATIONSHIP ATTRIBUTION RULES:
- If a sentence describes a STABLE property about another person (where they live, where they're from, what they believe, how they show up), entityName MUST be that person, not Self.
- Facts about the user's *internal reaction* go to Self ("I felt devastated after Stella called").
- Facts about the OTHER person's qualities, location, or role go to THEM ("Stella lives in Chicago", "Stella is from LA", "Stella is my twin flame").

DREAMS (IMPORTANT):
Treat emotionally significant dreams as valid sources of facts when:
- The dream involves a recurring person (e.g., Stella),
- The dream has strong emotional weight,
- OR it clearly affects the user's interpretation of the relationship.

From such dreams, create:
- Facts about the OTHER person's role in the user's inner world  
  (e.g., "In a dream, Stella expressed relief about the relationship")
- Facts about the USER's emotional response and interpretation  
  (e.g., "User felt intense relief after dreaming about Stella")

Mark these as:
- category: "emotional" or "relationship"
- temporality: "current"
- confidence: 0.4–0.7 (they are subjective, symbolic)

CORE WOUNDS & SELF-SCHEMAS:
If the user explicitly names a wound or core pattern (e.g. "my wound is validation", "I have an abandonment wound"):
- ALWAYS create at least one fact for Self:
  - content: concise version of the wound
  - category: "belief" or "insight"
  - temporality: "current"
- This should happen EVEN if it's only mentioned once.

SYMBOLIC / SPIRITUAL RELATIONSHIP TERMS:
Terms like "twin flame", "soulmate", "soul connection", "manifestation" are IMPORTANT belief frameworks.
- Always store them as belief / relationship facts, even if subjective.
- For "X is my twin flame":
  - Create a fact for Self: "User describes X as their twin flame"
  - Create a fact for the OTHER person with lower confidence: "X is described by the user as their twin flame"

GEOGRAPHICAL FACTS (HIGH PRIORITY):
Always extract biographical facts about where people are:
- "Stella lives in Chicago" → entityName: "Stella", category: "biographical", temporality: "current"
- "Stella is from LA" → entityName: "Stella", category: "biographical", temporality: "permanent" or "past"
- "Stella will be in Chicago on Dec 8" → entityName: "Stella", category: "biographical" or "relationship", temporality: "current"

QUANTITY RULES:
- MINIMUM: 3 facts if any meaningful content exists
- MAXIMUM: 8 facts per processing run
- NEVER return zero unless journal is literally empty

ATOMIC FACTS - break down into smallest truths:
❌ BAD: "Had a great meeting with Sarah about the project"
✅ GOOD:
  - "Sarah is involved in the project" (about Sarah)
  - "User had a meeting with Sarah" (about Self, related: Sarah)
  - "User feels positive about the project" (about Self)

Relationship facts can legitimately produce more than one fact (for Self and for the other entity) when both sides have meaningful attributes or beliefs.

Return JSON: { "facts": [...] }`;

    const userPrompt = `Extract 3-8 meaningful facts from these journals.

KNOWN ENTITIES: ${entityList || 'Self'}

EXISTING FACTS (don't duplicate): ${existingFactContents || 'none yet'}

JOURNALS:
${journalText}

RULES:
1. Each fact = ONE atomic truth
2. entityName = who/what the fact is ABOUT (not who is narrating)
3. Facts about other people go to THEIR entity, not Self
4. Include Self in relatedEntities when the user is involved but fact is about someone else
5. LOCATION facts about other people (where they live, where they are from, where they will be)
   MUST be stored under that person's entity, even if the user is narrating it.

For each fact return:
{
  "content": "Atomic fact statement (8-15 words)",
  "entityName": "Entity this is ABOUT (or 'Self')",
  "category": "biographical|emotional|insight|progress|relationship|habit|preference|plan|belief|skill|health",
  "confidence": 0.5-1.0,
  "temporality": "current|permanent",
  "relatedEntities": ["other entities mentioned"]
}`;

    try {
      const result = await callOpenAI(systemPrompt, userPrompt);
      const newFacts = (result.facts || []).map(f => {
        // Find entity ID
        const entity = entities.find(e => 
          e.name.toLowerCase() === (f.entityName || 'self').toLowerCase()
        );
        let entityId = entity?.id || 'self';

        // Heuristic: if the fact is clearly about someone else and not written in first person,
        // but the model still pointed it at Self, reassign it to the single related entity.
        const contentLower = (f.content || '').toLowerCase();
        const hasFirstPerson = /\b(i|me|my|mine|myself)\b/.test(contentLower);

        if (entityId === 'self' && !hasFirstPerson && (f.relatedEntities || []).length === 1) {
          const relatedName = f.relatedEntities[0];
          const related = entities.find(e => e.name.toLowerCase() === relatedName.toLowerCase());
          if (related) {
            entityId = related.id;
          }
        }

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
    console.log('🔄 [CRS] Extracting open loops (v3 balanced)...');

    const entityList = entities.map(e => e.name).join(', ');
    const existingLoopTitles = existingLoops.filter(l => l.status === 'open').map(l => `- ${l.title}`).join('\n');
    
    const systemPrompt = `You are a cognitive memory system extracting OPEN LOOPS from personal journals.

An OPEN LOOP is an unresolved item that needs attention:
- Unanswered questions
- Pending decisions
- Unfinished tasks
- Unresolved conflicts
- Things to follow up on
- Commitments made
- Emotionally significant dreams whose meaning or implication the user is clearly still trying to understand

OPEN LOOP RULES (v3 Balanced):

✅ CREATE a loop if:
- A meeting/event is planned (meeting Tuesday, coffee next week)
- A decision is pending (need to decide, should I...)
- A follow-up is needed (check back, email, call)
- A task is implied (prepare, send, review, discuss)
- A commitment was made (promised to, agreed to)
- A significant dream's meaning remains unresolved

🚫 DO NOT create loops for:
- Emotional states alone (feeling anxious)
- Vague intentions (should work out more)
- Habits or routines (need to sleep better)
- Ideas without action (would be nice to...)

QUANTITY RULES:
- MINIMUM: 1 loop if any plan or commitment is mentioned
- MAXIMUM: 2 loops per processing run
- If semantically similar to existing loop → skip (don't duplicate)

Return JSON: { "loops": [...] }`;

    const userPrompt = `Extract 1-2 open loops if any plans/commitments exist.

EXISTING OPEN LOOPS (don't duplicate):
${existingLoopTitles || 'none'}

KNOWN ENTITIES: ${entityList || 'none'}

JOURNALS:
${journalText}

If a meeting, task, or commitment is mentioned, extract it as a loop.

For each loop return:
{
  "title": "Concrete action (e.g., 'Coffee meeting with Sarah Tuesday')",
  "loopType": "task|decision|followup|commitment",
  "priority": 1-3,
  "relatedEntities": ["entity names"],
  "dueDate": "if mentioned"
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
    console.log('🔍 [CRS] Detecting patterns (v3 balanced)...');

    const factSummary = facts.slice(-30).map(f => `[${f.category}] ${f.content}`).join('\n');
    const existingPatternClaims = existingPatterns.map(p => `- ${p.claim} (${p.status})`).join('\n');
    
    const systemPrompt = `You are a cognitive memory system detecting BEHAVIORAL PATTERNS from personal journals.

A PATTERN is a recurring behavioral or emotional regularity:
- Triggers that cause certain states
- Time-based patterns (e.g., "stressed on Sunday nights")
- Correlations between activities and outcomes
- Repeated behaviors or reactions
- Cause-and-effect relationships

Pay special attention to:
- Repeated dreams about the SAME person that clearly affect mood, decisions, or clarity.
- Shifts in confidence, authenticity, or behavior after emotionally intense dreams.

PATTERN STATUS:
- ONE datapoint → status: "hypothesis" (tentative, needs validation)
- TWO+ datapoints → status: "confirmed" (proven pattern)

DOMAINS:
- emotional: Mood patterns and emotional dynamics
- behavioral: Action patterns and habits
- relational: Patterns in relationships
- productivity: Work and focus patterns
- health: Physical and mental health correlations
- creative: Creative flow patterns

ALWAYS CREATE AT LEAST ONE PATTERN WHEN:
- The user explicitly names a "wound", "core wound", or self-schema (e.g. "my wound is validation").
  This should become a provisional pattern in the "emotional" or "relational" domain, even if only mentioned once,
  with moderate strength (e.g. 0.3–0.6) and clear evidence.

Also treat symbolic / spiritual frameworks (e.g. "twin flame", "soulmate", "manifestation laws")
as BEHAVIORALLY IMPORTANT: they shape how the user interprets events and makes decisions.
If such a framework appears even once AND influences how the user thinks about a relationship
or life path, you may create a low-to-moderate strength pattern describing how this framework
affects behavior or expectations.

🚫 REJECT if:
- No emotional/behavioral significance
- Just restates a fact without insight
- Too vague to be actionable

QUANTITY RULES:
- MINIMUM: 1 pattern if any behavioral insight exists
- MAXIMUM: 2 patterns per processing run
- Hypothesis patterns are encouraged - they'll be confirmed later

Return JSON: { "patterns": [...] }`;

    const userPrompt = `Detect 1-2 behavioral patterns from these journals.

EXISTING PATTERNS (don't duplicate):
${existingPatternClaims || 'none yet'}

RECENT FACTS:
${factSummary}

JOURNALS:
${journalText}

Return 1-2 patterns. Use status "hypothesis" for new patterns (they can be confirmed later).

For each pattern return:
{
  "claim": "Pattern statement (10-15 words)",
  "domain": "productivity|emotional|health|relational",
  "status": "hypothesis|confirmed",
  "strength": 0.5-1.0,
  "evidence": ["evidence from journal"]
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
    console.log('📖 [CRS] Generating narratives (v3 balanced)...');

    const peopleEntities = entities.filter(e => e.category === 'people' && e.id !== 'self');
    const projectEntities = entities.filter(e => e.category === 'projects');
    const entityNames = [...peopleEntities, ...projectEntities].map(e => e.name).join(', ');
    const existingNarrativeTopics = existingNarratives.map(n => `- ${n.topic} (${n.type})`).join('\n');
    const factSummary = facts.slice(-10).map(f => f.content).join('; ');
    
    const systemPrompt = `You are a cognitive memory system generating NARRATIVE ARCS from personal journals.

A NARRATIVE is a story arc that tracks development over time:
- Relationship arcs (how a relationship is evolving)
- Project/goal arcs (progress toward something)
- Personal growth arcs (self-development journeys)
- Challenge arcs (dealing with difficulties)

Emotionally intense dreams that change how the user FEELS about a person or situation
should be treated as KEY MOMENTS in the relevant relationship or growth narrative,
not ignored as noise.

NARRATIVE RULES (v3 Balanced):

✅ ALWAYS create narratives for:
- Recurring people (one narrative per person)
- Active projects (one narrative per project)
- Ongoing personal arc (confidence, mood, creativity → combine into one)

✅ ONE narrative per domain:
- Relationship/Social (combine all people interactions)
- Work/Project (combine all project-related)
- Personal Development (combine mood, habits, growth)

✅ NARRATIVE STRUCTURE:
- Topic: Clear name
- Trajectory: stable | improving | declining | uncertain
- Summary: 1-2 compact sentences (like a memory index card)
- Key challenge (if any)

🚫 DO NOT:
- Create one narrative per fact
- Write verbose paragraph summaries
- Make narratives from non-entities
- Create overlapping narratives (Sarah relationship + Sarah project = just "Collaboration with Sarah")

QUANTITY RULES:
- MINIMUM: 1 narrative if any person or project exists
- MAXIMUM: 3 narratives per processing run

Return JSON: { "narratives": [...] }`;

    const userPrompt = `Generate 1-3 compact narrative arcs.

KEY ENTITIES: ${entityNames || 'Self only'}

RECENT FACTS: ${factSummary || 'none'}

EXISTING NARRATIVES (update or merge, don't duplicate):
${existingNarrativeTopics || 'none yet'}

JOURNALS:
${journalText}

For each narrative return:
{
  "topic": "Clear topic (e.g., 'Collaboration with Sarah', 'Personal Development')",
  "type": "relationship|project|growth",
  "summary": "1-2 sentences MAX",
  "trajectory": "improving|declining|stable|uncertain",
  "characters": ["entity names"],
  "currentChallenge": "Main challenge or null"
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
    const contentType = path.endsWith('.json') ? 'application/json' : 'text/plain';
    console.log(`💾 [CRS] Writing ${path}: ${content.length} bytes`);
    
    // Convert string to Blob - this is critical for Supabase Storage
    const blob = new Blob([content], { type: contentType });
    
    // First, try to remove existing file to avoid upsert issues
    await supabase.storage
      .from('horizon-files')
      .remove([path]);
    
    // Upload the blob
    const { error } = await supabase.storage
      .from('horizon-files')
      .upload(path, blob, { 
        contentType: contentType,
        upsert: true
      });

    if (error) {
      console.error(`❌ [CRS] Supabase write error for ${path}:`, error);
      throw error;
    }

    // Verify the write worked by reading it back
    console.log(`🔍 [CRS] Verifying write for ${path}...`);
    
    // Small delay to allow for eventual consistency
    await new Promise(resolve => setTimeout(resolve, 100));
    
    const { data: verification, error: readError } = await supabase.storage
      .from('horizon-files')
      .download(path);
    
    if (readError) {
      console.error(`❌ [CRS] Verification read failed:`, readError);
      return true; // Upload succeeded, verification failed - may be timing
    }
    
    if (verification) {
      const writtenContent = await verification.text();
      console.log(`✅ [CRS] Verified write ${path}: ${writtenContent.length} bytes written`);
      
      if (writtenContent.length !== content.length) {
        console.error(`⚠️ [CRS] SIZE MISMATCH! Expected ${content.length}, got ${writtenContent.length}`);
        
        // Retry with explicit remove + upload
        console.log(`🔧 [CRS] Retrying with delete-then-upload...`);
        
        const { error: removeError } = await supabase.storage
          .from('horizon-files')
          .remove([path]);
          
        if (removeError) {
          console.warn(`⚠️ [CRS] Remove before retry failed:`, removeError.message);
        }
        
        // Wait for deletion to propagate
        await new Promise(resolve => setTimeout(resolve, 200));
        
        const retryBlob = new Blob([content], { type: contentType });
        const { error: retryError } = await supabase.storage
          .from('horizon-files')
          .upload(path, retryBlob, { 
            contentType: contentType
          });
          
        if (retryError) {
          console.error(`❌ [CRS] Retry upload failed:`, retryError);
          throw retryError;
        }
        
        // Verify retry
        await new Promise(resolve => setTimeout(resolve, 100));
        const { data: retryVerify } = await supabase.storage
          .from('horizon-files')
          .download(path);
          
        if (retryVerify) {
          const retryContent = await retryVerify.text();
          if (retryContent.length === content.length) {
            console.log(`✅ [CRS] Retry succeeded: ${retryContent.length} bytes verified`);
          } else {
            console.error(`❌ [CRS] Retry still has size mismatch: expected ${content.length}, got ${retryContent.length}`);
          }
        }
      }
    }

    return true;
  } catch (error) {
    console.error(`❌ [CRS] Failed to write file ${path}:`, error.message);
    throw error;
  }
}

  async readFile(path) {
    try {
      console.log(`🔍 [CRS] Attempting to read file: ${path}`);
      
      // Try method 1: Direct download
      const { data, error } = await supabase.storage
        .from('horizon-files')
        .download(path);

      if (error) {
        console.error(`❌ [CRS] Supabase download error for ${path}:`, error);
        console.log(`🔄 [CRS] Trying alternative method with public URL...`);
        
        // Try method 2: Create signed URL and fetch
        const { data: urlData, error: urlError } = await supabase.storage
          .from('horizon-files')
          .createSignedUrl(path, 60); // 60 second expiry
          
        if (urlError || !urlData?.signedUrl) {
          console.error(`❌ [CRS] Failed to create signed URL:`, urlError);
          return null;
        }
        
        console.log(`📡 [CRS] Fetching via signed URL: ${urlData.signedUrl}`);
        const response = await fetch(urlData.signedUrl);
        if (!response.ok) {
          console.error(`❌ [CRS] HTTP ${response.status}: ${response.statusText}`);
          return null;
        }
        
        const text = await response.text();
        return JSON.parse(text);
      }

      if (!data) {
        console.warn(`⚠️ [CRS] No data returned for ${path}`);
        return null;
      }

      console.log(`✅ [CRS] Successfully downloaded ${path}, size: ${data.size} bytes`);
      const text = await data.text();
      return JSON.parse(text);
    } catch (error) {
      console.error(`❌ [CRS] Failed to read file ${path}:`, error.message);
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
