/**
 * Horizon CRS Service
 * Cognitive Representation System for Aurora
 * 
 * Handles:
 * - Processing journals/conversations into entities, facts, life threads, patterns, narratives
 * - Exporting CRS outputs to /system file structure in Supabase
 * - Generating update manifests for RTCS sync
 * - Nightly processing cron jobs
 * 
 * Uses Claude Sonnet 4 for intelligent extraction
 */

import { createClient } from '@supabase/supabase-js';
import cron from 'node-cron';

import NightOwlService from './night-owl.service.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anthropicApiKey = process.env.ANTHROPIC_API_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error('Missing Supabase configuration. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables.');
}

if (!anthropicApiKey) {
  console.warn('⚠️ [CRS] ANTHROPIC_API_KEY not set. CRS processing will be limited.');
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

// Entities to never extract (AI assistants, generic terms)
const ENTITY_BLACKLIST = [
  'claude', 'chatgpt', 'gpt', 'ai', 'assistant', 'siri', 'alexa',
  'horizon', 'aurora', 'night owl', 'nightowl', // Our own system names
  'user', 'person', 'someone', 'they', 'them'
];

// ============================================================================
// ANTHROPIC HELPER
// ============================================================================

async function callClaude(systemPrompt, userPrompt, temperature = 0.3) {
  if (!anthropicApiKey) {
    throw new Error('Anthropic API key not configured');
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': anthropicApiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [
        { role: 'user', content: userPrompt }
      ],
      temperature
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Claude API error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  const content = data.content?.[0]?.text;

  if (!content) {
    throw new Error('No content in Claude response');
  }

  // Extract JSON from response (Claude doesn't have a strict JSON mode)
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('No JSON found in Claude response');
  }

  return JSON.parse(jsonMatch[0]);
}

// ============================================================================
// ID GENERATION
// ============================================================================

function generateId(prefix = '') {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return prefix ? `${prefix}_${timestamp}_${random}` : `${timestamp}_${random}`;
}

function slugify(text, maxLength = 40) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .substring(0, maxLength);
}

// ============================================================================
// CRS SERVICE
// ============================================================================

class HorizonCRSService {
  constructor() {
    this.isProcessing = false;
    this.lastProcessingTime = null;
    this.fileLocks = new Map();

    // Initialize Night Owl service
    this.nightOwl = new NightOwlService(this, {
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
      maxThreadsPerRun: 3,
      minEmotionalWeight: 5
    });
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

    // DISABLED: Nightly cron job was costing $5-10/night
    // CRS processing now only runs on manual trigger
    // Start nightly cron job at 2 AM PST (10 AM UTC)
    // Railway servers run in UTC, so we need to adjust: 2 AM PST = 10 AM UTC
    /*
    cron.schedule('0 10 * * *', async () => {
      const pstTime = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
      console.log(`🌙 [CRS] Starting nightly processing at ${pstTime} PST...`);
      await this.runNightlyProcessing();
    });
    */
    console.log('⚠️ [CRS] Automatic nightly processing DISABLED (cost savings)');
    console.log('⚠️ [CRS] Use /system/process endpoint to trigger manually');

    // Optional: Add a manual trigger endpoint for testing
    this.setupManualTrigger();

    console.log('✅ [CRS] Service initialized. Manual processing only.');
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
      'system/life_threads',
      'system/life_threads/resolved',
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

      // 5. Generate suggested questions
      const suggestedQuestions = await this.generateSuggestedQuestions(crsOutputs);
      await this.writeFile('system/suggested_questions.json', {
        questions: suggestedQuestions,
        generatedAt: Date.now()
      });

      // 6. Run Night Owl autonomous processing
      console.log('🦉 [CRS] Starting Night Owl processing...');
      try {
        const nightOwlResults = await this.nightOwl.process();
        console.log(`🦉 [CRS] Night Owl complete: ${nightOwlResults.processed} insights generated`);
        if (nightOwlResults.breakdown) {
          console.log(`🦉 [CRS] Breakdown: threads=${nightOwlResults.breakdown.threads}, prep=${nightOwlResults.breakdown.prep}, patterns=${nightOwlResults.breakdown.patterns}, reminders=${nightOwlResults.breakdown.reminders}, accountability=${nightOwlResults.breakdown.accountability}, connections=${nightOwlResults.breakdown.connections}, health=${nightOwlResults.breakdown.health}, learning=${nightOwlResults.breakdown.learning}, plans=${nightOwlResults.breakdown.plans}`);
        }
      } catch (nightOwlError) {
        console.error('❌ [CRS] Night Owl processing failed:', nightOwlError.message);
        // Don't fail the whole nightly run if Night Owl fails
      }

      const processingTime = Date.now() - startTime;
      this.lastProcessingTime = Date.now();

      console.log(`✅ [CRS] Nightly processing completed in ${processingTime}ms`);
      console.log(`📈 [CRS] Processed: ${crsOutputs.entities.length} entities, ${crsOutputs.facts.length} facts, ${crsOutputs.lifeThreads.length} threads, ${crsOutputs.patterns.length} patterns, ${crsOutputs.narratives.length} narratives`);

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
    const existingLifeThreads = await this.loadExistingSystemFiles('life_threads');
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
    console.log(`📥 [CRS] Existing: ${existingEntities.length} entities, ${existingFacts.length} facts, ${existingLifeThreads.length} life threads`);

    return {
      journals: allJournals,
      conversations: allConversations,
      existing: {
        entities: existingEntities,
        facts: existingFacts,
        lifeThreads: existingLifeThreads,
        patterns: existingPatterns,
        narratives: existingNarratives
      }
    };
  }

  /**
   * Process raw data into cognitive representations
   */
  async processCognitiveData(rawData) {
    console.log('🧠 [CRS] Processing cognitive data with Claude...');

    if (!anthropicApiKey) {
      console.warn('⚠️ [CRS] No Anthropic key - returning existing data only');
      return {
        entities: rawData.existing.entities || [],
        facts: rawData.existing.facts || [],
        lifeThreads: rawData.existing.lifeThreads || [],
        patterns: rawData.existing.patterns || [],
        narratives: rawData.existing.narratives || []
      };
    }

    // Combine journal content for processing
    const recentJournals = rawData.journals.slice(-30); // Last 30 entries
    console.log(`📝 [CRS] Processing ${recentJournals.length} journal entries`);
    recentJournals.forEach((j, i) => {
      const contentLength = (j.content || j.text || '').length;
      console.log(`  ${i + 1}. [${j.date}] ${contentLength} chars: "${(j.content || j.text || '').substring(0, 50)}..."`);
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
        lifeThreads: rawData.existing.lifeThreads || [],
        patterns: rawData.existing.patterns || [],
        narratives: rawData.existing.narratives || []
      };
    }

    // Process each type
    let entities = await this.processEntities(journalText, rawData.existing.entities);
    let facts = await this.processFacts(journalText, entities, rawData.existing.facts);
    
    // Process LIFE THREADS (the tracking system for ongoing situations)
    let lifeThreads = await this.processLifeThreads(journalText, entities, facts, rawData.existing.lifeThreads);
    
    let patterns = await this.processPatterns(journalText, facts, rawData.existing.patterns);
    let narratives = await this.processNarratives(journalText, entities, facts, rawData.existing.narratives);

    // ========================================
    // POST-PROCESSING REFINEMENTS
    // ========================================

    // 1. Apply entity decay (reduce salience of entities not mentioned this run)
    entities = this.applyEntityDecay(entities, rawData.existing.entities);

    // 2. Resolve fact contradictions (supersede outdated facts)
    const { resolvedNew, updatedExisting } = await this.resolveFactContradictions(facts, rawData.existing.facts);
    facts = [...updatedExisting, ...resolvedNew];

    // 3. Reinforce repeated facts (increase confidence)
    facts = this.reinforceFacts(facts, rawData.existing.facts);

    // 4. Upgrade patterns (hypothesis → confirmed after 2+ datapoints)
    patterns = this.upgradePatterns(patterns, facts);

    // 5. Detect and prioritize milestones (using life threads)
    const milestones = await this.detectMilestones(journalText, entities, lifeThreads);
    if (milestones.length > 0) {
      console.log(`🎯 [CRS] Detected ${milestones.length} milestone signals`);

      for (const milestone of milestones) {
        console.log(`  → ${milestone.type}: "${milestone.signal}" (intensity: ${milestone.intensity}, entity: ${milestone.entityName || 'unknown'})`);

        // Boost entity salience
        if (milestone.entityId) {
          const entity = entities.find(e => e.id === milestone.entityId);
          if (entity) {
            entity.salience = Math.min(1.0, (entity.salience || 0.5) + 0.2);
            entity.hasMilestone = true;
            entity.milestoneDate = milestone.daysUntil
              ? new Date(Date.now() + milestone.daysUntil * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
              : null;
            console.log(`  📈 Boosted ${entity.name} salience to ${entity.salience.toFixed(2)}`);
          }
        }

        // Update narrative trajectory
        const narrative = narratives.find(n =>
          n.characterIds?.includes(milestone.entityId) ||
          n.topic.toLowerCase().includes(milestone.entityName?.toLowerCase() || '')
        );
        if (narrative) {
          narrative.trajectory = 'approaching_milestone';
          narrative.milestoneDate = milestone.daysUntil
            ? new Date(Date.now() + milestone.daysUntil * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
            : null;
          console.log(`  📖 Updated narrative "${narrative.topic}" → approaching_milestone`);
        }
        
        // Update related life threads with milestone info
        const thread = lifeThreads.find(t =>
          t.relatedEntities?.includes(milestone.entityId) ||
          t.title.toLowerCase().includes(milestone.entityName?.toLowerCase() || '')
        );
        if (thread && !thread.resolved) {
          thread.emotionalWeight = Math.min(10, (thread.emotionalWeight || 5) + 2);
          thread.nextMilestone = {
            date: Date.now() + (milestone.daysUntil * 24 * 60 * 60 * 1000),
            description: milestone.signal
          };
          console.log(`  🧵 Updated thread "${thread.title}" with milestone`);
        }
        
        // If no thread exists for this milestone, create one
        if (!thread && milestone.entityId && milestone.daysUntil) {
          const newThread = {
            id: `thread_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            title: `${milestone.entityName} - upcoming milestone`,
            category: 'waiting',
            status: `${milestone.signal}`,
            currentContext: `Milestone detected: ${milestone.signal}`,
            emotionalWeight: Math.min(10, 5 + milestone.intensity),
            lastUpdate: Date.now(),
            createdAt: Date.now(),
            updates: [{
              timestamp: Date.now(),
              content: `Milestone detected: ${milestone.signal}`,
              source: 'crs'
            }],
            nextMilestone: {
              date: Date.now() + (milestone.daysUntil * 24 * 60 * 60 * 1000),
              description: milestone.signal
            },
            pastMilestones: [],
            relatedEntities: [milestone.entityId],
            relatedThreads: [],
            userGuidance: [],
            resolved: false
          };
          lifeThreads.push(newThread);
          console.log(`  🧵 Created thread: "${newThread.title}"`);
        }
      }
    }

    console.log('✨ [CRS] Post-processing refinements applied');

    return { entities, facts, lifeThreads, patterns, narratives };
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
   * Detect and resolve contradictions between new and existing facts
   * Returns facts with supersession relationships applied
   */
  async resolveFactContradictions(newFacts, existingFacts) {
    if (!anthropicApiKey || newFacts.length === 0) {
      return { resolvedNew: newFacts, updatedExisting: existingFacts };
    }

    // Group existing facts by entity for efficient lookup
    const existingByEntity = {};
    for (const fact of existingFacts) {
      if (!existingByEntity[fact.entityId]) {
        existingByEntity[fact.entityId] = [];
      }
      existingByEntity[fact.entityId].push(fact);
    }

    const resolvedNew = [];
    const factsToSupersede = []; // { oldFactId, newFactId, reason }

    for (const newFact of newFacts) {
      const relevantExisting = existingByEntity[newFact.entityId] || [];

      if (relevantExisting.length === 0) {
        resolvedNew.push(newFact);
        continue;
      }

      // Check for contradictions with LLM
      const contradictions = await this.findContradictions(newFact, relevantExisting);

      if (contradictions.length > 0) {
        // Mark new fact as superseding the old ones
        newFact.supersedes = contradictions.map(c => c.oldFactId);

        for (const c of contradictions) {
          factsToSupersede.push({
            oldFactId: c.oldFactId,
            newFactId: newFact.id,
            reason: c.reason
          });
          console.log(`🔄 [SUPERSEDE] "${c.oldContent}" → "${newFact.content}" (${c.reason})`);
        }
      }

      resolvedNew.push(newFact);
    }

    // Update existing facts that were superseded
    const updatedExisting = existingFacts.map(fact => {
      const supersession = factsToSupersede.find(s => s.oldFactId === fact.id);
      if (supersession) {
        return {
          ...fact,
          isActive: false,
          temporality: 'past',
          supersededBy: supersession.newFactId,
          supersededAt: Date.now(),
          supersessionReason: supersession.reason,
          updatedAt: Date.now()
        };
      }
      return fact;
    });

    return { resolvedNew, updatedExisting };
  }

  /**
   * Use LLM to find which existing facts are contradicted by a new fact
   */
  async findContradictions(newFact, existingFacts) {
    // Only check facts that could plausibly contradict
    const candidateFacts = existingFacts.filter(f =>
      f.isActive !== false &&
      f.category === newFact.category
    );

    if (candidateFacts.length === 0) return [];

    const systemPrompt = `You detect CONTRADICTIONS between facts about the same entity.

A contradiction occurs when:
- A new fact directly conflicts with an old fact (age changed, moved cities, changed jobs)
- A new fact makes an old fact no longer true (was single → now married)
- A new fact updates a quantity or status (was 30 → now 31)

NOT contradictions:
- Additional information (likes coffee AND likes tea)
- Different aspects of same topic (works at Google + works in engineering)
- Refinements that don't invalidate (lives in California + lives in San Francisco)

Return JSON: { "contradictions": [...] }`;

    const userPrompt = `NEW FACT: "${newFact.content}"
Category: ${newFact.category}

EXISTING FACTS (check each for contradiction):
${candidateFacts.map((f, i) => `${i}. [${f.id}] "${f.content}"`).join('\n')}

For each contradiction found, return:
{
  "index": number,
  "reason": "brief explanation (e.g., 'age updated', 'location changed', 'status changed')"
}

Return empty array if no contradictions.`;

    try {
      const result = await callClaude(systemPrompt, userPrompt, 0.1);

      return (result.contradictions || []).map(c => ({
        oldFactId: candidateFacts[c.index]?.id,
        oldContent: candidateFacts[c.index]?.content,
        reason: c.reason
      })).filter(c => c.oldFactId); // Filter out invalid indices

    } catch (error) {
      console.warn('⚠️ [CRS] Contradiction detection failed:', error.message);
      return [];
    }
  }

  /**
   * Detect entity updates (role changes, location changes, etc.)
   */
  async resolveEntityUpdates(newEntities, existingEntities) {
    if (!anthropicApiKey) {
      return { resolved: newEntities, updated: existingEntities };
    }

    const updated = [...existingEntities];

    for (const newEntity of newEntities) {
      const existing = updated.find(e =>
        e.name.toLowerCase() === newEntity.name.toLowerCase() ||
        e.aliases?.some(a => a.toLowerCase() === newEntity.name.toLowerCase())
      );

      if (existing && newEntity.description && existing.description) {
        // Check if description represents an update
        const isUpdate = await this.isEntityUpdate(existing.description, newEntity.description);

        if (isUpdate.updated) {
          console.log(`🔄 [ENTITY UPDATE] ${existing.name}: "${existing.description}" → "${newEntity.description}" (${isUpdate.reason})`);

          // Archive old description
          existing.previousDescriptions = existing.previousDescriptions || [];
          existing.previousDescriptions.push({
            description: existing.description,
            archivedAt: Date.now(),
            reason: isUpdate.reason
          });

          // Update to new
          existing.description = newEntity.description;
          existing.updatedAt = Date.now();
        }
      }
    }

    return { resolved: newEntities, updated };
  }

  async isEntityUpdate(oldDesc, newDesc) {
    const systemPrompt = `Determine if a new entity description represents an UPDATE to old information, or just ADDITIONAL information.

UPDATE = old info is no longer true (moved cities, changed jobs, changed relationship status)
ADDITIONAL = both can be true simultaneously (learned new skill, added hobby)

Return JSON: { "updated": boolean, "reason": "brief explanation" }`;

    try {
      const result = await callClaude(systemPrompt,
        `OLD: "${oldDesc}"\nNEW: "${newDesc}"`, 0.1);
      return result;
    } catch {
      return { updated: false, reason: 'detection failed' };
    }
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
   * Calculate text similarity (word overlap ratio)
   */
  calculateTextSimilarity(text1, text2) {
    const words1 = new Set(text1.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    const words2 = new Set(text2.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    const overlap = [...words1].filter(w => words2.has(w)).length;
    return overlap / Math.max(words1.size, words2.size);
  }

  /**
   * Parse relative date strings into ISO dates
   * "in 5 days", "next Tuesday", "tomorrow", etc.
   */
  parseRelativeDate(dateStr) {
    if (!dateStr) return null;

    const now = new Date();
    const lowerDate = dateStr.toLowerCase().trim();

    // Already ISO format
    if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
      return dateStr;
    }

    // "tomorrow"
    if (lowerDate === 'tomorrow') {
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      return tomorrow.toISOString().split('T')[0];
    }

    // "in X days"
    const inDaysMatch = lowerDate.match(/in (\d+) days?/);
    if (inDaysMatch) {
      const days = parseInt(inDaysMatch[1]);
      const future = new Date(now);
      future.setDate(future.getDate() + days);
      return future.toISOString().split('T')[0];
    }

    // "next week"
    if (lowerDate === 'next week') {
      const nextWeek = new Date(now);
      nextWeek.setDate(nextWeek.getDate() + 7);
      return nextWeek.toISOString().split('T')[0];
    }

    // "next [day]" (e.g., "next Tuesday")
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const nextDayMatch = lowerDate.match(/next (\w+)/);
    if (nextDayMatch) {
      const targetDay = days.indexOf(nextDayMatch[1].toLowerCase());
      if (targetDay !== -1) {
        const currentDay = now.getDay();
        let daysUntil = targetDay - currentDay;
        if (daysUntil <= 0) daysUntil += 7;
        const future = new Date(now);
        future.setDate(future.getDate() + daysUntil);
        return future.toISOString().split('T')[0];
      }
    }

    // "[day]" without "next" (e.g., "Tuesday" means this coming Tuesday)
    for (let i = 0; i < days.length; i++) {
      if (lowerDate === days[i]) {
        const currentDay = now.getDay();
        let daysUntil = i - currentDay;
        if (daysUntil <= 0) daysUntil += 7;
        const future = new Date(now);
        future.setDate(future.getDate() + daysUntil);
        return future.toISOString().split('T')[0];
      }
    }

    // "Dec 8", "December 8", etc.
    const monthDayMatch = lowerDate.match(/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w* (\d{1,2})/i);
    if (monthDayMatch) {
      const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
      const month = months.indexOf(monthDayMatch[1].toLowerCase().substring(0, 3));
      const day = parseInt(monthDayMatch[2]);
      if (month !== -1) {
        const future = new Date(now.getFullYear(), month, day);
        // If date is in the past, assume next year
        if (future < now) {
          future.setFullYear(future.getFullYear() + 1);
        }
        return future.toISOString().split('T')[0];
      }
    }

    // Couldn't parse, return original
    return dateStr;
  }

  /**
   * Detect milestone signals using LLM semantic understanding
   */
  async detectMilestones(journalText, entities, lifeThreads) {
    if (!anthropicApiKey) {
      console.log('⚠️ [CRS] No Anthropic key - skipping milestone detection');
      return [];
    }

    const entityList = entities
      .filter(e => e.id !== 'self')
      .map(e => `${e.name} (${e.category})`)
      .join(', ');

    const threadList = (lifeThreads || [])
      .filter(t => t.status === 'active')
      .map(t => `- "${t.title}" (${t.category}, next: ${t.nextMilestone || 'none'})`)
      .join('\n');

    const systemPrompt = `You are detecting EMOTIONAL MILESTONES in personal journal entries.

A milestone is an upcoming event/moment that carries significant emotional weight for the person.

SIGNALS TO LOOK FOR:
- Countdown language ("5 more days", "T-minus", "can't wait", "finally")
- Dramatic punctuation or formatting ("5. More. Days.", "!!!", ALL CAPS)
- Anticipation/anxiety about a specific date or event
- Repeated mentions of the same upcoming event
- Absolute language ("everything changes", "this is it", "finally")
- Nervous/excited energy about something approaching

WHAT TO EXTRACT:
- What is the milestone event?
- Who is it associated with (if anyone)?
- How many days until it (if mentioned)?
- Emotional intensity (1-10 scale)
- Key quote/signal from the text

Return JSON: { "milestones": [...] }
Return empty array if no significant milestones detected.`;

    const userPrompt = `Analyze this journal for emotional milestones:

JOURNAL TEXT:
${journalText}

KNOWN ENTITIES: ${entityList || 'none'}

ACTIVE LIFE THREADS:
${threadList || 'none'}

For each milestone found, return:
{
  "event": "What the milestone is",
  "entityName": "Associated person/entity or null",
  "daysUntil": number or null,
  "intensity": 1-10,
  "signal": "The key text that signals this",
  "existingThreadTitle": "If matches an existing life thread, its title, else null"
}`;

    try {
      const result = await callClaude(systemPrompt, userPrompt, 0.2);
      const milestones = result.milestones || [];

      // Enrich with entity/thread IDs
      return milestones.map(m => {
        const entity = entities.find(e =>
          e.name.toLowerCase() === (m.entityName || '').toLowerCase()
        );

        const thread = (lifeThreads || []).find(t =>
          t.title.toLowerCase() === (m.existingThreadTitle || '').toLowerCase() ||
          (m.event && t.title.toLowerCase().includes(m.event.toLowerCase().substring(0, 20)))
        );

        return {
          type: 'milestone',
          event: m.event,
          signal: m.signal,
          daysUntil: m.daysUntil,
          intensity: m.intensity || 5,
          entityId: entity?.id || null,
          entityName: entity?.name || m.entityName,
          threadId: thread?.id || null,
          threadTitle: thread?.title || null
        };
      });

    } catch (error) {
      console.error('❌ [CRS] Milestone detection failed:', error.message);
      return [];
    }
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
- Organizations or teams (Our team, Anthropic, Department)
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
      const result = await callClaude(systemPrompt, userPrompt);
      const newEntities = (result.entities || [])
        // Filter out blacklisted entities
        .filter(e => {
          const nameLower = e.name.toLowerCase();
          if (ENTITY_BLACKLIST.some(b => nameLower.includes(b))) {
            console.log(`🚫 [CRS] Skipping blacklisted entity: ${e.name}`);
            return false;
          }
          return true;
        })
        .map(e => ({
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

      // Detect entity updates (role/location changes) before merging
      const { resolved: resolvedNewEntities, updated: updatedAllEntities } =
        await this.resolveEntityUpdates(newEntities, allEntities);

      // Merge new entities (avoid duplicates) and build Self's relationship graph
      for (const newEntity of resolvedNewEntities) {
        // Check for duplicates by name OR aliases
        const existingIndex = updatedAllEntities.findIndex(e => {
          // Direct name match
          if (e.name.toLowerCase() === newEntity.name.toLowerCase()) return true;
          // New entity name matches existing alias
          if (e.aliases?.some(a => a.toLowerCase() === newEntity.name.toLowerCase())) return true;
          // Existing name matches new entity alias
          if (newEntity.aliases?.some(a => a.toLowerCase() === e.name.toLowerCase())) return true;
          return false;
        });
        if (existingIndex === -1) {
          updatedAllEntities.push(newEntity);

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
          updatedAllEntities[existingIndex].lastMentionedAt = Date.now();
          updatedAllEntities[existingIndex].mentionCount = (updatedAllEntities[existingIndex].mentionCount || 0) + 1;
          updatedAllEntities[existingIndex].updatedAt = Date.now();
          // Update salience if new one is higher
          if (newEntity.salience > (updatedAllEntities[existingIndex].salience || 0)) {
            updatedAllEntities[existingIndex].salience = newEntity.salience;
          }
        }
      }

      console.log(`👥 [CRS] Extracted ${newEntities.length} new entities, total: ${updatedAllEntities.length}`);
      return updatedAllEntities;

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

SELF IDENTITY FACTS:
When extracting facts about Self, use these specific formats for key biographical info:
- Name: "User's name is [Name]"
- Profession: "User works as [profession]" or "User is a [profession]"
- Location: "User lives in [location]"
- Age: "User is [age] years old"

This helps the system build a structured identity profile.

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
      const result = await callClaude(systemPrompt, userPrompt);
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

      // Merge with existing (deduplication by content)
      const existingContents = new Set(existingFacts.map(f => f.content.toLowerCase()));
      const uniqueNewFacts = newFacts.filter(f => !existingContents.has(f.content.toLowerCase()));

      // Detect and resolve contradictions
      const { resolvedNew, updatedExisting } = await this.resolveFactContradictions(
        uniqueNewFacts,
        existingFacts
      );

      const allFacts = [...updatedExisting, ...resolvedNew];

      console.log(`📝 [CRS] Extracted ${uniqueNewFacts.length} new facts, total: ${allFacts.length}`);
      return allFacts;

    } catch (error) {
      console.error('❌ [CRS] Fact extraction failed:', error.message);
      return existingFacts;
    }
  }

  // ============================================================================
  // LIFE THREADS PROCESSING (PRIMARY TRACKING SYSTEM)
  // ============================================================================

  /**
   * Process journals into Life Threads - the primary tracking system for ongoing situations.
   * Life threads are richer than open loops and directly feed into Horizon's context.
   * 
   * Life threads represent ongoing situations in the user's life:
   * - Relationship dynamics (dating, family situations, friendships)
   * - Career developments (job searches, projects, work situations)
   * - Health journeys (fitness goals, medical situations, mental health)
   * - Financial matters (purchases, investments, budgeting)
   * - Creative projects (writing, art, music)
   * - Logistical planning (travel, moving, events)
   * - Goals being actively pursued
   */
  async processLifeThreads(journalText, entities, facts, existingThreads) {
    console.log('🧵 [CRS] Processing life threads...');

    const entityList = entities.map(e => `${e.name} (${e.category})`).join(', ');

    // Format existing threads for update consideration
    const activeThreads = existingThreads.filter(t => !t.resolved);
    const resolvedThreads = existingThreads.filter(t => t.resolved);

    const existingThreadsFormatted = activeThreads.map(t => ({
      id: t.id,
      title: t.title,
      category: t.category,
      status: t.status,
      currentContext: t.currentContext,
      emotionalWeight: t.emotionalWeight,
      nextMilestone: t.nextMilestone,
      relatedEntities: t.relatedEntities || [],
      userGuidance: t.userGuidance || []
    }));

    const systemPrompt = `You are a cognitive memory system managing LIFE THREADS from personal journals.

A LIFE THREAD is an ongoing situation in the user's life that they're actively navigating:
- NOT a task or to-do item
- NOT a one-time event
- It's something with EMOTIONAL WEIGHT and CONTEXT that spans days/weeks/months

CATEGORIES:
- career: Jobs, auditions, projects, work situations
- relationship: Dating, family dynamics, friendships, social situations
- health: Fitness goals, medical, mental health journeys
- financial: Money decisions, purchases, investments
- creative: Art projects, writing, music, creative pursuits
- logistical: Travel planning, moving, event organizing
- waiting: Waiting to hear back on something important
- goal: Active goals being pursued

YOUR PRIMARY JOB: Update existing threads with new developments.
SECONDARY JOB: Create new threads only for genuine ongoing situations.
TERTIARY JOB: Resolve threads when situations conclude.

═══════════════════════════════════════════════════════════
WHAT MAKES A GOOD LIFE THREAD:
═══════════════════════════════════════════════════════════

✅ CREATE THREAD FOR:
- Dating situations (meeting someone, navigating a relationship)
- Job searches or career transitions
- Health goals they're actively working on
- Family situations with ongoing dynamics
- Projects they're invested in emotionally
- Waiting on important decisions or news

❌ DO NOT CREATE THREAD FOR:
- One-time events ("Had dinner with mom")
- Tasks or errands ("Need to buy groceries")
- General observations ("Feeling tired lately")
- Completed events ("Finished the book")

═══════════════════════════════════════════════════════════
THREAD UPDATES:
═══════════════════════════════════════════════════════════

When updating, capture:
- Status changes ("went from hopeful to uncertain")
- New developments ("had the conversation")
- Emotional shifts ("feeling more confident about it")
- Next milestones ("meeting their parents Saturday")
- User guidance ("don't want me to overthink this")

Return JSON: { "updates": [...], "new": [...], "resolve": [...] }`;

    const userPrompt = `Review journals and manage life threads.

EXISTING THREADS TO POTENTIALLY UPDATE:
${existingThreadsFormatted.length > 0 ? JSON.stringify(existingThreadsFormatted, null, 2) : 'None yet'}

KEY ENTITIES: ${entityList || 'None extracted'}

RECENT FACTS:
${facts.slice(-20).map(f => `- ${f.content}`).join('\n')}

JOURNALS:
${journalText}

═══════════════════════════════════════════════════════════

For each UPDATE:
{
  "id": "existing thread id",
  "statusUpdate": "new status (or null if unchanged)",
  "contextUpdate": "what's new in the situation",
  "emotionalWeightUpdate": 1-10 (or null if unchanged),
  "nextMilestoneUpdate": { "date": unix_timestamp, "description": "..." } or null,
  "addGuidance": "new behavioral guidance" or null
}

For each NEW thread:
{
  "title": "Clear, specific title",
  "category": "career|relationship|health|financial|creative|logistical|waiting|goal",
  "status": "Current status in 5-10 words",
  "currentContext": "2-3 sentences of context",
  "emotionalWeight": 1-10,
  "nextMilestone": { "date": unix_timestamp, "description": "..." } or null,
  "relatedEntities": ["entity names"],
  "justification": "Why this is an ongoing situation worth tracking"
}

For each RESOLVE:
{
  "id": "thread id",
  "resolution": "How it concluded (1-2 sentences)"
}`;

    try {
      const result = await callClaude(systemPrompt, userPrompt, 0.3);

      // Process updates to existing threads
      let updatedThreads = activeThreads.map(existing => {
        const update = (result.updates || []).find(u => u.id === existing.id);

        if (!update) return existing;

        console.log(`🧵 [CRS] Updating thread "${existing.title}": ${update.contextUpdate || 'minor update'}`);

        // Add update to history
        const updates = existing.updates || [];
        updates.push({
          timestamp: Date.now(),
          content: update.contextUpdate || update.statusUpdate || 'Updated',
          source: 'crs'
        });

        return {
          ...existing,
          status: update.statusUpdate || existing.status,
          currentContext: update.contextUpdate || existing.currentContext,
          emotionalWeight: update.emotionalWeightUpdate ?? existing.emotionalWeight,
          nextMilestone: update.nextMilestoneUpdate !== undefined 
            ? update.nextMilestoneUpdate 
            : existing.nextMilestone,
          userGuidance: update.addGuidance 
            ? [...(existing.userGuidance || []), update.addGuidance]
            : existing.userGuidance,
          updates: updates.slice(-20), // Keep last 20 updates
          lastUpdate: Date.now(),
          updatedAt: Date.now()
        };
      });

      // Process resolutions
      updatedThreads = updatedThreads.map(thread => {
        const resolution = (result.resolve || []).find(r => r.id === thread.id);
        if (resolution) {
          console.log(`✅ [CRS] Resolving thread "${thread.title}": ${resolution.resolution}`);
          return {
            ...thread,
            resolved: true,
            resolution: resolution.resolution,
            resolvedAt: Date.now()
          };
        }
        return thread;
      });

      // Process new threads
      const newThreads = (result.new || []).map(t => {
        if (!t.justification) {
          console.log(`⚠️ [CRS] Skipping thread "${t.title}" - no justification`);
          return null;
        }

        console.log(`🧵 [CRS] Creating thread "${t.title}": ${t.justification}`);

        // Find related entity IDs
        const relatedEntityIds = (t.relatedEntities || [])
          .map(name => {
            const entity = entities.find(e => 
              e.name.toLowerCase() === name.toLowerCase()
            );
            return entity?.id;
          })
          .filter(Boolean);

        return {
          id: `thread_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          title: t.title,
          category: t.category || 'other',
          status: t.status || '',
          currentContext: t.currentContext || '',
          emotionalWeight: t.emotionalWeight || 5,
          lastUpdate: Date.now(),
          createdAt: Date.now(),
          updates: [{
            timestamp: Date.now(),
            content: t.currentContext || 'Thread created',
            source: 'crs'
          }],
          nextMilestone: t.nextMilestone || null,
          pastMilestones: [],
          relatedEntities: relatedEntityIds,
          relatedThreads: [],
          userGuidance: [],
          resolved: false
        };
      }).filter(Boolean);

      // Combine all
      const nowResolved = updatedThreads.filter(t => t.resolved);
      const stillActive = updatedThreads.filter(t => !t.resolved);
      const allThreads = [...stillActive, ...newThreads, ...nowResolved, ...resolvedThreads];

      const updateCount = (result.updates || []).length;
      const resolveCount = (result.resolve || []).length;
      const newCount = newThreads.length;
      console.log(`🧵 [CRS] Threads: ${updateCount} updated, ${resolveCount} resolved, ${newCount} new, ${allThreads.length} total`);

      return allThreads;

    } catch (error) {
      console.error('❌ [CRS] Life thread processing failed:', error.message);
      return existingThreads;
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
      const result = await callClaude(systemPrompt, userPrompt, 0.3);
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
    console.log('📖 [CRS] Processing narratives (update-first)...');

    const peopleEntities = entities.filter(e => e.category === 'people' && e.id !== 'self');
    const projectEntities = entities.filter(e => e.category === 'projects');
    const entityNames = [...peopleEntities, ...projectEntities].map(e => e.name).join(', ');
    const factSummary = facts.slice(-10).map(f => f.content).join('; ');

    // Format existing narratives for the prompt
    const existingNarrativesFormatted = existingNarratives.map(n => ({
      id: n.id,
      topic: n.topic,
      type: n.type,
      summary: n.summary,
      trajectory: n.trajectory,
      currentChallenge: n.currentChallenge,
      characters: n.characterIds?.map(cId => entities.find(e => e.id === cId)?.name).filter(Boolean) || []
    }));

    const systemPrompt = `You are a cognitive memory system maintaining LONG-TERM NARRATIVE ARCS from personal journals.

YOUR PRIMARY JOB IS TO UPDATE EXISTING NARRATIVES.
Creating new narratives is rare and requires strong justification.

A NARRATIVE is a multi-month or multi-year story arc:
- Relationship arcs (how a relationship evolves over time)
- Career/life project arcs (sustained endeavors)
- Personal growth arcs (ongoing self-development)
- Challenge arcs (difficulties being worked through over time)

WHEN UPDATING AN EXISTING NARRATIVE:
- Look for new developments, shifts, or progress
- Update the trajectory if direction has changed (improving/declining/stable/uncertain)
- Update the summary to reflect current state
- Update currentChallenge if it has shifted
- Add to the developments log

WHEN TO CREATE A NEW NARRATIVE (RARE):
- A genuinely new multi-month arc has emerged
- It doesn't fit into any existing narrative
- It passes the "6-month test" — user will still care in 6 months
- Maximum 1 new narrative per processing run

DO NOT CREATE NARRATIVES FOR:
- Tasks, errands, one-off events
- Things completable in days/weeks
- Single conversations or decisions
- Facts or observations

Return JSON: { "updates": [...], "new": [...] }`;

    const userPrompt = `Review these journals and update existing narratives OR (rarely) create new ones.

EXISTING NARRATIVES TO POTENTIALLY UPDATE:
${existingNarrativesFormatted.length > 0
        ? JSON.stringify(existingNarrativesFormatted, null, 2)
        : 'None yet'}

KEY ENTITIES: ${entityNames || 'Self only'}
RECENT FACTS: ${factSummary || 'none'}

JOURNALS:
${journalText}

For each UPDATE return:
{
  "id": "existing narrative id",
  "development": "What's new (1 sentence)",
  "summaryUpdate": "New summary if changed, or null",
  "trajectoryUpdate": "improving|declining|stable|uncertain, or null if unchanged",
  "challengeUpdate": "New challenge, or null if unchanged"
}

For each NEW narrative (rare, max 1) return:
{
  "topic": "Clear topic name",
  "type": "relationship|project|growth",
  "summary": "1-2 sentences",
  "trajectory": "improving|declining|stable|uncertain",
  "characters": ["entity names"],
  "currentChallenge": "Main challenge or null",
  "justification": "Why this deserves to be a narrative (must reference multi-month scope)"
}`;

    try {
      const result = await callClaude(systemPrompt, userPrompt, 0.4);

      // Process updates to existing narratives
      const updatedNarratives = existingNarratives.map(existing => {
        const update = (result.updates || []).find(u => u.id === existing.id);

        if (!update) return existing;

        console.log(`📖 [CRS] Updating narrative "${existing.topic}": ${update.development}`);

        // Add development to history
        const developments = existing.developments || [];
        developments.push({
          date: new Date().toISOString().split('T')[0],
          note: update.development
        });

        return {
          ...existing,
          summary: update.summaryUpdate || existing.summary,
          trajectory: update.trajectoryUpdate || existing.trajectory,
          currentChallenge: update.challengeUpdate !== undefined ? update.challengeUpdate : existing.currentChallenge,
          developments: developments.slice(-20), // Keep last 20 developments
          updatedAt: Date.now()
        };
      });

      // Process new narratives (should be rare)
      const newNarratives = (result.new || []).map(n => {
        console.log(`📖 [CRS] Creating NEW narrative "${n.topic}" — Justification: ${n.justification}`);

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
          developments: [{
            date: new Date().toISOString().split('T')[0],
            note: 'Narrative created'
          }],
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
      });

      const allNarratives = [...updatedNarratives, ...newNarratives];

      const updateCount = (result.updates || []).length;
      const newCount = newNarratives.length;
      console.log(`📖 [CRS] Narratives: ${updateCount} updated, ${newCount} new, ${allNarratives.length} total`);

      return allNarratives;

    } catch (error) {
      console.error('❌ [CRS] Narrative processing failed:', error.message);
      return existingNarratives;
    }
  }

  // ============================================================================
  // EXPORT TO FILESYSTEM
  // ============================================================================

  async exportCRSOutputsToSystemFS(crsOutputs) {
    console.log('📤 [CRS] Exporting to /system file structure...');

    const { entities, facts, lifeThreads, patterns, narratives } = crsOutputs;

    // Export entities by category
    const usedEntitySlugs = new Set();
    for (const entity of entities) {
      const category = entity.category || 'concepts';
      let slug = slugify(entity.name);

      if (usedEntitySlugs.has(`${category}/${slug}`)) {
        slug = `${slug}_${entity.id.slice(-6)}`;
      }
      usedEntitySlugs.add(`${category}/${slug}`);

      const path = `system/entities/${category}/${slug}.json`;
      await this.writeFile(path, entity);
    }

    // Export facts by entity
    const usedFactSlugs = new Map(); // per-entity tracking
    for (const fact of facts) {
      const entityId = fact.entityId || 'self';

      // Create a slug from fact content (first few meaningful words)
      const factWords = fact.content
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 2)
        .slice(0, 5)
        .join('_');

      let slug = factWords || 'fact';

      // Track per-entity to allow same slug under different entities
      const entitySlugs = usedFactSlugs.get(entityId) || new Set();
      if (entitySlugs.has(slug)) {
        slug = `${slug}_${fact.id.slice(-6)}`;
      }
      entitySlugs.add(slug);
      usedFactSlugs.set(entityId, entitySlugs);

      const path = `system/facts/${entityId}/${slug}.json`;
      await this.writeFile(path, fact);
    }

    // Export LIFE THREADS (the tracking system for ongoing situations)
    const usedThreadSlugs = new Set();
    for (const thread of (lifeThreads || [])) {
      const dir = thread.resolved ? 'resolved/' : '';
      let slug = slugify(thread.title);

      if (usedThreadSlugs.has(slug)) {
        slug = `${slug}_${thread.id.slice(-6)}`;
      }
      usedThreadSlugs.add(slug);

      const path = `system/life_threads/${dir}${slug}.json`;
      await this.writeFile(path, thread);
    }

    // Export patterns
    const usedPatternSlugs = new Set();
    for (const pattern of patterns) {
      // Create slug from claim
      const claimWords = pattern.claim
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 2)
        .slice(0, 5)
        .join('_');

      let slug = claimWords || 'pattern';

      if (usedPatternSlugs.has(slug)) {
        slug = `${slug}_${pattern.id.slice(-6)}`;
      }
      usedPatternSlugs.add(slug);

      const path = `system/patterns/${slug}.json`;
      await this.writeFile(path, pattern);
    }

    // Export narratives
    const usedNarrativeSlugs = new Set();
    for (const narrative of narratives) {
      let slug = slugify(narrative.topic);

      if (usedNarrativeSlugs.has(slug)) {
        slug = `${slug}_${narrative.id.slice(-6)}`;
      }
      usedNarrativeSlugs.add(slug);

      const path = `system/narratives/${slug}.json`;
      await this.writeFile(path, narrative);
    }

    console.log(`✅ [CRS] Exported ${entities.length} entities, ${facts.length} facts, ${(lifeThreads || []).length} life threads, ${patterns.length} patterns, ${narratives.length} narratives`);
  }

  /**
   * Generate update manifest for RTCS sync
   */
  async generateUpdateManifest(crsOutputs) {
    const { entities, facts, lifeThreads, patterns, narratives } = crsOutputs;

    const manifest = {
      timestamp: Date.now(),
      processedAt: new Date().toISOString(),
      updatedEntities: entities.map(e => e.id),
      updatedFacts: facts.map(f => f.id),
      updatedLifeThreads: (lifeThreads || []).map(t => t.id),
      updatedPatterns: patterns.map(p => p.id),
      updatedNarratives: narratives.map(n => n.id),
      totalEntities: entities.length,
      totalFacts: facts.length,
      totalLifeThreads: (lifeThreads || []).length,
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
  // SUGGESTED QUESTIONS GENERATION
  // ============================================================================

  async generateSuggestedQuestions(crsOutputs) {
    console.log('💡 [CRS] Generating suggested questions (journal-anchored)...');

    if (!anthropicApiKey) {
      console.warn('⚠️ [CRS] No Anthropic key - using fallback questions');
      return this.getFallbackQuestions();
    }

    const { entities, facts, lifeThreads, patterns, narratives } = crsOutputs;

    // Load RECENT journal entries (last 3 days) - this is the key differentiator
    const recentJournals = await this.loadRecentJournalText(3);

    // Get today's date info
    const today = new Date();
    const dayOfWeek = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][today.getDay()];
    const dateStr = today.toISOString().split('T')[0];

    // Only include high-weight active life threads
    const urgentThreads = (lifeThreads || []).filter(t => {
      if (t.resolved) return false;
      if (t.emotionalWeight >= 7) return true;
      if (t.nextMilestone && t.nextMilestone.date) {
        const daysUntil = (t.nextMilestone.date - today.getTime()) / (24 * 60 * 60 * 1000);
        return daysUntil <= 7 && daysUntil >= 0;
      }
      return false;
    }).slice(0, 3);

    // Get milestone entities only
    const milestoneEntities = entities.filter(e => e.hasMilestone || e.isMilestone).slice(0, 2);

    const systemPrompt = `You generate SHORT questions a user would ask their personal AI assistant.

CRITICAL RULES:
1. Questions must be FROM the user TO their AI
2. 5-12 words MAX
3. Questions must be ANCHORED to the recent journal content provided
4. DO NOT ask generic questions - every question should reference something SPECIFIC from the last few days

THE RECENT JOURNALS ARE YOUR PRIMARY SOURCE.
Look for:
- Specific people mentioned and what happened with them
- Emotions expressed and their triggers
- Decisions being mulled over
- Events that just happened or are about to happen
- Anxieties, excitements, or unresolved feelings

QUESTION FORMULA:
[Specific detail from journal] + [what the AI could help with]

GOOD (anchored to journal content):
- "What do you think about what Sarah said?" (if Sarah said something specific)
- "Should I be worried about that work thing?"
- "Did I make the right call yesterday?"
- "What's your read on how the dinner went?"
- "Am I overthinking the Stella situation?"

BAD (generic, could be asked any day):
- "What's happening with Stella?"
- "How are my relationships going?"
- "Any patterns lately?"
- "What should I focus on?"

Today is ${dayOfWeek}, ${dateStr}.

Return JSON: { "questions": [...] }`;

    const userPrompt = `Generate 5 questions based on what's ACTUALLY in the recent journals.

═══════════════════════════════════════════════════════════
RECENT JOURNAL ENTRIES (PRIMARY SOURCE - anchor questions here):
═══════════════════════════════════════════════════════════
${recentJournals || 'No recent entries found.'}

═══════════════════════════════════════════════════════════
ACTIVE LIFE THREADS (secondary context):
═══════════════════════════════════════════════════════════
${urgentThreads.length > 0
        ? urgentThreads.map(t => `- ${t.title} (${t.category}, weight: ${t.emotionalWeight})`).join('\n')
        : 'No urgent threads'}

${milestoneEntities.length > 0
        ? `UPCOMING MILESTONES:\n${milestoneEntities.map(e => `- ${e.name}: ${e.milestoneDate || 'soon'}`).join('\n')}`
        : ''}

═══════════════════════════════════════════════════════════

Generate 5 questions. Each MUST reference something specific from the journal entries.

For each:
{
  "id": "unique_id",
  "text": "Short question (5-12 words) referencing specific journal content",
  "anchor": "The specific thing from the journal this references (1 sentence)",
  "category": "relationship|decision|emotion|event|progress",
  "priority": 0.0-1.0
}

DISTRIBUTION:
- 2-3 questions about specific people/interactions from journals
- 1-2 questions about decisions or emotions expressed
- 0-1 question about an urgent deadline (if any)

If journals are empty, generate questions about what's urgent/imminent instead.`;

    try {
      const result = await callClaude(systemPrompt, userPrompt, 0.9); // High temp for variety
      const questions = (result.questions || []).map(q => ({
        id: q.id || generateId('q'),
        text: q.text,
        anchor: q.anchor, // Store what it's anchored to for debugging
        category: q.category || 'emotion',
        priority: q.priority || 0.5,
        generatedAt: Date.now(),
        generatedFor: dateStr
      }));

      console.log(`💡 [CRS] Generated ${questions.length} journal-anchored questions`);
      questions.forEach(q => console.log(`  → "${q.text}" (anchored to: ${q.anchor})`));

      return questions;

    } catch (error) {
      console.error('❌ [CRS] Question generation failed:', error.message);
      return this.getFallbackQuestions();
    }
  }

  /**
   * Load recent journal text for question generation
   * @param days - Number of days to look back
   */
  async loadRecentJournalText(days = 3) {
    try {
      const journals = await this.readFile('journals.json') || {};
      const today = new Date();
      const entries = [];

      for (let i = 0; i < days; i++) {
        const date = new Date(today);
        date.setDate(date.getDate() - i);
        const dateStr = date.toISOString().split('T')[0];

        const dayEntries = journals[dateStr] || [];
        for (const entry of dayEntries) {
          const content = entry.content || entry.text || '';
          if (content.trim()) {
            entries.push(`[${dateStr}] ${content}`);
          }
        }
      }

      if (entries.length === 0) {
        console.log('⚠️ [CRS] No journal entries in last', days, 'days');
        return null;
      }

      // Limit to ~2000 chars to keep prompt reasonable
      const combined = entries.join('\n\n');
      if (combined.length > 2000) {
        return combined.substring(0, 2000) + '...';
      }

      return combined;
    } catch (error) {
      console.error('❌ [CRS] Failed to load recent journals:', error.message);
      return null;
    }
  }

  getFallbackQuestions() {
    const dateStr = new Date().toISOString().split('T')[0];
    return [
      {
        id: 'fallback_1',
        text: "What's my biggest priority today?",
        category: 'practical',
        priority: 0.7,
        generatedAt: Date.now(),
        generatedFor: dateStr
      },
      {
        id: 'fallback_2',
        text: "Any patterns you've noticed lately?",
        category: 'insight',
        priority: 0.5,
        generatedAt: Date.now(),
        generatedFor: dateStr
      },
      {
        id: 'fallback_3',
        text: "What's weighing on me right now?",
        category: 'emotional',
        priority: 0.6,
        generatedAt: Date.now(),
        generatedFor: dateStr
      },
      {
        id: 'fallback_4',
        text: "How am I doing on my goals?",
        category: 'progress',
        priority: 0.5,
        generatedAt: Date.now(),
        generatedFor: dateStr
      },
      {
        id: 'fallback_5',
        text: "Anything important coming up?",
        category: 'practical',
        priority: 0.6,
        generatedAt: Date.now(),
        generatedFor: dateStr
      }
    ];
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

        // Allow small size differences (JSON formatting, trailing newlines)
        if (Math.abs(writtenContent.length - content.length) > 5) {
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
      console.log(`🗑️ [CRS] Attempting to delete: ${path}`);
      
      const { error, data } = await supabase.storage
        .from('horizon-files')
        .remove([path]);

      if (error) {
        console.error(`❌ [CRS] Supabase delete error for ${path}:`, error);
        throw error;
      }

      console.log(`✅ [CRS] Successfully deleted: ${path}`, data);
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
      const lifeThreads = await this.loadExistingSystemFiles('life_threads');
      const narratives = await this.loadExistingSystemFiles('narratives');
      const patterns = await this.loadExistingSystemFiles('patterns');
      const manifest = await this.readFile('system/updates/latest.json');
      const suggestedQuestionsData = await this.readFile('system/suggested_questions.json');

      // Load Night Owl insights
      const nightOwlInsights = await this.loadNightOwlInsights();

      return {
        // Flat arrays for RTCS sync
        entities,
        facts,
        life_threads: lifeThreads,  // Primary tracking system (replaces open_loops)
        narratives,
        patterns,
        manifest,
        suggestedQuestions: suggestedQuestionsData?.questions || [],
        nightOwlInsights,
        // Grouped versions for other consumers
        entitiesByCategory: this.groupBy(entities, 'category'),
        factsByEntity: this.groupBy(facts, 'entityId'),
      };
    } catch (error) {
      console.error('❌ [CRS] Failed to get system export:', error.message);
      throw error;
    }
  }

  async loadNightOwlInsights() {
    try {
      const files = await this.listFiles('system/nightowl');
      const insights = [];

      for (const file of files) {
        if (file.name.startsWith('insight_') && file.name.endsWith('.json')) {
          const insight = await this.readFile(`system/nightowl/${file.name}`);
          if (insight) {
            insights.push(insight);
          }
        }
      }

      return insights;
    } catch (error) {
      console.warn('⚠️ [CRS] Failed to load Night Owl insights:', error.message);
      return [];
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
