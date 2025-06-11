// main.js - Enhanced OpenAlex Research Assistant Plugin with Hub System - Resease V 1.0.0
const { Plugin, TFile, Notice, Setting, PluginSettingTab, Modal } = require('obsidian');

const DEFAULT_SETTINGS = {
    autoProcessNewFiles: false, // Changed default to false
    createHubs: true,
    maxReferencesToProcess: 100,
    maxCitedByToProcess: 50,
    hubFolder: 'Research-Hubs',
    zoteroFolder: 'Papers',
    delayBetweenRequests: 200,
    enableNotifications: true,
    useAuthorYearFormat: true,
    createPhantomLinks: true // New setting for phantom links
};

class OpenAlexResearchAssistant extends Plugin {
    async onload() {
        await this.loadSettings();
        
        this.fileWatcher = new Set();
        this.processingQueue = new Set();
        this.hubMap = new Map(); // openalex_id -> hub_path
        this.paperHubMap = new Map(); // paper_name -> hub_path
        
        this.addSettingTab(new OpenAlexSettingTab(this.app, this));
        
        // Only register auto-processing if enabled
        if (this.settings.autoProcessNewFiles) {
            this.registerEvent(this.app.vault.on('create', (file) => this.onFileCreated(file)));
            this.registerEvent(this.app.vault.on('modify', (file) => this.onFileModified(file)));
        }
        
        this.addRibbonIcon('zap', 'Process with OpenAlex', () => this.processCurrentFile());
        
        this.addCommand({
            id: 'process-current-file',
            name: 'Process current file with OpenAlex',
            callback: () => this.processCurrentFile()
        });
        
        this.addCommand({
            id: 'process-all-unprocessed',
            name: 'Process all unprocessed papers',
            callback: () => this.processAllUnprocessed()
        });

        this.addCommand({
            id: 'toggle-auto-processing',
            name: 'Toggle auto-processing of new files',
            callback: () => this.toggleAutoProcessing()
        });

        await this.buildHubMap();
        console.log('OpenAlex Research Assistant loaded');
    }

    async toggleAutoProcessing() {
        this.settings.autoProcessNewFiles = !this.settings.autoProcessNewFiles;
        await this.saveSettings();
        
        new Notice(`Auto-processing ${this.settings.autoProcessNewFiles ? 'enabled' : 'disabled'}`);
        
        // Re-register or unregister events
        if (this.settings.autoProcessNewFiles) {
            this.registerEvent(this.app.vault.on('create', (file) => this.onFileCreated(file)));
            this.registerEvent(this.app.vault.on('modify', (file) => this.onFileModified(file)));
        }
    }

    async buildHubMap() {
        const files = this.app.vault.getMarkdownFiles();
        for (const file of files) {
            if (file.path.includes(this.settings.hubFolder) && file.name.startsWith('Hub_')) {
                try {
                    const content = await this.app.vault.read(file);
                    const match = content.match(/openalex_id:\s*"([^"]+)"/);
                    if (match) {
                        this.hubMap.set(match[1], file.path);
                        // Also map paper name to hub
                        const parentMatch = content.match(/## Parent Paper\n- \[\[([^\]]+)\]\]/);
                        if (parentMatch) {
                            this.paperHubMap.set(parentMatch[1], file.path);
                        }
                    }
                } catch (error) {
                    console.error(`Error reading hub ${file.path}:`, error);
                }
            }
        }
    }

    async onFileCreated(file) {
        if (!this.settings.autoProcessNewFiles || !file.path.includes(this.settings.zoteroFolder) || !file.name.endsWith('.md')) return;
        setTimeout(() => this.fileWatcher.add(file.path), 2000);
    }

    async onFileModified(file) {
        if (!this.fileWatcher.has(file.path) || this.processingQueue.has(file.path)) return;
        
        this.fileWatcher.delete(file.path);
        this.processingQueue.add(file.path);
        
        setTimeout(async () => {
            await this.processZoteroFile(file);
            this.processingQueue.delete(file.path);
        }, 3000);
    }

    async processCurrentFile() {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) {
            new Notice('No active file');
            return;
        }
        await this.processZoteroFile(activeFile);
    }

    async processAllUnprocessed() {
        const files = this.app.vault.getMarkdownFiles()
            .filter(file => file.path.includes(this.settings.zoteroFolder) && !this.processingQueue.has(file.path));
        
        if (files.length === 0) {
            new Notice('No unprocessed files found');
            return;
        }
        
        new Notice(`Processing ${files.length} files...`);
        
        for (const file of files) {
            await this.processZoteroFile(file);
            await this.delay(this.settings.delayBetweenRequests);
        }
        
        new Notice('Batch processing complete');
    }

    generateHubCiteKey(work) {
        const firstAuthor = work.authorships?.[0]?.author.display_name.split(' ').pop() || 'Unknown';
        const year = work.publication_year || 'NoYear';
        
        const stopWords = new Set(['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'was', 'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his', 'how', 'its', 'may', 'new', 'now', 'old', 'see', 'two', 'who', 'boy', 'did', 'use', 'way', 'she', 'man', 'own', 'say', 'too', 'any', 'from', 'they', 'know', 'want', 'been', 'good', 'much', 'some', 'time', 'very', 'when', 'come', 'here', 'just', 'like', 'long', 'make', 'many', 'over', 'such', 'take', 'than', 'them', 'well', 'were']);
        
        const title = work.display_name || work.title || '';
        const words = title
            .replace(/[^\w\s]/g, '')
            .split(/\s+/)
            .filter(word => word.length > 2 && !stopWords.has(word.toLowerCase()))
            .slice(0, 3)
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
        
        const titlePart = words.length > 0 ? words.join('') : 'UnknownTitle';
        return this.sanitizeFilename(`hub_${firstAuthor}${year}_${titlePart}`);
    }

    async processZoteroFile(file) {
        try {
            const content = await this.app.vault.read(file);
            
            if (content.includes('processed_by_openalex: true')) {
                if (this.settings.enableNotifications) {
                    new Notice(`${file.basename} already processed`);
                }
                return;
            }
            
            const doi = this.extractDOI(content);
            const title = this.extractTitle(content, file.basename);
            
            if (!doi && !title) {
                new Notice(`No DOI or title found for ${file.basename}`);
                return;
            }
            
            if (this.settings.enableNotifications) {
                new Notice(`Processing ${file.basename}...`);
            }
            
            const work = await this.fetchOpenAlexData(doi, title);
            if (!work) {
                new Notice(`No OpenAlex data found for ${file.basename}`);
                return;
            }
            
            await this.updateFileWithOpenAlexData(file, work, content);
            
            // Create hub for current paper and add Hub section to Zotero note
            const currentHub = await this.ensureHub(work, file.basename);
            await this.addHubSectionToZoteroNote(file, currentHub);
            
            if (this.settings.createHubs) {
                // Process references and citations
                await this.processReferencesAndCitations(work, file.basename, currentHub);
            }
            
            if (this.settings.enableNotifications) {
                new Notice(`✓ Processed ${file.basename}`);
            }
            
        } catch (error) {
            console.error(`Error processing ${file.path}:`, error);
            new Notice(`Error processing ${file.basename}: ${error.message}`);
        }
    }
    // Continuing from Part 1...
    
    async addHubSectionToZoteroNote(file, hubPath) {
        try {
            const content = await this.app.vault.read(file);
            const hubName = hubPath.split('/').pop().replace('.md', '');
            
            if (content.includes('## Hub')) return; // Already has hub section
            
            const hubSection = `\n## Hub\n- [[${hubName}]]\n`;
            
            let newContent = content;
            const insertPoint = content.indexOf('## 🗒 Persistent Notes');
            if (insertPoint !== -1) {
                newContent = content.slice(0, insertPoint) + hubSection + content.slice(insertPoint);
            } else {
                newContent += hubSection;
            }
            
            await this.app.vault.modify(file, newContent);
        } catch (error) {
            console.error('Error adding hub section:', error);
        }
    }

    async ensureHub(work, paperName) {
        const hubPath = this.hubMap.get(work.id);
        
        if (hubPath && this.app.vault.getAbstractFileByPath(hubPath)) {
            await this.updateHubConnection(hubPath, paperName);
            return hubPath;
        }
        
        // Create new hub
        try {
            await this.app.vault.createFolder(this.settings.hubFolder);
        } catch (error) {
            // Folder exists
        }
        
        const filename = this.generateHubCiteKey(work);
        const newHubPath = `${this.settings.hubFolder}/${filename}.md`;
        
        const hubContent = this.createHubContent(work, paperName);
        await this.app.vault.create(newHubPath, hubContent);
        
        this.hubMap.set(work.id, newHubPath);
        this.paperHubMap.set(paperName, newHubPath);
        return newHubPath;
    }

    async updateHubConnection(hubPath, paperName) {
        try {
            const file = this.app.vault.getAbstractFileByPath(hubPath);
            const content = await this.app.vault.read(file);
            
            // Check if this paper is already the parent
            if (content.includes(`## Parent Paper\n- [[${paperName}]]`)) return;
            
            // Check if it's in connected papers
            if (content.includes(`[[${paperName}]]`)) return;
            
            const connectionsRegex = /## Connected Papers\n([\s\S]*?)(?=\n## |\n---|\n$|$)/;
            const match = content.match(connectionsRegex);
            
            if (match) {
                const newConnection = `- [[${paperName}]]`;
                const updatedConnections = match[1].trim() + '\n' + newConnection;
                const updatedContent = content.replace(connectionsRegex, `## Connected Papers\n${updatedConnections}\n`);
                await this.app.vault.modify(file, updatedContent);
            }
        } catch (error) {
            console.error(`Error updating hub connection ${hubPath}:`, error);
        }
    }

    async processReferencesAndCitations(work, sourcePaper, hubPath) {
        const citedLinks = [];
        const citedByLinks = [];
        
        // Process references (papers this one cites)
        if (work.referenced_works?.length > 0) {
            const referencesToProcess = work.referenced_works.slice(0, this.settings.maxReferencesToProcess);
            
            for (const refId of referencesToProcess) {
                try {
                    const refWork = await this.fetchOpenAlexWorkById(refId);
                    if (!refWork) continue;
                    
                    const refHubName = this.generateHubCiteKey(refWork);
                    citedLinks.push(`[[${refHubName}]]`);
                    
                    // Create phantom hub if createPhantomLinks is enabled
                    if (this.settings.createPhantomLinks) {
                        await this.ensureHub(refWork, sourcePaper);
                    }
                    
                    await this.delay(this.settings.delayBetweenRequests);
                } catch (error) {
                    console.error(`Error processing reference ${refId}:`, error);
                }
            }
        }
        
        // Process cited-by papers
        if (work.cited_by_count > 0) {
            try {
                const citedByUrl = `https://api.openalex.org/works?filter=cites:${work.id}&per-page=${this.settings.maxCitedByToProcess}`;
                const response = await fetch(citedByUrl);
                if (response.ok) {
                    const data = await response.json();
                    const citedByWorks = data.results || [];
                    
                    for (const citingWork of citedByWorks) {
                        const citingHubName = this.generateHubCiteKey(citingWork);
                        citedByLinks.push(`[[${citingHubName}]]`);
                        
                        // Create phantom hub if createPhantomLinks is enabled
                        if (this.settings.createPhantomLinks) {
                            await this.ensureHub(citingWork, sourcePaper);
                        }
                        
                        await this.delay(this.settings.delayBetweenRequests);
                    }
                }
            } catch (error) {
                console.error('Error processing cited-by papers:', error);
            }
        }
        
        // Update hub with cited and cited-by sections
        await this.updateHubWithCitations(hubPath, citedLinks, citedByLinks);
    }

    async updateHubWithCitations(hubPath, citedLinks, citedByLinks) {
        try {
            const file = this.app.vault.getAbstractFileByPath(hubPath);
            let content = await this.app.vault.read(file);
            
            // Add Cited section
            if (citedLinks.length > 0) {
                const citedSection = `## Cited\n${citedLinks.map(link => `- ${link}`).join('\n')}\n\n`;
                
                const citedRegex = /## Cited\n[\s\S]*?(?=\n## |\n---|\n$|$)/;
                if (citedRegex.test(content)) {
                    content = content.replace(citedRegex, citedSection.trim());
                } else {
                    const insertPoint = content.indexOf('## Research Notes');
                    if (insertPoint !== -1) {
                        content = content.slice(0, insertPoint) + citedSection + content.slice(insertPoint);
                    } else {
                        content += citedSection;
                    }
                }
            }
            
            // Add Cited By section
            if (citedByLinks.length > 0) {
                const citedBySection = `## Cited By\n${citedByLinks.map(link => `- ${link}`).join('\n')}\n\n`;
                
                const citedByRegex = /## Cited By\n[\s\S]*?(?=\n## |\n---|\n$|$)/;
                if (citedByRegex.test(content)) {
                    content = content.replace(citedByRegex, citedBySection.trim());
                } else {
                    const insertPoint = content.indexOf('## Research Notes');
                    if (insertPoint !== -1) {
                        content = content.slice(0, insertPoint) + citedBySection + content.slice(insertPoint);
                    } else {
                        content += citedBySection;
                    }
                }
            }
            
            await this.app.vault.modify(file, content);
        } catch (error) {
            console.error('Error updating hub with citations:', error);
        }
    }

    createHubContent(work, connectedPaper) {
        const filename = this.generateHubCiteKey(work);
        
        let content = `---\n`;
        content += `title: "${work.display_name || work.title || 'Unknown'}"\n`;
        content += `doi: "${work.ids?.doi || ''}"\n`;
        content += `publication_year: ${work.publication_year || 'Unknown'}\n`;
        content += `journal: "${work.host_venue?.display_name || 'Unknown'}"\n`;
        content += `authors: "${work.authorships?.map(a => a.author.display_name).join(', ') || 'Unknown'}"\n`;
        content += `openalex_id: "${work.id}"\n`;
        content += `cited_by_count: ${work.cited_by_count || 0}\n`;
        content += `is_hub: true\n`;
        content += `cssclass: research-hub\n`;
        content += `tags: [hub, research]\n`;
        content += `---\n\n`;
        
        content += `# ${work.display_name || work.title || 'Unknown Paper'}\n\n`;
        content += `> [!abstract] Research Hub 🔗\n`;
        content += `> Central hub connecting papers in your research network\n\n`;
        
        content += `## Parent Paper\n- [[${connectedPaper}]]\n\n`;
        
        content += `## Paper Details\n`;
        content += `- **Authors:** ${work.authorships?.map(a => a.author.display_name).join(', ') || 'Unknown'}\n`;
        content += `- **Year:** ${work.publication_year || 'Unknown'}\n`;
        content += `- **Journal:** ${work.host_venue?.display_name || 'Unknown'}\n`;
        content += `- **DOI:** ${work.ids?.doi || 'N/A'}\n`;
        content += `- **Citation Count:** ${work.cited_by_count || 0}\n`;
        content += `- **OpenAlex ID:** [${work.id}](${work.id})\n\n`;
        
        if (work.abstract_inverted_index) {
            const abstract = Object.entries(work.abstract_inverted_index)
                .flatMap(([word, positions]) => positions.map(pos => [pos, word]))
                .sort((a, b) => a[0] - b[0])
                .map(entry => entry[1])
                .join(' ');
            content += `## Abstract\n${abstract}\n\n`;
        }
        
        if (work.concepts?.length > 0) {
            content += `## Key Concepts\n`;
            work.concepts.slice(0, 5).forEach(concept => {
                content += `- ${concept.display_name} (${Math.round(concept.score * 100)}%)\n`;
            });
            content += `\n`;
        }
        
        content += `## Connected Papers\n*Papers in your vault that reference this work*\n\n`;
        content += `## Cited\n*Papers this work references*\n\n`;
        content += `## Cited By\n*Papers that cite this work*\n\n`;
        content += `## Research Notes\n*Add your research insights and connections here*\n`;
        
        return content;
    }
    
    async fetchOpenAlexData(doi, title) {
        try {
            const url = doi 
                ? `https://api.openalex.org/works/https://doi.org/${doi}`
                : `https://api.openalex.org/works?search=${encodeURIComponent(title)}&per-page=1`;
            
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            
            const data = await response.json();
            return doi ? data : (data.results?.[0] || null);
            
        } catch (error) {
            console.error('Error fetching OpenAlex data:', error);
            return null;
        }
    }

    async fetchOpenAlexWorkById(id) {
        try {
            const response = await fetch(`https://api.openalex.org/works/${id}`);
            return response.ok ? await response.json() : null;
        } catch (error) {
            return null;
        }
    }

    async updateFileWithOpenAlexData(file, work, originalContent) {
        let abstract = '';
        if (work.abstract_inverted_index) {
            const words = Object.entries(work.abstract_inverted_index)
                .flatMap(([word, positions]) => positions.map(pos => [pos, word]))
                .sort((a, b) => a[0] - b[0])
                .map(entry => entry[1]);
            abstract = words.join(' ');
        }
        
        let newContent = this.updateFrontmatter(originalContent, {
            publication_year: work.publication_year,
            journal: work.host_venue?.display_name || 'Unknown',
            openalex_id: work.id,
            cited_by_count: work.cited_by_count,
            concepts: work.concepts?.slice(0, 5).map(c => c.display_name) || [],
            processed_by_openalex: true
        });
        
        const metadataSection = this.buildMetadataSection(work, abstract);
        
        if (newContent.includes('## 📊 OpenAlex Metadata')) {
            newContent = newContent.replace(
                /## 📊 OpenAlex Metadata[\s\S]*?(?=\n## |\n---|\n$)/,
                metadataSection
            );
        } else {
            const insertPoint = newContent.indexOf('🗒 Persistent Notes'); // Place of Metadata to be Placed
            if (insertPoint !== -1) {
                newContent = newContent.slice(0, insertPoint) + 
                           metadataSection + '\n\n' + 
                           newContent.slice(insertPoint);
            } else {
                newContent += '\n\n' + metadataSection;
            }
        }
        
        await this.app.vault.modify(file, newContent);
    }

    buildMetadataSection(work, abstract) {
        let section = `## 📊 OpenAlex Metadata\n\n### Publication Details\n`;
        section += `- **Journal:** ${work.host_venue?.display_name || 'Unknown'}\n`;
        section += `- **Publication Year:** ${work.publication_year}\n`;
        section += `- **DOI:** ${work.ids?.doi || 'N/A'}\n`;
        section += `- **OpenAlex ID:** [${work.id}](${work.id})\n`;
        section += `- **Citation Count:** ${work.cited_by_count}\n\n`;
        
        if (work.concepts?.length > 0) {
            section += `### Research Concepts\n`;
            work.concepts.slice(0, 5).forEach(concept => {
                section += `- **${concept.display_name}** (${Math.round(concept.score * 100)}%)\n`;
            });
            section += `\n`;
        }
        
        if (abstract) {
            section += `### OpenAlex Abstract\n> ${abstract}\n\n`;
        }
        
        section += `### Citation Network\n`;
        section += `- **References:** ${work.referenced_works?.length || 0} papers\n`;
        section += `- **Cited By:** ${work.cited_by_count} papers\n`;
        
        return section;
    }

    updateFrontmatter(content, updates) {
        const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
        const match = content.match(frontmatterRegex);
        
        if (!match) {
            let newFrontmatter = '---\n';
            Object.entries(updates).forEach(([key, value]) => {
                if (Array.isArray(value)) {
                    newFrontmatter += `${key}: [${value.map(v => `"${v}"`).join(', ')}]\n`;
                } else {
                    newFrontmatter += `${key}: ${typeof value === 'string' ? `"${value}"` : value}\n`;
                }
            });
            newFrontmatter += '---\n';
            return newFrontmatter + content;
        }
        
        let frontmatterText = match[1];
        Object.entries(updates).forEach(([key, value]) => {
            const existingLine = new RegExp(`^${key}:.*$`, 'm');
            let newLine;
            if (Array.isArray(value)) {
                newLine = `${key}: [${value.map(v => `"${v}"`).join(', ')}]`;
            } else {
                newLine = `${key}: ${typeof value === 'string' ? `"${value}"` : value}`;
            }
            
            if (existingLine.test(frontmatterText)) {
                frontmatterText = frontmatterText.replace(existingLine, newLine);
            } else {
                frontmatterText += '\n' + newLine;
            }
        });
        
        return content.replace(frontmatterRegex, `---\n${frontmatterText}\n---`);
    }

    extractDOI(content) {
        const doiRegex = /(?:doi:\s*["']?|https?:\/\/(?:dx\.)?doi\.org\/)(10\.\d{4,}\/[^\s"'\]]+)/i;
        const match = content.match(doiRegex);
        return match ? match[1] : null;
    }

    extractTitle(content, fallback) {
        const titleRegex = /(?:title:\s*["']([^"']+)["']|# ([^\n]+))/i;
        const match = content.match(titleRegex);
        return match ? (match[1] || match[2]) : fallback;
    }

    sanitizeFilename(filename) {
        return filename
            .replace(/[<>:"/\\|?*]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .substring(0, 100);
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}

class OpenAlexSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    //Canvas graph setup
    async setupGraphGroups() {
    // Show instructions modal instead of trying to programmatically set groups
    const modal = new Modal(this.app);
    modal.titleEl.setText('Graph Groups Setup');
    modal.contentEl.innerHTML = `
        <p><strong>Follow these steps to color your graph nodes:</strong></p>
        <ol>
            <li>Open <strong>Graph View</strong></li>
            <li>Click the <strong>⚙️ settings gear</strong> icon in the graph</li>
            <li>Scroll down to <strong>"Groups"</strong> section</li>
            <li><strong>Add Group 1:</strong>
                <br>• Query: <code>path:"${this.plugin.settings.hubFolder}/" OR file:"hub_"</code>
                <br>• Color: Orange/Red</li>
            <li><strong>Add Group 2:</strong>
                <br>• Query: <code>path:"${this.plugin.settings.zoteroFolder}/"</code>
                <br>• Color: Blue</li>
        </ol>
        <p><em>This will color all hub files orange and paper files blue in your graph.</em></p>
    `;
    
    const button = modal.contentEl.createEl('button', {
        text: 'Got it!',
        cls: 'mod-cta'
    });
    button.onclick = () => modal.close();
    
    modal.open();
}

    display() {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'OpenAlex Research Assistant - Enhanced Hub System' });

        new Setting(containerEl)
            .setName('Auto-process new files')
            .setDesc('Automatically process new Zotero imports (can be toggled with command)')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoProcessNewFiles)
                .onChange(async (value) => {
                    this.plugin.settings.autoProcessNewFiles = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Create research hubs')
            .setDesc('Create hub notes for connected papers with citation networks')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.createHubs)
                .onChange(async (value) => {
                    this.plugin.settings.createHubs = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Create phantom links')
            .setDesc('Create hub files for referenced/citing papers not in your vault')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.createPhantomLinks)
                .onChange(async (value) => {
                    this.plugin.settings.createPhantomLinks = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Enable notifications')
            .setDesc('Show processing notifications')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableNotifications)
                .onChange(async (value) => {
                    this.plugin.settings.enableNotifications = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Max references to process')
            .setDesc('Maximum number of references to process per paper')
            .addSlider(slider => slider
                .setLimits(10, 500, 10)
                .setValue(Math.min(this.plugin.settings.maxReferencesToProcess, 500))
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.maxReferencesToProcess = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Max cited-by papers')
            .setDesc('Maximum number of citing papers to process')
            .addSlider(slider => slider
                .setLimits(10, 200, 10)
                .setValue(this.plugin.settings.maxCitedByToProcess)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.maxCitedByToProcess = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Zotero folder')
            .setDesc('Folder containing imported papers')
            .addText(text => text
                .setPlaceholder('Papers')
                .setValue(this.plugin.settings.zoteroFolder)
                .onChange(async (value) => {
                    this.plugin.settings.zoteroFolder = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Research hubs folder')
            .setDesc('Folder for all research hub files')
            .addText(text => text
                .setPlaceholder('Research-Hubs')
                .setValue(this.plugin.settings.hubFolder)
                .onChange(async (value) => {
                    this.plugin.settings.hubFolder = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Request delay (ms)')
            .setDesc('Delay between API requests to avoid rate limiting')
            .addSlider(slider => slider
                .setLimits(100, 2000, 50)
                .setValue(this.plugin.settings.delayBetweenRequests)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.delayBetweenRequests = value;
                    await this.plugin.saveSettings();
                }));

        // Graph view section
        new Setting(containerEl)
            .setName('Setup Graph Groups Colors')
            .setDesc('Configure graph view to color-code hubs and papers (works with canvas graphs)')
            .addButton(button => button
                .setButtonText('Setup Graph Groups Colors')
                .setClass('mod-cta')
                .onClick(async () => {
                    await this.setupGraphGroups();
                }));

        // Notice about Canvas graphs
        containerEl.createEl('div', {
            cls: 'setting-item-description',
            text: '⚠️ Use the "Setup Graph Groups Colors" button above to know detailed instruction.'
        });

        // Instructions section
        containerEl.createEl('h3', { text: 'Quick Start Guide' });
        
        const instructions = containerEl.createEl('div', { cls: 'setting-item-description' });
        instructions.innerHTML = `
            <strong>1. Setup:</strong> Set your Zotero folder path and hub folder path above.<br>
            <strong>2. Import:</strong> Import papers from Zotero to your designated folder.<br>
            <strong>3. Process:</strong> Use Ctrl/Cmd+P → "Process current file" or enable auto-processing.<br>
            <strong>4. Explore:</strong> Check the Research-Hubs folder for citation networks.<br>
            <strong>5. Graph:</strong> Use Obsidian's Graph View to visualize connections.<br><br>
            <strong>Commands available:</strong><br>
            • Process current file with OpenAlex<br>
            • Process all unprocessed papers<br>
            • Toggle auto-processing<br><br>
            <strong>Hub Features:</strong><br>
            • Parent Paper: Links back to your Zotero note<br>
            • Cited: Papers this work references<br>
            • Cited By: Papers that cite this work<br>
            • Connected Papers: Other papers in your vault<br>
        `;
    }
}

module.exports = OpenAlexResearchAssistant;