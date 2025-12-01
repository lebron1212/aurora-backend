/**
 * Horizon CRS Service
 * Cognitive Representation System for Aurora
 * 
 * Handles:
 * - Processing journals/conversations into entities, facts, loops, patterns, narratives
 * - Exporting CRS outputs to /system file structure in Supabase
 * - Generating update manifests for RTCS sync
 * - Nightly processing cron jobs
 */

import { createClient } from '@supabase/supabase-js';
import cron from 'node-cron';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error('Missing Supabase configuration. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables.');
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

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
        console.error(`❌ [CRS] Failed to create directory ${dir}:`, error);
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
      console.log(`📈 [CRS] Processed: ${crsOutputs.entities.length} entities, ${crsOutputs.facts.length} facts, ${crsOutputs.loops.length} loops`);

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
    const journals = await this.readFile('journals.json') || [];
    const conversations = await this.readFile('conversations.json') || [];
    const processingResults = await this.readFile('processing-results.json') || {};

    return {
      journals,
      conversations,
      processingResults,
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
    console.log('🧠 [CRS] Processing cognitive data...');

    // This is where the main CRS logic would go
    // For now, we'll create a simplified version that demonstrates the structure
    
    const entities = await this.processEntities(rawData);
    const facts = await this.processFacts(rawData, entities);
    const loops = await this.processOpenLoops(rawData, entities);
    const patterns = await this.processPatterns(rawData, facts);
    const narratives = await this.processNarratives(rawData, entities);

    return { entities, facts, loops, patterns, narratives };
  }

  /**
   * Export CRS outputs to /system file structure
   */
  async exportCRSOutputsToSystemFS(crsOutputs) {
    console.log('📤 [CRS] Exporting to /system file structure...');

    const { entities, facts, loops, patterns, narratives } = crsOutputs;

    // Export entities by category
    const entityCategories = {};
    for (const entity of entities) {
      if (!entityCategories[entity.category]) {
        entityCategories[entity.category] = [];
      }
      entityCategories[entity.category].push(entity);
    }

    for (const [category, categoryEntities] of Object.entries(entityCategories)) {
      for (const entity of categoryEntities) {
        const fileName = `entity_${entity.id}.json`;
        const path = `system/entities/${category}/${fileName}`;
        await this.writeFile(path, entity);
      }
    }

    // Export facts by entity
    const factsByEntity = {};
    for (const fact of facts) {
      if (!factsByEntity[fact.entityId]) {
        factsByEntity[fact.entityId] = [];
      }
      factsByEntity[fact.entityId].push(fact);
    }

    for (const [entityId, entityFacts] of Object.entries(factsByEntity)) {
      for (const fact of entityFacts) {
        const path = `system/facts/${entityId}/${fact.id}.json`;
        await this.writeFile(path, fact);
      }
    }

    // Export loops
    for (const loop of loops) {
      const dir = loop.status === 'resolved' ? 'resolved' : '';
      const path = dir 
        ? `system/open_loops/${dir}/${loop.id}.json`
        : `system/open_loops/${loop.id}.json`;
      await this.writeFile(path, loop);
    }

    // Export patterns
    for (const pattern of patterns) {
      const path = `system/patterns/${pattern.id}.json`;
      await this.writeFile(path, pattern);
    }

    // Export narratives
    for (const narrative of narratives) {
      const path = `system/narratives/${narrative.id}.json`;
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
      processingTimeMs: this.lastProcessingTime ? Date.now() - this.lastProcessingTime : null,
      newEntityCount: entities.filter(e => e.createdAt > Date.now() - 24 * 60 * 60 * 1000).length,
      newFactCount: facts.filter(f => f.createdAt > Date.now() - 24 * 60 * 60 * 1000).length
    };

    await this.writeFile('system/updates/latest.json', manifest);
    
    // Also write with timestamp for history
    const timestampedPath = `system/updates/manifest_${Date.now()}.json`;
    await this.writeFile(timestampedPath, manifest);
    
    console.log('✅ [CRS] Update manifest generated and stored');
  }

  /**
   * Simplified entity processing
   */
  async processEntities(rawData) {
    // This would contain the actual entity extraction logic
    // For now, return existing entities or create sample ones
    const existing = rawData.existing.entities || [];
    
    // Add basic self entity if it doesn't exist
    if (!existing.find(e => e.id === 'self')) {
      existing.push({
        id: 'self',
        name: 'Self',
        category: 'people',
        aliases: ['I', 'me', 'myself'],
        salience: 1.0,
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

    return existing;
  }

  /**
   * Simplified fact processing  
   */
  async processFacts(rawData, entities) {
    // This would contain the actual fact extraction logic
    return rawData.existing.facts || [];
  }

  /**
   * Simplified open loop processing
   */
  async processOpenLoops(rawData, entities) {
    return rawData.existing.loops || [];
  }

  /**
   * Simplified pattern processing
   */
  async processPatterns(rawData, facts) {
    return rawData.existing.patterns || [];
  }

  /**
   * Simplified narrative processing
   */
  async processNarratives(rawData, entities) {
    return rawData.existing.narratives || [];
  }

  /**
   * Load existing system files for a given type
   */
  async loadExistingSystemFiles(type) {
    try {
      const { data: files } = await supabase.storage
        .from('horizon-files')
        .list(`system/${type}`, { recursive: true });

      if (!files) return [];

      const systemFiles = [];
      for (const file of files) {
        if (file.name.endsWith('.json') && file.name !== '.keep') {
          const path = `system/${type}/${file.name}`;
          const content = await this.readFile(path);
          if (content) systemFiles.push(content);
        }
      }

      return systemFiles;
    } catch (error) {
      console.error(`❌ [CRS] Failed to load existing ${type}:`, error);
      return [];
    }
  }

  /**
   * Write file to Supabase storage
   */
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
      console.error(`❌ [CRS] Failed to write file ${path}:`, error);
      throw error;
    }
  }

  /**
   * Read file from Supabase storage
   */
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
      console.error(`❌ [CRS] Failed to read file ${path}:`, error);
      return null;
    }
  }

  /**
   * List files in a directory
   */
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
      console.error(`❌ [CRS] Failed to list files in ${path}:`, error);
      return [];
    }
  }

  /**
   * Delete file from Supabase storage
   */
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
      console.error(`❌ [CRS] Failed to delete file ${path}:`, error);
      return false;
    }
  }

  /**
   * Setup manual trigger for testing
   */
  setupManualTrigger() {
    // This will be called by the main server to set up the manual endpoint
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

  /**
   * Get system export for client sync
   */
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
      console.error('❌ [CRS] Failed to get system export:', error);
      throw error;
    }
  }

  /**
   * Get single file from system
   */
  async getSystemFile(filePath) {
    const fullPath = filePath.startsWith('system/') ? filePath : `system/${filePath}`;
    return await this.readFile(fullPath);
  }

  /**
   * Get current manifest only
   */
  async getSystemManifest() {
    return await this.readFile('system/updates/latest.json');
  }

  /**
   * Helper to group array by property
   */
  groupBy(array, property) {
    return array.reduce((groups, item) => {
      const key = item[property];
      if (!groups[key]) {
        groups[key] = [];
      }
      groups[key].push(item);
      return groups;
    }, {});
  }
}

export default HorizonCRSService;