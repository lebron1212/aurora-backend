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
      maxLoopsPerRun: 3,
      minPriority: 2
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

    // Start nightly cron job at 2 AM PST (10 AM UTC)
    // Railway servers run in UTC, so we need to adjust: 2 AM PST = 10 AM UTC
    cron.schedule('0 10 * * *', async () => {
      const pstTime = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
      console.log(`🌙 [CRS] Starting nightly processing at ${pstTime} PST...`);
      await this.runNightlyProcessing();
    });

    // Optional: Add a manual trigger endpoint for testing
    this.setupManualTrigger();

    console.log('✅ [CRS] Service initialized. Nightly processing scheduled for 2 AM PST (10 AM UTC).');
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
          console.log(`🦉 [CRS] Breakdown: loops=${nightOwlResults.breakdown.loops}, prep=${nightOwlResults.breakdown.prep}, patterns=${nightOwlResults.breakdown.patterns}, reminders=${nightOwlResults.breakdown.reminders}, accountability=${nightOwlResults.breakdown.accountability}, connections=${nightOwlResults.breakdown.connections}, health=${nightOwlResults.breakdown.health}, learning=${nightOwlResults.breakdown.learning}, plans=${nightOwlResults.breakdown.plans}`);
        }
      } catch (nightOwlError) {
        console.error('❌ [CRS] Night Owl processing failed:', nightOwlError.message);
        // Don't fail the whole nightly run if Night Owl fails
      }

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
    console.log('🧠 [CRS] Processing cognitive data with Claude...');

    if (!anthropicApiKey) {
      console.warn('⚠️ [CRS] No Anthropic key - returning existing data only');
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
        loops: rawData.existing.loops || [],
        patterns: rawData.existing.patterns || [],
        narratives: rawData.existing.narratives || []
      };
    }

    // Process each type
    let entities = await this.processEntities(journalText, rawData.existing.entities);
    let facts = await this.processFacts(journalText, entities, rawData.existing.facts);
    let loops = await this.processOpenLoops(journalText, entities, rawData.existing.loops);

    // Promote repeated facts to loops
    const promotedLoops = await this.promoteFactsToLoops(facts, entities, loops);
    if (promotedLoops.length > 0) {
      loops = [...loops, ...promotedLoops];
      console.log(`⬆️ [CRS] Added ${promotedLoops.length} promoted loops`);
    }
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

    // 5. Merge similar open loops
    loops = this.mergeOpenLoops(loops);

    // 6. Auto-close stale loops
    loops = this.autoCloseStaleLoops(loops);

    // 7. Detect and prioritize milestones
    const milestones = await this.detectMilestones(journalText, entities, loops);
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

        // Boost loop priority to 1 (highest)
        if (milestone.loopId) {
          const loop = loops.find(l => l.id === milestone.loopId);
          if (loop) {
            loop.priority = 1;
            loop.isMilestone = true;
            loop.milestoneIntensity = milestone.intensity;
            console.log(`  ⬆️ Elevated "${loop.title}" to priority 1 (milestone)`);
          }
        }

        // If no loop exists, create one
        if (!milestone.loopId && milestone.entityId && milestone.daysUntil) {
          const newLoop = {
            id: generateId('loop'),
            title: `Milestone with ${milestone.entityName} in ${milestone.daysUntil} days`,
            loopType: 'milestone',
            priority: 1,
            status: 'open',
            isMilestone: true,
            milestoneIntensity: milestone.intensity,
            relatedEntityIds: [milestone.entityId],
            dueDate: new Date(Date.now() + milestone.daysUntil * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
            createdAt: Date.now(),
            updatedAt: Date.now()
          };
          loops.push(newLoop);
          console.log(`  ✨ Created milestone loop: "${newLoop.title}"`);
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
      }
    }

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
   * Merge similar open loops into single loops with combined context
   * Checks: title similarity, shared entities + close dates
   */
  mergeOpenLoops(loops) {
    const openLoops = loops.filter(l => l.status === 'open');
    const resolvedLoops = loops.filter(l => l.status !== 'open');
    const merged = [];
    const mergedIds = new Set();

    for (const loop of openLoops) {
      if (mergedIds.has(loop.id)) continue;

      // Find similar loops by title OR by entity+date proximity
      const similar = openLoops.filter(other => {
        if (other.id === loop.id || mergedIds.has(other.id)) return false;

        // Check 1: Title similarity (existing logic)
        const titleSimilarity = this.calculateTextSimilarity(loop.title, other.title);
        if (titleSimilarity > 0.5) return true;

        // Check 2: Same entity + dates within 3 days
        if (this.loopsShareEntityAndCloseDate(loop, other)) return true;

        return false;
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

        // Combine titles/descriptions for context
        const allTitles = [loop.title, ...similar.map(s => s.title)];
        const combinedDescription = [
          loop.description || '',
          ...similar.map(s => s.description || ''),
          `(Combined from: ${allTitles.join('; ')})`
        ].filter(Boolean).join('\n');

        console.log(`🔗 [MERGE] Combining ${similar.length + 1} related loops: "${loop.title}" + ${similar.map(s => `"${s.title}"`).join(', ')}`);

        merged.push({
          ...loop,
          relatedEntityIds: allRelatedEntities,
          dueDate: earliestDue,
          description: combinedDescription,
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
   * Check if two loops share an entity AND have due dates within 3 days
   */
  loopsShareEntityAndCloseDate(loop1, loop2) {
    // Must share at least one entity
    const entities1 = loop1.relatedEntityIds || [];
    const entities2 = loop2.relatedEntityIds || [];
    const sharedEntities = entities1.filter(e => entities2.includes(e));

    if (sharedEntities.length === 0) return false;

    // Must both have due dates
    if (!loop1.dueDate || !loop2.dueDate) return false;

    // Dates must be within 3 days
    const date1 = new Date(loop1.dueDate).getTime();
    const date2 = new Date(loop2.dueDate).getTime();
    const daysDiff = Math.abs(date1 - date2) / (24 * 60 * 60 * 1000);

    if (daysDiff <= 3) {
      console.log(`🔍 [MERGE] Found related loops for ${sharedEntities.join(', ')}: "${loop1.title}" and "${loop2.title}" (${daysDiff.toFixed(1)} days apart)`);
      return true;
    }

    return false;
  }

  /**
   * Auto-close stale loops that haven't been mentioned in 14+ days
   * and have no due date or past due date
   */
  autoCloseStaleLoops(loops) {
    const now = Date.now();
    const STALE_THRESHOLD_DAYS = 14;

    return loops.map(loop => {
      if (loop.status !== 'open') return loop;

      const lastActivity = loop.updatedAt || loop.createdAt;
      const daysSinceActivity = (now - lastActivity) / (24 * 60 * 60 * 1000);

      // Check if stale
      if (daysSinceActivity >= STALE_THRESHOLD_DAYS) {
        // Check if has future due date (don't auto-close if deadline coming)
        if (loop.dueDate) {
          const dueDate = new Date(loop.dueDate).getTime();
          if (dueDate > now) {
            // Has future deadline, don't close
            return loop;
          }
        }

        console.log(`🗑️ [STALE] Auto-closing stale loop: "${loop.title}" (${Math.floor(daysSinceActivity)} days inactive)`);
        return {
          ...loop,
          status: 'resolved',
          resolvedAt: now,
          resolutionReason: 'auto_closed_stale',
          updatedAt: now
        };
      }

      return loop;
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
  async detectMilestones(journalText, entities, loops) {
    if (!anthropicApiKey) {
      console.log('⚠️ [CRS] No Anthropic key - skipping milestone detection');
      return [];
    }

    const entityList = entities
      .filter(e => e.id !== 'self')
      .map(e => `${e.name} (${e.category})`)
      .join(', ');

    const loopList = loops
      .filter(l => l.status === 'open')
      .map(l => `- "${l.title}" (due: ${l.dueDate || 'no date'})`)
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

EXISTING OPEN LOOPS:
${loopList || 'none'}

For each milestone found, return:
{
  "event": "What the milestone is",
  "entityName": "Associated person/entity or null",
  "daysUntil": number or null,
  "intensity": 1-10,
  "signal": "The key text that signals this",
  "existingLoopTitle": "If matches an existing loop, its title, else null"
}`;

    try {
      const result = await callClaude(systemPrompt, userPrompt, 0.2);
      const milestones = result.milestones || [];

      // Enrich with entity/loop IDs
      return milestones.map(m => {
        const entity = entities.find(e =>
          e.name.toLowerCase() === (m.entityName || '').toLowerCase()
        );

        const loop = loops.find(l =>
          l.title.toLowerCase() === (m.existingLoopTitle || '').toLowerCase() ||
          (m.event && l.title.toLowerCase().includes(m.event.toLowerCase().substring(0, 20)))
        );

        return {
          type: 'milestone',
          event: m.event,
          signal: m.signal,
          daysUntil: m.daysUntil,
          intensity: m.intensity || 5,
          entityId: entity?.id || null,
          entityName: entity?.name || m.entityName,
          loopId: loop?.id || null,
          loopTitle: loop?.title || null
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
  // OPEN LOOP EXTRACTION
  // ============================================================================

  async processOpenLoops(journalText, entities, facts, existingLoops) {
    console.log('🔄 [CRS] Processing open loops (fact-first, update-existing)...');

    const entityList = entities.map(e => e.name).join(', ');

    // Format existing open loops for update consideration
    const openLoops = existingLoops.filter(l => l.status === 'open');
    const resolvedLoops = existingLoops.filter(l => l.status !== 'open');

    const existingLoopsFormatted = openLoops.map(l => ({
      id: l.id,
      title: l.title,
      loopType: l.loopType,
      priority: l.priority,
      dueDate: l.dueDate,
      relatedEntities: l.relatedEntityIds?.map(eId => entities.find(e => e.id === eId)?.name).filter(Boolean) || [],
      notes: l.notes || null
    }));

    // Find facts that might indicate recurring concerns (potential loop promotions)
    // Look for facts mentioned multiple times or with temporal markers
    const recentFactContents = facts.slice(-30).map(f => f.content.toLowerCase());

    const systemPrompt = `You are a cognitive memory system managing OPEN LOOPS from personal journals.

AN OPEN LOOP is an unresolved item requiring FUTURE action that the user is ACTIVELY TRACKING.

YOUR PRIMARY JOB: Update existing loops with new information.
SECONDARY JOB: Identify items that MUST become loops (strict criteria).
TERTIARY JOB: Mark loops as resolved if journals indicate completion.

═══════════════════════════════════════════════════════════
STRICT CRITERIA FOR NEW LOOPS (must meet at least one):
═══════════════════════════════════════════════════════════

✅ IMMEDIATE LOOP - Create right away:
1. SCHEDULED EVENT: Specific date/time mentioned ("half-marathon in March", "dentist on Tuesday", "flight Dec 15")
2. EXPLICIT COMMITMENT: Promise made to someone ("told Sarah I'd help her move", "agreed to review his code")
3. HARD DEADLINE: External deadline with consequences ("taxes due April 15", "application deadline Friday")

⏳ FACT FIRST - Do NOT create loop yet:
4. ONE-OFF MENTION: Something noted once without follow-up plan ("check engine light came on", "should call mom", "might try that restaurant")
5. VAGUE INTENTION: No specific date or commitment ("want to exercise more", "thinking about learning Spanish")
6. OBSERVATION: Something that happened but has no action ("car made a weird noise", "felt tired today")

These become loops ONLY if:
- Mentioned in 2+ separate journal entries (shows it's weighing on them)
- User explicitly says they need to deal with it
- It becomes blocking or urgent

═══════════════════════════════════════════════════════════
LOOP LIFECYCLE:
═══════════════════════════════════════════════════════════

NEW → Only if strict criteria met (provide justification)
UPDATE → New info, date changes, priority shifts, progress notes
RESOLVE → Journal indicates completion, or user explicitly closed it
STALE → Will be auto-closed by system if no mention for 14+ days

═══════════════════════════════════════════════════════════
PRIORITY LEVELS:
═══════════════════════════════════════════════════════════

1 = URGENT: Deadline within 7 days, or high-stakes commitment
2 = ACTIVE: Deadline within 30 days, or ongoing tracked item  
3 = BACKBURNER: No deadline, or 30+ days out

Return JSON: { "updates": [...], "new": [...], "resolve": [...] }`;

    const userPrompt = `Review journals and manage open loops.

EXISTING OPEN LOOPS:
${existingLoopsFormatted.length > 0
        ? JSON.stringify(existingLoopsFormatted, null, 2)
        : 'None yet'}

KNOWN ENTITIES: ${entityList || 'none'}

JOURNALS:
${journalText}

═══════════════════════════════════════════════════════════

For each UPDATE to existing loop:
{
  "id": "existing loop id",
  "note": "What's new (1 sentence)",
  "dueDateUpdate": "new date if changed, or null",
  "priorityUpdate": 1-3 if changed, or null
}

For each NEW loop (strict criteria only, max 2):
{
  "title": "Concrete item (e.g., 'Half-marathon - March 15')",
  "loopType": "event|task|decision|commitment",
  "priority": 1-3,
  "relatedEntities": ["entity names"],
  "dueDate": "specific date if known, or null",
  "justification": "Which strict criterion does this meet? (scheduled/commitment/deadline)"
}

For each loop to RESOLVE:
{
  "id": "existing loop id",
  "resolution": "How it was resolved (1 sentence)"
}

REMEMBER: 
- One-off mentions → FACT, not loop
- "Should do X" without date → FACT, not loop  
- Only scheduled events, commitments, or deadlines → loop`;

    try {
      const result = await callClaude(systemPrompt, userPrompt, 0.3);

      // Process updates to existing loops
      let updatedLoops = openLoops.map(existing => {
        const update = (result.updates || []).find(u => u.id === existing.id);

        if (!update) return existing;

        console.log(`🔄 [CRS] Updating loop "${existing.title}": ${update.note}`);

        // Add note to history
        const notes = existing.notes || [];
        notes.push({
          date: new Date().toISOString().split('T')[0],
          note: update.note
        });

        return {
          ...existing,
          dueDate: update.dueDateUpdate ? this.parseRelativeDate(update.dueDateUpdate) : existing.dueDate,
          priority: update.priorityUpdate || existing.priority,
          notes: notes.slice(-10), // Keep last 10 notes
          updatedAt: Date.now()
        };
      });

      // Process resolutions
      const resolveIds = new Set((result.resolve || []).map(r => r.id));
      updatedLoops = updatedLoops.map(loop => {
        const resolution = (result.resolve || []).find(r => r.id === loop.id);
        if (resolution) {
          console.log(`✅ [CRS] Resolving loop "${loop.title}": ${resolution.resolution}`);
          return {
            ...loop,
            status: 'resolved',
            resolvedAt: Date.now(),
            resolutionNote: resolution.resolution,
            updatedAt: Date.now()
          };
        }
        return loop;
      });

      // Process new loops (should be rare and justified)
      const newLoops = (result.new || []).map(l => {
        // Validate justification exists
        if (!l.justification) {
          console.warn(`⚠️ [CRS] Rejecting loop "${l.title}" — no justification provided`);
          return null;
        }

        console.log(`🔄 [CRS] Creating loop "${l.title}" — ${l.justification}`);

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
          dueDate: this.parseRelativeDate(l.dueDate) || null,
          justification: l.justification,
          notes: [{
            date: new Date().toISOString().split('T')[0],
            note: 'Loop created'
          }],
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
      }).filter(Boolean);

      // Combine: updated open loops + newly resolved + still resolved + new
      const nowResolved = updatedLoops.filter(l => l.status === 'resolved');
      const stillOpen = updatedLoops.filter(l => l.status === 'open');
      const allLoops = [...stillOpen, ...newLoops, ...nowResolved, ...resolvedLoops];

      const updateCount = (result.updates || []).length;
      const resolveCount = (result.resolve || []).length;
      const newCount = newLoops.length;
      console.log(`🔄 [CRS] Loops: ${updateCount} updated, ${resolveCount} resolved, ${newCount} new, ${allLoops.length} total`);

      return allLoops;

    } catch (error) {
      console.error('❌ [CRS] Open loop processing failed:', error.message);
      return existingLoops;
    }
  }

  /**
   * Scan facts for repeated mentions that should be promoted to loops
   * "Mentioned twice = becoming a thing the user is tracking"
   */
  async promoteFactsToLoops(facts, entities, existingLoops) {
    console.log('🔍 [CRS] Scanning for fact → loop promotions...');

    // Get existing loop titles/topics to avoid duplicates
    const openLoopTitles = existingLoops
      .filter(l => l.status === 'open')
      .map(l => l.title.toLowerCase());

    // Group facts by entity + rough topic
    // Look for facts about the same thing mentioned on different dates
    const factGroups = this.groupFactsByTopic(facts);

    // Filter to groups with 2+ mentions that aren't already loops
    const candidates = factGroups.filter(group => {
      if (group.facts.length < 2) return false;

      // Check if already covered by an existing loop
      const isAlreadyLoop = openLoopTitles.some(title => {
        const groupWords = new Set(group.topic.toLowerCase().split(/\s+/));
        const titleWords = new Set(title.split(/\s+/));
        const overlap = [...groupWords].filter(w => titleWords.has(w) && w.length > 3).length;
        return overlap >= 2;
      });

      if (isAlreadyLoop) return false;

      // Check if mentions span multiple days (not just same-day repetition)
      const dates = new Set(group.facts.map(f => {
        const d = new Date(f.createdAt);
        return d.toISOString().split('T')[0];
      }));

      return dates.size >= 2; // Mentioned on 2+ different days
    });

    if (candidates.length === 0) {
      console.log('🔍 [CRS] No facts ready for promotion');
      return [];
    }

    console.log(`🔍 [CRS] Found ${candidates.length} candidate fact clusters for promotion`);

    // Use LLM to decide which candidates should become loops
    const systemPrompt = `You are evaluating whether REPEATED FACTS should be promoted to OPEN LOOPS.

A fact cluster should become a loop if:
1. It represents something UNRESOLVED that needs action
2. The user is clearly TRACKING or THINKING about it (mentioned 2+ times)
3. It's not just an observation or completed event

Examples:
✅ PROMOTE: "Check engine light" mentioned 3x over a week → User is worried, needs to deal with it
✅ PROMOTE: "Mom's birthday" mentioned 2x → Upcoming event user is thinking about
✅ PROMOTE: "Lease renewal" mentioned 2x → Decision/deadline approaching

🚫 DON'T PROMOTE: "Had coffee with Sarah" 2x → Just recording events, not unresolved
🚫 DON'T PROMOTE: "Feeling tired" 3x → Observation/pattern, not actionable loop
🚫 DON'T PROMOTE: "Work was busy" 2x → General state, not a tracked item

Return JSON: { "promote": [...], "skip": [...] }`;

    const candidateSummaries = candidates.map((c, i) => ({
      index: i,
      topic: c.topic,
      mentionCount: c.facts.length,
      entityName: c.entityName,
      samples: c.facts.slice(0, 3).map(f => f.content)
    }));

    const userPrompt = `Evaluate these repeated fact clusters for promotion to open loops:

${JSON.stringify(candidateSummaries, null, 2)}

For each cluster, decide:
- PROMOTE: User is tracking something unresolved → create a loop
- SKIP: Just observations, completed events, or patterns → leave as facts

For each PROMOTE:
{
  "index": number,
  "title": "Loop title",
  "loopType": "task|decision|event|concern",
  "priority": 2-3,
  "reason": "Why this deserves to be tracked as a loop"
}

For each SKIP:
{
  "index": number,
  "reason": "Why this should stay as facts"
}`;

    try {
      const result = await callClaude(systemPrompt, userPrompt, 0.2);

      const newLoops = (result.promote || []).map(p => {
        const candidate = candidates[p.index];
        if (!candidate) return null;

        console.log(`⬆️ [CRS] Promoting "${candidate.topic}" to loop: ${p.reason}`);

        // Find related entity
        const entity = entities.find(e =>
          e.name.toLowerCase() === (candidate.entityName || '').toLowerCase()
        );

        return {
          id: generateId('loop'),
          title: p.title,
          loopType: p.loopType || 'concern',
          priority: p.priority || 2,
          status: 'open',
          relatedEntityIds: entity ? [entity.id] : [],
          dueDate: null,
          promotedFromFacts: candidate.facts.map(f => f.id),
          promotionReason: p.reason,
          notes: [{
            date: new Date().toISOString().split('T')[0],
            note: `Promoted from ${candidate.facts.length} fact mentions`
          }],
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
      }).filter(Boolean);

      // Log skips for debugging
      for (const skip of (result.skip || [])) {
        const candidate = candidates[skip.index];
        if (candidate) {
          console.log(`➡️ [CRS] Keeping "${candidate.topic}" as facts: ${skip.reason}`);
        }
      }

      console.log(`⬆️ [CRS] Promoted ${newLoops.length} fact clusters to loops`);
      return newLoops;

    } catch (error) {
      console.error('❌ [CRS] Fact promotion failed:', error.message);
      return [];
    }
  }

  /**
   * Group facts by entity + semantic topic for promotion analysis
   */
  groupFactsByTopic(facts) {
    const groups = [];
    const processed = new Set();

    for (const fact of facts) {
      if (processed.has(fact.id)) continue;

      // Find similar facts (same entity + word overlap)
      const similar = facts.filter(other => {
        if (other.id === fact.id || processed.has(other.id)) return false;
        if (other.entityId !== fact.entityId) return false;

        const similarity = this.calculateTextSimilarity(fact.content, other.content);
        return similarity > 0.4;
      });

      if (similar.length > 0) {
        const allFacts = [fact, ...similar];
        allFacts.forEach(f => processed.add(f.id));

        // Extract topic from the facts
        const words = allFacts
          .flatMap(f => f.content.toLowerCase().split(/\s+/))
          .filter(w => w.length > 3);

        const wordCounts = {};
        for (const w of words) {
          wordCounts[w] = (wordCounts[w] || 0) + 1;
        }

        const topWords = Object.entries(wordCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 4)
          .map(([word]) => word);

        const entityName = allFacts[0].entityId === 'self'
          ? null
          : allFacts[0].entityId?.replace('entity_', '').replace(/_/g, ' ');

        groups.push({
          topic: topWords.join(' '),
          entityId: fact.entityId,
          entityName,
          facts: allFacts
        });
      }
    }

    return groups;
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

    const { entities, facts, loops, patterns, narratives } = crsOutputs;

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

    // Export loops
    const usedLoopSlugs = new Set();
    for (const loop of loops) {
      const dir = loop.status === 'resolved' ? 'resolved/' : '';
      let slug = slugify(loop.title);

      if (usedLoopSlugs.has(slug)) {
        slug = `${slug}_${loop.id.slice(-6)}`;
      }
      usedLoopSlugs.add(slug);

      const path = `system/open_loops/${dir}${slug}.json`;
      await this.writeFile(path, loop);
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
  // SUGGESTED QUESTIONS GENERATION
  // ============================================================================

  async generateSuggestedQuestions(crsOutputs) {
    console.log('💡 [CRS] Generating suggested questions (journal-anchored)...');

    if (!anthropicApiKey) {
      console.warn('⚠️ [CRS] No Anthropic key - using fallback questions');
      return this.getFallbackQuestions();
    }

    const { entities, facts, loops, patterns, narratives } = crsOutputs;

    // Load RECENT journal entries (last 3 days) - this is the key differentiator
    const recentJournals = await this.loadRecentJournalText(3);
    
    // Get today's date info
    const today = new Date();
    const dayOfWeek = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][today.getDay()];
    const dateStr = today.toISOString().split('T')[0];

    // Only include URGENT loops (due within 7 days) or high priority
    const urgentLoops = loops.filter(l => {
      if (l.status !== 'open') return false;
      if (l.priority === 1) return true;
      if (l.dueDate) {
        const dueDate = new Date(l.dueDate);
        const daysUntil = (dueDate.getTime() - today.getTime()) / (24 * 60 * 60 * 1000);
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
URGENT/IMMINENT (secondary context):
═══════════════════════════════════════════════════════════
${urgentLoops.length > 0 
  ? urgentLoops.map(l => `- ${l.title}${l.dueDate ? ` (${l.dueDate})` : ''}`).join('\n')
  : 'Nothing urgent'}

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
      const suggestedQuestionsData = await this.readFile('system/suggested_questions.json');

      // Load Night Owl insights
      const nightOwlInsights = await this.loadNightOwlInsights();

      return {
        // Flat arrays for RTCS sync
        entities,
        facts,
        open_loops: openLoops,  // Key name matches RTCS expectation
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
