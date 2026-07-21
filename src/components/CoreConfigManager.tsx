import React, { useState, useEffect } from 'react';
import { 
  FileText, 
  Shield, 
  Server, 
  Save, 
  Plus, 
  Trash2, 
  CheckCircle2, 
  AlertTriangle, 
  RefreshCw, 
  Settings, 
  Activity, 
  Terminal, 
  Puzzle, 
  Sparkles, 
  Cpu, 
  Database,
  Lock,
  ChevronRight,
  Upload
} from 'lucide-react';

interface CoreConfigManagerProps {
  onAddLog: (log: string) => void;
}

export default function CoreConfigManager({ onAddLog }: CoreConfigManagerProps) {
  const [activeSubTab, setActiveSubTab] = useState<'FILES' | 'SKILLS' | 'MCP'>('FILES');

  // Core Files States
  const [selectedCoreFile, setSelectedCoreFile] = useState<'soul.md' | 'persona.md' | 'user.md' | 'memory.md'>('soul.md');
  const [coreFilesContent, setCoreFilesContent] = useState({
    'soul.md': '',
    'persona.md': '',
    'user.md': '',
    'memory.md': ''
  });
  const [isEditingFile, setIsEditingFile] = useState(false);
  const [editedContent, setEditedContent] = useState('');
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [savingFile, setSavingFile] = useState(false);

  // File Import Profile States
  const [importTarget, setImportTarget] = useState<'soul.md' | 'persona.md' | 'user.md' | 'memory.md'>('soul.md');
  const [isDragging, setIsDragging] = useState(false);
  const [importMessage, setImportMessage] = useState<{ type: 'success' | 'err'; text: string } | null>(null);

  // Skills States
  const [skills, setSkills] = useState<{ id: string; name: string; description: string; status: string; creator: string }[]>([]);
  const [newSkillName, setNewSkillName] = useState('');
  const [newSkillDesc, setNewSkillDesc] = useState('');
  const [loadingSkills, setLoadingSkills] = useState(false);

  // MCP States
  const [mcpServers, setMcpServers] = useState<{ id: string; name: string; url: string; status: string; resources: number }[]>([]);
  const [newMcpName, setNewMcpName] = useState('');
  const [newMcpUrl, setNewMcpUrl] = useState('');
  const [loadingMcp, setLoadingMcp] = useState(false);

  // Status logs
  const [opMessage, setOpMessage] = useState<{ type: 'success' | 'err'; text: string } | null>(null);

  // Parse and upload imported profile configs
  const handleUploadedFile = async (file: File) => {
    setImportMessage(null);
    try {
      let targetFile = importTarget;
      const lowerName = file.name.toLowerCase();
      
      // Auto-detect target file from name if recognized
      if (lowerName.includes('soul')) targetFile = 'soul.md';
      else if (lowerName.includes('persona')) targetFile = 'persona.md';
      else if (lowerName.includes('user')) targetFile = 'user.md';
      else if (lowerName.includes('memory')) targetFile = 'memory.md';

      const fileText = await file.text();
      
      const res = await fetch('/api/save-assistant-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: targetFile, content: fileText })
      });
      const data = await res.json();
      if (res.ok) {
        setImportMessage({ type: 'success', text: `Loaded and synchronized ${targetFile} successfully!` });
        onAddLog(`[${((Date.now() % 100000)/1000).toFixed(3)}s] IMPORT: Hot-reloaded AI agent config file '${targetFile}' successfully via external upload.`);
        // Sync selected file to reload editor view with the uploaded data
        setSelectedCoreFile(targetFile);
        fetchCoreFiles();
      } else {
        setImportMessage({ type: 'err', text: data.error || 'Upload failed.' });
      }
    } catch (err: any) {
      setImportMessage({ type: 'err', text: `Import error: ${err.message}` });
    }
  };

  // Fetch core assistant files
  const fetchCoreFiles = async () => {
    setLoadingFiles(true);
    try {
      const res = await fetch('/api/assistant-files');
      if (res.ok) {
        const data = await res.json();
        setCoreFilesContent({
          'soul.md': data.soul || '',
          'persona.md': data.persona || '',
          'user.md': data.user || '',
          'memory.md': data.memory || ''
        });
        setEditedContent(data[selectedCoreFile.replace('.md', '')] || '');
      }
    } catch (err: any) {
      console.error(err);
      onAddLog(`[${((Date.now() % 100000)/1000).toFixed(3)}s] ERR: Failed to fetch core settings files.`);
    } finally {
      setLoadingFiles(false);
    }
  };

  // Fetch Skills list
  const fetchSkills = async () => {
    setLoadingSkills(true);
    try {
      const res = await fetch('/api/skills');
      if (res.ok) {
        const data = await res.json();
        setSkills(data.skills);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingSkills(false);
    }
  };

  // Fetch MCP list
  const fetchMcp = async () => {
    setLoadingMcp(true);
    try {
      const res = await fetch('/api/mcp-servers');
      if (res.ok) {
        const data = await res.json();
        setMcpServers(data.mcpServers);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingMcp(false);
    }
  };

  useEffect(() => {
    fetchCoreFiles();
    fetchSkills();
    fetchMcp();
  }, []);

  // Sync edits when file selection is updated
  useEffect(() => {
    const key = selectedCoreFile.replace('.md', '') as keyof typeof coreFilesContent;
    setEditedContent(coreFilesContent[selectedCoreFile] || '');
    setOpMessage(null);
  }, [selectedCoreFile, coreFilesContent]);

  // Handle Save File Changes
  const handleSaveFile = async () => {
    setSavingFile(true);
    setOpMessage(null);
    try {
      const res = await fetch('/api/save-assistant-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: selectedCoreFile, content: editedContent })
      });
      const data = await res.json();
      if (res.ok) {
        setOpMessage({ type: 'success', text: data.detail || 'Changes successfully integrated.' });
        setCoreFilesContent(prev => ({
          ...prev,
          [selectedCoreFile]: editedContent
        }));
        onAddLog(`[${((Date.now() % 100000)/1000).toFixed(3)}s] SYS: Persisted and synchronized metadata changes in '${selectedCoreFile}'.`);
        setIsEditingFile(false);
      } else {
        setOpMessage({ type: 'err', text: data.error || 'Write error.' });
      }
    } catch (err: any) {
      setOpMessage({ type: 'err', text: `Connection exception: ${err.message}` });
    } finally {
      setSavingFile(false);
    }
  };

  // Handle Toggle Skill Activation
  const handleToggleSkill = async (id: string, name: string) => {
    try {
      const res = await fetch('/api/skills/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      });
      if (res.ok) {
        const data = await res.json();
        setSkills(data.skills);
        const action = data.skills.find((s: any) => s.id === id)?.status;
        onAddLog(`[${((Date.now() % 100000)/1000).toFixed(3)}s] SYS: Skill [${name}] changed status to [${action}].`);
      }
    } catch (err) {
      console.error(err);
    }
  };

  // Handle Register custom Skill
  const handleRegisterSkill = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSkillName || !newSkillDesc) return;
    try {
      const res = await fetch('/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newSkillName, description: newSkillDesc })
      });
      if (res.ok) {
        const data = await res.json();
        setSkills(data.skills);
        onAddLog(`[${((Date.now() % 100000)/1000).toFixed(3)}s] SYS: Instantiated new custom operational skill: "${newSkillName}".`);
        setNewSkillName('');
        setNewSkillDesc('');
      }
    } catch (err) {
      console.error(err);
    }
  };

  // Handle Connect new MCP Link
  const handleConnectMcp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMcpName || !newMcpUrl) return;
    try {
      const res = await fetch('/api/mcp-servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newMcpName, url: newMcpUrl })
      });
      if (res.ok) {
        const data = await res.json();
        setMcpServers(data.mcpServers);
        onAddLog(`[${((Date.now() % 100000)/1000).toFixed(3)}s] SYS: Established Model Context Protocol integration with: ${newMcpName}.`);
        setNewMcpName('');
        setNewMcpUrl('');
      }
    } catch (err) {
      console.error(err);
    }
  };

  // Handle Delete MCP Link
  const handleDeleteMcp = async (id: string, name: string) => {
    try {
      const res = await fetch(`/api/mcp-servers/${id}`, {
        method: 'DELETE'
      });
      if (res.ok) {
        const data = await res.json();
        setMcpServers(data.mcpServers);
        onAddLog(`[${((Date.now() % 100000)/1000).toFixed(3)}s] SYS: Severed Model Context Protocol connection for server and associated tools: "${name}".`);
      }
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div id="core-personality-hub" className="space-y-6 font-mono text-xs">
      
      {/* 1. Header description */}
      <div className="bg-[#0e0e0e] border border-gray-900 p-4 rounded-xl flex items-start gap-4">
        <div className="bg-[#00ff41]/10 p-2 rounded-lg border border-[#00ff41]/20">
          <Settings className="w-6 h-6 text-[#00ff41]" />
        </div>
        <div>
          <h3 className="text-sm font-bold text-white uppercase tracking-tight">Cardinal Frame Assistant Core Settings</h3>
          <p className="text-xs text-gray-400 mt-1 leading-relaxed">
            Manage the deep psychological, behavioral, memory, and utility layers of your Cardinal Frame agent instance. Customize soul values, skills tools, and model context server bindings that influence active multi-agent execution loops.
          </p>
        </div>
      </div>

      {/* 2. Sub tab selection tabs */}
      <div className="flex border-b border-gray-900 bg-black/40 rounded-t-lg overflow-hidden">
        <button
          onClick={() => setActiveSubTab('FILES')}
          className={`flex-1 py-3 px-4 font-bold border-r border-gray-900 text-center transition ${
            activeSubTab === 'FILES' ? 'bg-[#00ff41]/10 text-[#00ff41] border-b-2 border-b-[#00ff41]' : 'text-gray-400 hover:text-white hover:bg-zinc-950'
          }`}
        >
          <div className="flex items-center justify-center gap-1.5 uppercase tracking-wider">
            <FileText className="w-3.5 h-3.5" />
            Core Assistant Files (soul / memory)
          </div>
        </button>
        <button
          onClick={() => setActiveSubTab('SKILLS')}
          className={`flex-1 py-3 px-4 font-bold border-r border-gray-900 text-center transition ${
            activeSubTab === 'SKILLS' ? 'bg-[#00ff41]/10 text-[#00ff41] border-b-2 border-b-[#00ff41]' : 'text-gray-400 hover:text-white hover:bg-zinc-950'
          }`}
        >
          <div className="flex items-center justify-center gap-1.5 uppercase tracking-wider">
            <Puzzle className="w-3.5 h-3.5 font-bold" />
            Active Skills Registry
          </div>
        </button>
        <button
          onClick={() => setActiveSubTab('MCP')}
          className={`flex-1 py-3 px-4 font-bold text-center transition ${
            activeSubTab === 'MCP' ? 'bg-[#00ff41]/10 text-[#00ff41] border-b-2 border-b-[#00ff41]' : 'text-gray-400 hover:text-white hover:bg-zinc-950'
          }`}
        >
          <div className="flex items-center justify-center gap-1.5 uppercase tracking-wider">
            <Server className="w-3.5 h-3.5" />
            Model Context Protocol (MCP)
          </div>
        </button>
      </div>

      {/* 3. Panel Body Dynamic Views */}
      <div className="bg-[#0b0e14] border border-gray-900 border-t-0 p-5 rounded-b-xl min-h-[400px]">
        
        {/* VIEW 1: ASSISTANT CORE FILES EDITOR */}
        {activeSubTab === 'FILES' && (
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
            
            {/* Sidebar list profiles selectors */}
            <div className="space-y-2">
              <span className="block text-[10px] text-gray-500 font-bold uppercase tracking-widest mb-2">Core Files Selector</span>
              
              {[
                { name: 'soul.md', label: 'Soul Core', desc: 'Purpose & Philosophy directives', color: 'text-rose-400' },
                { name: 'persona.md', label: 'Persona Profile', desc: 'Style format, conversational voice', color: 'text-yellow-400' },
                { name: 'user.md', label: 'Host Context', desc: 'Fact registries, master user settings', color: 'text-cyan-400' },
                { name: 'memory.md', label: 'Long term Memory', desc: 'Associative learns & telemetry logs', color: 'text-violet-400' }
              ].map((item) => (
                <button
                  key={item.name}
                  onClick={() => {
                    setSelectedCoreFile(item.name as any);
                    setIsEditingFile(false);
                  }}
                  className={`w-full p-3 rounded-lg border text-left transition ${
                    selectedCoreFile === item.name 
                      ? 'bg-zinc-900/60 border-emerald-500/50 outline-none shadow-md' 
                      : 'bg-black/30 border-gray-950 hover:bg-black/60 hover:border-zinc-800'
                  }`}
                >
                  <div className="flex items-center justify-between font-bold">
                    <span className="flex items-center gap-1.5 text-[11px] text-gray-200 uppercase tracking-tight">
                      <FileText className={`w-3.5 h-3.5 ${item.color}`} />
                      {item.label}
                    </span>
                    <span className="text-[8px] bg-black px-1.5 py-0.5 rounded text-gray-600 font-mono">
                      {item.name}
                    </span>
                  </div>
                  <span className="block text-[10px] text-gray-500 mt-1">{item.desc}</span>
                </button>
              ))}

              <div className="bg-black/40 p-3 rounded-lg border border-gray-950 mt-4 text-[10px] text-gray-500 font-sans leading-relaxed">
                <Lock className="w-3.5 h-3.5 inline mr-1 text-emerald-400" />
                These direct configurations are referenced on every simulated and live multi-agent execution thread to keep behavior accurate to your instructions.
              </div>

              {/* AUTOMATED WORKSPACE PROFILE RELOADER */}
              <div className="mt-4 border border-[#2d2f39] bg-gradient-to-tr from-black via-[#0b1016]/40 to-black p-3.5 rounded-xl space-y-3 shadow-md">
                <div className="flex items-center gap-1.5 justify-between">
                  <span className="text-[10px] text-gray-200 font-bold uppercase tracking-wider flex items-center gap-1">
                    <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                    Core Profile Import Reloader
                  </span>
                  <span className="text-[8px] bg-amber-950/60 text-amber-400 px-1.5 py-0.5 rounded font-bold uppercase font-mono tracking-widest animate-pulse">
                    RELOAD AI
                  </span>
                </div>
                
                <p className="text-[10px] text-gray-500 font-sans leading-normal">
                  Drop custom markdown or configuration text to bulk-hotload variables into the active simulation models.
                </p>

                {importMessage && (
                  <div className={`p-2 border rounded text-[10px] leading-snug font-mono ${
                    importMessage.type === 'success' 
                      ? 'bg-emerald-950/25 border-emerald-900/60 text-emerald-400' 
                      : 'bg-rose-950/25 border-rose-900/60 text-rose-400'
                  }`}>
                    {importMessage.text}
                  </div>
                )}

                <div className="space-y-1">
                  <label className="block text-[8px] text-gray-400 uppercase tracking-widest font-bold">Import Target Slot:</label>
                  <select
                    value={importTarget}
                    onChange={(e) => setImportTarget(e.target.value as any)}
                    className="w-full bg-black border border-gray-900 rounded p-1.5 text-[10px] text-gray-300 outline-none focus:border-amber-400"
                  >
                    <option value="soul.md">Soul Core (soul.md)</option>
                    <option value="persona.md">Persona Voice (persona.md)</option>
                    <option value="user.md">Host Context Fact (user.md)</option>
                    <option value="memory.md">Long-Term Memory (memory.md)</option>
                  </select>
                </div>

                <div
                  onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                  onDragLeave={() => setIsDragging(false)}
                  onDrop={async (e) => {
                    e.preventDefault();
                    setIsDragging(false);
                    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
                      await handleUploadedFile(e.dataTransfer.files[0]);
                    }
                  }}
                  className={`border border-dashed p-3 rounded-lg text-center transition cursor-pointer ${
                    isDragging ? 'border-amber-400 bg-amber-950/15' : 'border-zinc-800 bg-zinc-950/65 hover:border-zinc-700'
                  }`}
                >
                  <input
                    type="file"
                    id="personality-file-import-input"
                    accept=".md,.txt,.json"
                    onChange={async (e) => {
                      if (e.target.files && e.target.files[0]) {
                        await handleUploadedFile(e.target.files[0]);
                      }
                    }}
                    className="hidden"
                  />
                  <label
                    htmlFor="personality-file-import-input"
                    className="cursor-pointer flex flex-col items-center gap-1.5"
                  >
                    <Upload className="w-4 h-4 text-amber-500 animate-bounce" />
                    <span className="text-[10px] text-gray-300 font-bold hover:text-amber-400">
                      Browse Local Document
                    </span>
                    <span className="text-[9px] text-gray-600 font-sans block mt-0.5">
                      or drag & drop here
                    </span>
                  </label>
                </div>

              </div>
            </div>

            {/* Editing Workboard Canvas */}
            <div className="lg:col-span-3 bg-black/40 border border-gray-950 p-4 rounded-xl flex flex-col justify-between">
              
              <div className="space-y-4 flex-1 flex flex-col">
                <div className="flex items-center justify-between border-b border-gray-900 pb-3">
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
                    <h4 className="text-xs font-bold text-white uppercase tracking-wider">
                      File Sandbox: <strong className="text-[#00ff41]">{selectedCoreFile}</strong>
                    </h4>
                  </div>

                  <div className="flex items-center gap-2">
                    {isEditingFile ? (
                      <>
                        <button
                          onClick={handleSaveFile}
                          disabled={savingFile}
                          className="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-[10px] rounded flex items-center gap-1 transition"
                        >
                          <Save className="w-3 h-3" />
                          {savingFile ? 'Syncing...' : 'Save & Sync'}
                        </button>
                        <button
                          onClick={() => {
                            setIsEditingFile(false);
                            setEditedContent(coreFilesContent[selectedCoreFile]);
                          }}
                          className="px-2 py-1 bg-zinc-900 border border-gray-800 text-gray-400 hover:text-white text-[10px] rounded"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => setIsEditingFile(true)}
                        className="px-3 py-1 bg-[#00ff41] hover:bg-[#00cc33] text-black font-bold text-[10px] rounded transition"
                      >
                        Edit Document Content
                      </button>
                    )}
                  </div>
                </div>

                {/* Status operations message alerts */}
                {opMessage && (
                  <div className={`p-2.5 border rounded flex items-start gap-2 ${
                    opMessage.type === 'success' 
                      ? 'bg-emerald-950/20 border-emerald-900/60 text-emerald-400' 
                      : 'bg-rose-950/20 border-rose-900/60 text-rose-400'
                  }`}>
                    {opMessage.type === 'success' ? (
                      <CheckCircle2 className="w-4 h-4 shrink-0" />
                    ) : (
                      <AlertTriangle className="w-4 h-4 shrink-0" />
                    )}
                    <span className="text-[10px] leading-tight font-mono">{opMessage.text}</span>
                  </div>
                )}

                {/* Editor form canvas area */}
                <div className="flex-1 flex flex-col min-h-[220px]">
                  {loadingFiles ? (
                    <div className="flex-1 flex flex-col items-center justify-center text-gray-600 space-y-2">
                      <RefreshCw className="w-8 h-8 animate-spin text-gray-700" />
                      <span>Reading physical workspace descriptors...</span>
                    </div>
                  ) : isEditingFile ? (
                    <textarea
                      value={editedContent}
                      onChange={(e) => setEditedContent(e.target.value)}
                      className="w-full flex-1 bg-black/60 border border-gray-900 rounded-lg p-3 font-mono text-[11px] leading-relaxed text-gray-200 focus:border-emerald-500/80 focus:ring-1 focus:ring-emerald-500 outline-none resize-none min-h-[260px]"
                      placeholder="# Markdown file content..."
                    />
                  ) : (
                    <div className="w-full flex-1 bg-black/30 border border-gray-900/60 rounded-lg p-4 font-mono text-[11px] leading-relaxed text-gray-300 max-h-[300px] overflow-y-auto whitespace-pre-wrap select-text">
                      {coreFilesContent[selectedCoreFile] ? coreFilesContent[selectedCoreFile] : (
                        <span className="text-gray-600 font-sans italic">Core File is currently empty or has not been synchronized on the platform yet. Click Edit to define configuration parameters.</span>
                      )}
                    </div>
                  )}
                </div>
              </div>

              <div className="mt-3 text-[9px] text-gray-600 flex justify-between items-center border-t border-gray-900/60 pt-3">
                <span>Core Path: <strong className="text-gray-500">/{selectedCoreFile}</strong></span>
                <span>Encoding: UTF-8 standard markdown files</span>
              </div>
            </div>

          </div>
        )}

        {/* VIEW 2: ACTIVE SKILLS HUB */}
        {activeSubTab === 'SKILLS' && (
          <div className="space-y-6">
            
            {/* Introductory header info details */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              
              {/* Skill creation submission layout */}
              <div className="bg-[#0e1118]/80 border border-gray-900 p-4 rounded-xl flex flex-col justify-between">
                <div>
                  <span className="block text-[10px] text-emerald-400 font-bold uppercase tracking-wider mb-2">Instantiate Custom Skill</span>
                  <p className="text-[10px] text-gray-500 leading-normal font-sans mb-4">
                    Register a custom tool definition or system assembly. Live models can bind tool schema commands dynamically.
                  </p>

                  <form onSubmit={handleRegisterSkill} className="space-y-3">
                    <div>
                      <label className="block text-[8px] text-gray-500 uppercase tracking-widest mb-1">Skill Identifier / Name</label>
                      <input
                        type="text"
                        required
                        placeholder="e.g. WebSearchEngine-Platform"
                        value={newSkillName}
                        onChange={(e) => setNewSkillName(e.target.value)}
                        className="w-full bg-black/40 border border-gray-900 rounded px-2.5 py-1.5 text-[11px] text-gray-200 outline-none focus:border-emerald-500"
                      />
                    </div>

                    <div>
                      <label className="block text-[8px] text-gray-500 uppercase tracking-widest mb-1">Functional Description</label>
                      <textarea
                        required
                        placeholder="Explains what this plugin performs, variables schema inputs and returns..."
                        value={newSkillDesc}
                        onChange={(e) => setNewSkillDesc(e.target.value)}
                        className="w-full bg-black/40 border border-gray-900 rounded p-2 text-[10px] text-gray-200 outline-none focus:border-emerald-500 h-16 resize-none"
                      />
                    </div>

                    <button
                      type="submit"
                      className="w-full bg-[#00ff41] hover:bg-[#00cc33] text-black font-bold text-[11px] py-2 rounded transition flex items-center justify-center gap-1 font-mono uppercase"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      Register New Skill
                    </button>
                  </form>
                </div>
              </div>

              {/* Skills list table catalog */}
              <div className="lg:col-span-2 space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-[10px] text-gray-500 font-bold uppercase tracking-widest">Active Tool Skills Checklist ({skills.length})</span>
                  {loadingSkills && <RefreshCw className="w-3.5 h-3.5 animate-spin text-emerald-400" />}
                </div>

                <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
                  {skills.length === 0 ? (
                    <div className="text-gray-600 text-center py-6">No active tools in context. Register a custom skill.</div>
                  ) : (
                    skills.map((sk) => (
                      <div key={sk.id} className="p-3 bg-black/40 border border-gray-900 rounded-lg flex items-start justify-between gap-4 hover:border-emerald-500/20 transition">
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-white tracking-tight">{sk.name}</span>
                            <span className={`text-[8px] px-1.5 py-0.5 rounded cursor-pointer font-bold ${
                              sk.status === 'Enabled' 
                                ? 'bg-emerald-950/60 text-[#00ff41] border border-emerald-900/60' 
                                : 'bg-red-950/60 text-red-400 border border-red-900/60'
                            }`}
                            onClick={() => handleToggleSkill(sk.id, sk.name)}
                            title="Click to toggle Enabled/Disabled"
                            >
                              ● {sk.status}
                            </span>
                          </div>
                          <p className="text-[10px] text-gray-400 leading-normal">{sk.description}</p>
                          <div className="text-[8px] text-gray-600">Creator Role: {sk.creator}</div>
                        </div>

                        <button
                          onClick={() => handleToggleSkill(sk.id, sk.name)}
                          className="px-2 py-1 bg-black border border-gray-800 hover:bg-zinc-900 text-gray-400 text-[9px] rounded whitespace-nowrap"
                        >
                          Toggle State
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>

            </div>

          </div>
        )}

        {/* VIEW 3: MODEL CONTEXT PROTOCOL PORTAL */}
        {activeSubTab === 'MCP' && (
          <div className="space-y-6">
            
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              
              {/* MCP connection form */}
              <div className="bg-[#0e1118]/80 border border-gray-900 p-4 rounded-xl flex flex-col justify-between">
                <div>
                  <span className="block text-[10px] text-cyan-400 font-bold uppercase tracking-wider mb-2">Connect MCP Protocol Source</span>
                  <p className="text-[10px] text-gray-500 leading-normal font-sans mb-4">
                    Expose external file-system contexts, local Postgres structures, or third-party Git credentials using standardized Model Context Protocol.
                  </p>

                  <form onSubmit={handleConnectMcp} className="space-y-3">
                    <div>
                      <label className="block text-[8px] text-gray-500 uppercase tracking-widest mb-1">Server Friendly IdentifierName</label>
                      <input
                        type="text"
                        required
                        placeholder="e.g. Local-Postgres-Schema"
                        value={newMcpName}
                        onChange={(e) => setNewMcpName(e.target.value)}
                        className="w-full bg-black/40 border border-gray-900 rounded px-2.5 py-1.5 text-[11px] text-gray-200 outline-none focus:border-cyan-400"
                      />
                    </div>

                    <div>
                      <label className="block text-[8px] text-gray-500 uppercase tracking-widest mb-1">MCP SSE Connection URL</label>
                      <input
                        type="url"
                        required
                        placeholder="http://localhost:3020/mcp"
                        value={newMcpUrl}
                        onChange={(e) => setNewMcpUrl(e.target.value)}
                        className="w-full bg-black/40 border border-gray-900 rounded px-2.5 py-1.5 text-[11px] text-gray-200 outline-none focus:border-cyan-400"
                      />
                    </div>

                    <button
                      type="submit"
                      className="w-full bg-cyan-500 hover:bg-cyan-400 text-black font-bold text-[11px] py-2 rounded transition flex items-center justify-center gap-1 font-mono uppercase"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      Establish Server Hook
                    </button>
                  </form>
                </div>
              </div>

              {/* MCP list details */}
              <div className="lg:col-span-2 space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-[10px] text-gray-500 font-bold uppercase tracking-widest font-mono">Linked MCP Integrations ({mcpServers.length})</span>
                  {loadingMcp && <RefreshCw className="w-3.5 h-3.5 animate-spin text-cyan-400" />}
                </div>

                <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
                  {mcpServers.length === 0 ? (
                    <div className="text-gray-600 text-center py-6">No MCP servers connected currently. Establish a server hook above.</div>
                  ) : (
                    mcpServers.map((srv) => (
                      <div key={srv.id} className="p-3 bg-black/40 border border-gray-900 rounded-lg flex items-center justify-between gap-4 hover:border-cyan-500/20 transition">
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-white tracking-tight">{srv.name}</span>
                            <span className={`text-[8px] px-1.5 py-0.5 rounded font-bold ${
                              srv.status === 'Active' 
                                ? 'bg-emerald-950/60 text-[#00ff41] border border-emerald-900/60' 
                                : 'bg-red-950/60 text-red-500 border border-red-900/60 animate-pulse'
                            }`}>
                              {srv.status}
                            </span>
                          </div>
                          <code className="block text-[10px] text-cyan-400 tracking-tight font-mono">{srv.url}</code>
                          <div className="text-[8px] text-gray-500">Exposed Context Resources: {srv.resources} tools detected</div>
                        </div>

                        <button
                          onClick={() => handleDeleteMcp(srv.id, srv.name)}
                          className="text-gray-500 hover:text-rose-400 transition ml-2"
                          title="Sever Connection"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>

            </div>

          </div>
        )}

      </div>
    </div>
  );
}
