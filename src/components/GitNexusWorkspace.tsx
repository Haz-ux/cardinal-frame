import React, { useState, useEffect, useRef } from 'react';
import { 
  Folder, 
  FolderOpen, 
  File, 
  Search, 
  Save, 
  Plus, 
  Trash2, 
  Download, 
  ChevronRight, 
  ChevronDown, 
  Code, 
  FileText, 
  RefreshCw, 
  CheckCircle2, 
  AlertCircle,
  X,
  PlusCircle,
  FolderPlus,
  ArrowUpRight,
  Info,
  Terminal,
  Layers,
  Sparkles,
  Database,
  Monitor,
  Play,
  Square,
  Activity,
  Shield,
  HardDrive,
  Key,
  Cpu,
  Zap,
  Check
} from 'lucide-react';

interface FileNode {
  name: string;
  type: 'file' | 'directory';
  path: string;
  size?: number;
  children?: FileNode[];
}

interface GitNexusWorkspaceProps {
  onAddLog: (log: string) => void;
}

// Memory vector schema
interface MemoryRecord {
  id: string;
  fact: string;
  category: string;
  importance: number; // 1-10
  timestamp: string;
  associations: string[];
}

const initialTree: FileNode[] = [
  { name: '.env.example', type: 'file', path: '.env.example', size: 210 },
  { name: '.gitignore', type: 'file', path: '.gitignore', size: 145 },
  { name: 'index.html', type: 'file', path: 'index.html', size: 512 },
  { name: 'metadata.json', type: 'file', path: 'metadata.json', size: 280 },
  { name: 'package.json', type: 'file', path: 'package.json', size: 1024 },
  { name: 'server.ts', type: 'file', path: 'server.ts', size: 2048 },
  { name: 'soul.md', type: 'file', path: 'soul.md', size: 3840 },
  {
    name: 'src',
    type: 'directory',
    path: 'src',
    children: [
      { name: 'App.tsx', type: 'file', path: 'src/App.tsx', size: 76683 },
      { name: 'types.ts', type: 'file', path: 'src/types.ts', size: 2980 },
      { name: 'index.css', type: 'file', path: 'src/index.css', size: 1240 },
      { name: 'main.tsx', type: 'file', path: 'src/main.tsx', size: 450 },
      {
        name: 'components',
        type: 'directory',
        path: 'src/components',
        children: [
          { name: 'DAGBuilder.tsx', type: 'file', path: 'src/components/DAGBuilder.tsx', size: 86133 },
          { name: 'GitNexusWorkspace.tsx', type: 'file', path: 'src/components/GitNexusWorkspace.tsx', size: 62820 },
          { name: 'NPUMonitor.tsx', type: 'file', path: 'src/components/NPUMonitor.tsx', size: 15400 },
          { name: 'NetworkProfiler.tsx', type: 'file', path: 'src/components/NetworkProfiler.tsx', size: 9800 },
          { name: 'CodeExporter.tsx', type: 'file', path: 'src/components/CodeExporter.tsx', size: 12400 },
          { name: 'CronScheduler.tsx', type: 'file', path: 'src/components/CronScheduler.tsx', size: 14200 },
          { name: 'CoreConfigManager.tsx', type: 'file', path: 'src/components/CoreConfigManager.tsx', size: 19100 },
          { name: 'MessengerBridge.tsx', type: 'file', path: 'src/components/MessengerBridge.tsx', size: 18400 }
        ]
      }
    ]
  }
];

export default function GitNexusWorkspace({ onAddLog }: GitNexusWorkspaceProps) {
  const [workspaceActiveSubTab, setWorkspaceActiveSubTab] = useState<'ide' | 'docker' | 'memory' | 'hardware'>('ide');
  const [explorerMode, setExplorerMode] = useState<'traditional' | 'neural'>('neural');
  
  // Files tree states initialized with physical repository structure preview for instant neural representation
  const [filesTree, setFilesTree] = useState<FileNode[]>(initialTree);
  const [loadingTree, setLoadingTree] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  
  // Expanded directories tracking
  const [expandedDirs, setExpandedDirs] = useState<{ [key: string]: boolean }>({
    'src': true,
    'src/components': true
  });
  
  // Active selected file details
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [loadingFileContent, setLoadingFileContent] = useState(false);
  const [savingFile, setSavingFile] = useState(false);
  const [isDirty, setIsDirty] = useState(false);

  // Creating files/folders helpers
  const [showCreateModal, setShowCreateModal] = useState<'file' | 'folder' | null>(null);
  const [newItemName, setNewItemName] = useState('');
  const [newItemPath, setNewItemPath] = useState('');
  const [notification, setNotification] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // DOCKER / SANDBOX STATES
  const [dockerContainers, setDockerContainers] = useState([
    { id: 'cardinal-core', name: 'cardinal-agent-nexus-1', image: 'cardinal-compiler-node:20-alpine', status: 'RUNNING', cpu: '0.4%', ram: '142MB / 512MB', uptime: '1h 14m' },
    { id: 'redis-cache', name: 'cardinal-cache-ring', image: 'redis:7.2-alpine', status: 'RUNNING', cpu: '0.1%', ram: '14MB / 128MB', uptime: '1h 14m' },
    { id: 'vector-db', name: 'cardinal-vector-embedded', image: 'pgvector/pgvector:latest', status: 'STANDBY', cpu: '0.0%', ram: '0MB / 256MB', uptime: 'Off' }
  ]);
  const [activeSandboxScript, setActiveSandboxScript] = useState<string>('soul.md');
  const [sandboxLogs, setSandboxLogs] = useState<string[]>([
    '[SYSTEM] Interactive sandboxed development container initialized.',
    '[SYSTEM] Virtual volumes mapped successfully to local path "/"'
  ]);
  const [isSandboxRunning, setIsSandboxRunning] = useState(false);
  const terminalLogEndRef = useRef<HTMLDivElement>(null);

  // ADVANCED AI MEMORY STATES
  const [memorySearch, setMemorySearch] = useState('');
  const [newMemoryFact, setNewMemoryFact] = useState('');
  const [newMemoryCategory, setNewMemoryCategory] = useState('Persona Instructions');
  const [newMemoryImportance, setNewMemoryImportance] = useState<number>(8);
  const [memoryRecords, setMemoryRecords] = useState<MemoryRecord[]>([
    { id: '1', fact: 'Cardinal Frame handles dynamic multi-agent streaming pipelines with gRPC / ZeroCopy channels', category: 'Architecture', importance: 9, timestamp: '2026-05-25 08:00', associations: ['DAG', 'gRPC'] },
    { id: '2', fact: 'Host prefers respectful human agent conversation structures and single page bento layouts', category: 'User Preference', importance: 10, timestamp: '2026-05-25 08:03', associations: ['UX', 'App.tsx'] },
    { id: '3', fact: 'Local fallback model is configured to Qwen-2.5-Coder-7B running on local Intel/Apple NPU threads', category: 'Infrastructure', importance: 7, timestamp: '2026-05-25 08:05', associations: ['Models', 'NPU'] },
    { id: '4', fact: 'Persistent logs are auto-written to the disk layout directory on interval executions', category: 'Cron Storage', importance: 8, timestamp: '2026-05-25 08:09', associations: ['CronScheduler'] },
  ]);

  // HARDWARE DETECTION STATES
  const [hardwareSpecs, setHardwareSpecs] = useState<{
    cores: number;
    memoryGB: number;
    gpuName: string;
    osName: string;
    hasHardwareAcceleration: boolean;
  }>({
    cores: 8,
    memoryGB: 16,
    gpuName: 'Analyzing hardware...',
    osName: 'Web Sandbox',
    hasHardwareAcceleration: true
  });
  const [detectedAiOptions, setDetectedAiOptions] = useState<{
    tier: 'premium' | 'high' | 'mid' | 'low';
    recommendation: string;
    reason: string;
    possibleModels: string[];
    acceleratorType: 'NPU-Local' | 'GPU-Direct' | 'CPU-Fallback' | 'Cloud-Proxy';
  }>({
    tier: 'high',
    recommendation: 'Hybrid Cloud & Local NPU Execution',
    reason: 'Initial hardware analysis pending.',
    possibleModels: [],
    acceleratorType: 'GPU-Direct'
  });
  const [cloudApiKeyInput, setCloudApiKeyInput] = useState('');
  const [apiKeyStatus, setApiKeyStatus] = useState<'idle' | 'saved'>('idle');
  const [isVerifyingKey, setIsVerifyingKey] = useState(false);
  const [keyConfirmMessage, setKeyConfirmMessage] = useState('');

  // Console timestamp helper
  const consoleTimestamp = () => `[${((Date.now() % 100000) / 1000).toFixed(3)}s]`;

  // Fetch currently loaded API Key status from our backend
  const fetchApiKeyStatus = async () => {
    try {
      const res = await fetch('/api/get-api-key-status');
      if (res.ok) {
        const data = await res.json();
        if (data.hasKey) {
          setCloudApiKeyInput(data.maskedKey || '');
          setApiKeyStatus('saved');
          setKeyConfirmMessage('Status: Connected (Green). Restored from workstation env.');
        }
      }
    } catch (e) {
      console.error("Error reading API key status from express:", e);
    }
  };

  // Dynamically verify and save the cloud API Key
  const handleSaveApiKey = async () => {
    if (!cloudApiKeyInput.trim()) {
      showNotify('error', 'API Key field cannot be left blank!');
      return;
    }
    
    // If it's already saved and not changed, just skip
    if (cloudApiKeyInput.includes('...') && apiKeyStatus === 'saved') {
      showNotify('success', 'Active credentials verified and confirmed!');
      return;
    }

    setIsVerifyingKey(true);
    setKeyConfirmMessage('Connecting to Google API to run verification handshake...');
    onAddLog(`${consoleTimestamp()} WORKSPACE: Dispatched test connection handshake to Google GenAI portals...`);

    try {
      const res = await fetch('/api/save-api-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: cloudApiKeyInput })
      });

      if (res.ok) {
        const data = await res.json();
        setCloudApiKeyInput(data.maskedKey || cloudApiKeyInput);
        setApiKeyStatus('saved');
        setKeyConfirmMessage('Validated! Status: Connected. Workflow proxy unlocked.');
        showNotify('success', 'API Key validated & saved successfully!');
        onAddLog(`${consoleTimestamp()} WORKSPACE: Secure developer Cloud Key verified and registered.`);
      } else {
        const errorData = await res.json().catch(() => ({}));
        const reason = errorData?.error || 'Verification Failed.';
        setApiKeyStatus('idle');
        setKeyConfirmMessage(`❌ ${reason}`);
        showNotify('error', reason);
        onAddLog(`${consoleTimestamp()} WORKSPACE: API Key validation failed: connection rejected.`);
      }
    } catch (e: any) {
      setApiKeyStatus('idle');
      setKeyConfirmMessage(`❌ Handshake error: ${e.message}`);
      showNotify('error', 'Handshake error: ' + e.message);
    } finally {
      setIsVerifyingKey(false);
    }
  };

  // Fetch directory tree from server
  const fetchFilesTree = async () => {
    setLoadingTree(true);
    try {
      const response = await fetch('/api/gitnexus/files');
      if (response.ok) {
        const data = await response.json();
        setFilesTree(data.files || []);
      } else {
        showNotify('error', 'Failed to retrieve workspace filesystem tree.');
      }
    } catch (e: any) {
      showNotify('error', 'Network error reading folders: ' + e.message);
    } finally {
      setLoadingTree(false);
    }
  };

  useEffect(() => {
    fetchFilesTree();
    runHardwareAutodetect();
    fetchApiKeyStatus();
  }, []);

  // Run Real Browser Capabilities scan
  const runHardwareAutodetect = () => {
    try {
      const physicalThreads = navigator.hardwareConcurrency || 8;
      // navigator.deviceMemory is an experimental feature showing approximate RAM in GB
      const memory = (navigator as any).deviceMemory || 16;
      let hostOS = "Web Agent";
      const ua = navigator.userAgent;
      if (ua.includes("Macintosh")) hostOS = "macOS";
      else if (ua.includes("Windows")) hostOS = "Windows Runtime";
      else if (ua.includes("Linux")) hostOS = "Linux Container";

      // Detect GPU using WebGL
      let gpuStr = 'Universal Standard Shader Unit';
      let hasAcc = true;
      try {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
        if (gl) {
          const debugInfo = (gl as any).getExtension('WEBGL_debug_renderer_info');
          if (debugInfo) {
            gpuStr = (gl as any).getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || 'Shared Graphic Acceleration Module';
          }
        }
      } catch (err) {
        gpuStr = 'DirectX/Metal Canvas Accelerator';
      }

      setHardwareSpecs({
        cores: physicalThreads,
        memoryGB: memory,
        gpuName: gpuStr,
        osName: hostOS,
        hasHardwareAcceleration: hasAcc
      });

      // Formulate recommendation based on device capabilities
      // If the device has plenty cores and memory, we can support high-quality local modeling
      let calculatedTier: 'premium' | 'high' | 'mid' | 'low' = 'mid';
      let recText = '';
      let reasonText = '';
      let listModels: string[] = [];
      let accType: 'NPU-Local' | 'GPU-Direct' | 'CPU-Fallback' | 'Cloud-Proxy' = 'GPU-Direct';

      if (physicalThreads >= 12 && memory >= 16) {
        calculatedTier = 'premium';
        recText = 'NPU/GPU Local Core Reasoning Core';
        reasonText = `Dynamic scan detected ${physicalThreads} Hyperthreaded Cores & ${memory}GB memory with ${gpuStr.split(' ')[0]} hardware rendering. Your client workstation has elite hardware to hold advanced model parameters locally offline!`;
        listModels = ['Qwen-2.5-Coder-14B-Instruct-NPU', 'Llama-3-8B-Instruct-GPU', 'DeepSeek-Coder-8B-Local'];
        accType = 'NPU-Local';
      } else if (physicalThreads >= 8 && memory >= 8) {
        calculatedTier = 'high';
        recText = 'Medium-density Local Engine with WebGL Direct GPU Acceleration';
        reasonText = `Identified standard modern chip with ${physicalThreads} host cores and ${memory}GB RAM capacity. Highly suitable for fast 7B local coder parameters with hardware-accel routing!`;
        listModels = ['Qwen-2.5-Coder-7B-NPU', 'Phi-3-Medium-Direct', 'Mistral-7B-Instruct-v0.2'];
        accType = 'GPU-Direct';
      } else if (memory >= 4) {
        calculatedTier = 'mid';
        recText = 'High-Speed Cloud Hybrid with CPU Local Backup';
        reasonText = `Found mid-range device with ${memory}GB system memory. Local execution of heavy LLMs is possible but will experience latency bottlenecks. We strongly recommend Cloud API routes, utilizing CPU for logic mapping schemas only.`;
        listModels = ['Phi-3-Mini-Local', 'Qwen-2.5-Coder-1.5B-Instruct'];
        accType = 'CPU-Fallback';
      } else {
        calculatedTier = 'low';
        recText = 'Cloud Proxy Pipeline (Requires Gemini/OpenAI API Keys)';
        reasonText = `Low capacity browser context detected (${memory}GB RAM, ${physicalThreads} cores). Local modeling would choke browser frames. Direct all requests to server proxies or insert your private developers cloud API keys below.`;
        listModels = ['Gemini-2.5-Flash-Cloud', 'GPT-4o-Mini-Global'];
        accType = 'Cloud-Proxy';
      }

      setDetectedAiOptions({
        tier: calculatedTier,
        recommendation: recText,
        reason: reasonText,
        possibleModels: listModels,
        acceleratorType: accType
      });

    } catch (err) {
      console.warn('Hardware discovery skipped:', err);
    }
  };

  // Run Sandboxed simulator in isolated process
  const triggerDockerSimRun = () => {
    if (isSandboxRunning) return;
    setIsSandboxRunning(true);
    setSandboxLogs(prev => [
      ...prev,
      `\n[DOCKER] Spin up request for sandbox script execution on file: "${activeSandboxScript}"`,
      `[DOCKER] Allocating light host thread container...`,
      `[DOCKER] Mounting file descriptor mapping...`,
      `[NEXUS_DEV] Compiling dependencies list from package.json...`,
    ]);

    // Simulate stdout streams
    let currentIdx = 0;
    const simSteps = [
      `[COMPILE] Linking modules: @google/genai, express, tsx, esbuild`,
      `[DEV_VM] Loading intelligence credentials file: soul.md`,
      `[AI_AGENT] Core active parameters injected. Temperature: 0.20, Model: Qwen-2.5-Coder`,
      `[AI_AGENT] RUN: Processing memory associative nodes... Found ${memoryRecords.length} records in active cluster`,
      `[EXEC_SUCCESS] Exit code: 0, execution duration: 1.15s, memory overhead: ~45MB`,
      `[DOCKER] Container standard process completed and parked safely.`
    ];

    const timer = setInterval(() => {
      if (currentIdx < simSteps.length) {
        setSandboxLogs(prev => [...prev, simSteps[currentIdx]]);
        currentIdx++;
        setTimeout(() => {
          terminalLogEndRef.current?.scrollIntoView({ behavior: 'smooth' });
        }, 50);
      } else {
        clearInterval(timer);
        setIsSandboxRunning(false);
        onAddLog(`${consoleTimestamp()} SANDBOX: Executed custom script "${activeSandboxScript}" inside Docker development engine context.`);
      }
    }, 700);
  };

  // Add Memory Fact Ingestion
  const handleAddMemoryFact = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMemoryFact.trim()) return;

    const newRec: MemoryRecord = {
      id: `mem_${Date.now()}`,
      fact: newMemoryFact.trim(),
      category: newMemoryCategory,
      importance: newMemoryImportance,
      timestamp: new Date().toISOString().replace('T', ' ').substring(0, 16),
      associations: [newMemoryCategory.split(' ')[0], 'DirectUpload']
    };

    setMemoryRecords(prev => [newRec, ...prev]);
    setNewMemoryFact('');
    showNotify('success', `Cognitive Memory Key added and indexed into vector clustering model!`);
    onAddLog(`${consoleTimestamp()} MEMORY: Hot-loaded new semantic associative cluster fact: "${newRec.fact.substring(0, 45)}..."`);
  };

  // Delete Memory Fact
  const handleDeleteMemory = (id: string, text: string) => {
    setMemoryRecords(prev => prev.filter(r => r.id !== id));
    showNotify('success', `Pruned concept record.`);
    onAddLog(`${consoleTimestamp()} MEMORY: Decoupled fact node "${text.substring(0, 30)}..." from vector cognitive clusters.`);
  };

  // Show status notifying overlay helper
  const showNotify = (type: 'success' | 'error', text: string) => {
    setNotification({ type, text });
    setTimeout(() => {
      setNotification(null);
    }, 4000);
  };

  // Toggle directory path node expansion
  const toggleDirectory = (path: string) => {
    setExpandedDirs(prev => ({
      ...prev,
      [path]: !prev[path]
    }));
  };

  // Select a file to read and edit
  const selectFileForEditing = async (path: string) => {
    if (isDirty) {
      const confirmBypass = window.confirm("You have unsaved changes in your current file. Discard changes?");
      if (!confirmBypass) return;
    }
    
    setLoadingFileContent(true);
    setSelectedFilePath(path);
    setIsDirty(false);
    setNotification(null);
    try {
      const response = await fetch(`/api/gitnexus/file?path=${encodeURIComponent(path)}`);
      if (response.ok) {
        const data = await response.json();
        setFileContent(data.content || '');
        setOriginalContent(data.content || '');
        setWorkspaceActiveSubTab('ide'); // Route back to editor view tab
        onAddLog(`${consoleTimestamp()} GITNEXUS: Loaded ${path} safely into memory view.`);
      } else {
        const err = await response.json();
        showNotify('error', err.error || 'Failed to open file.');
      }
    } catch (e: any) {
      showNotify('error', 'Failed to load file content: ' + e.message);
    } finally {
      setLoadingFileContent(false);
    }
  };

  // Save changes to active open file
  const handleSaveWorkspaceFile = async () => {
    if (!selectedFilePath) return;
    setSavingFile(true);
    try {
      const response = await fetch('/api/gitnexus/file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: selectedFilePath,
          content: fileContent
        })
      });
      if (response.ok) {
        setOriginalContent(fileContent);
        setIsDirty(false);
        showNotify('success', `Successfully saved and hot-rebuilt ${selectedFilePath}`);
        onAddLog(`${consoleTimestamp()} GITNEXUS: Saved physical file edits on path '${selectedFilePath}'.`);
        fetchFilesTree(); // Refresh trees sizes
      } else {
        const err = await response.json();
        showNotify('error', err.error || 'Write error occurred.');
      }
    } catch (e: any) {
      showNotify('error', 'Failed to push file changes: ' + e.message);
    } finally {
      setSavingFile(false);
    }
  };

  // Delete file / folder confirmation
  const handleDeleteWorkspaceItem = async (pathToDelete: string, type: 'file' | 'directory') => {
    const confirmDelete = window.confirm(`Are you sure you want to delete this ${type}: "${pathToDelete}"? This cannot be undone.`);
    if (!confirmDelete) return;

    try {
      const response = await fetch('/api/gitnexus/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: pathToDelete })
      });
      if (response.ok) {
        showNotify('success', `Deleted successfully: ${pathToDelete}`);
        onAddLog(`${consoleTimestamp()} GITNEXUS: Removed ${type} '${pathToDelete}' from node package filesystem.`);
        if (selectedFilePath === pathToDelete) {
          setSelectedFilePath(null);
          setFileContent('');
          setOriginalContent('');
          setIsDirty(false);
        }
        fetchFilesTree();
      } else {
        const err = await response.json();
        showNotify('error', err.error || 'Failed to remove target.');
      }
    } catch (e: any) {
      showNotify('error', 'Error sending delete trigger: ' + e.message);
    }
  };

  // Handle creating file or folder
  const handleCreateWorkspaceItem = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newItemName.trim()) return;

    const fullTargetRelativePath = newItemPath 
        ? `${newItemPath}/${newItemName.trim()}` 
        : newItemName.trim();

    try {
      const response = await fetch('/api/gitnexus/file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: fullTargetRelativePath,
          content: showCreateModal === 'file' ? `// New Cardinal Frame file: ${newItemName}\n\n` : ''
        })
      });

      if (response.ok) {
        showNotify('success', `Created ${showCreateModal}: ${fullTargetRelativePath}`);
        onAddLog(`${consoleTimestamp()} GITNEXUS: Created new workspace ${showCreateModal} at path '${fullTargetRelativePath}'.`);
        setShowCreateModal(null);
        setNewItemName('');
        fetchFilesTree();
        if (showCreateModal === 'file') {
          selectFileForEditing(fullTargetRelativePath);
        }
      } else {
        const err = await response.json();
        showNotify('error', err.error || 'Failed to instantiate node.');
      }
    } catch (e: any) {
      showNotify('error', 'Network error creating item: ' + e.message);
    }
  };

  // Open creation modal setting up path context
  const initiateCreate = (type: 'file' | 'folder', parentPath: string = '') => {
    setNewItemPath(parentPath);
    setNewItemName('');
    setShowCreateModal(type);
  };

  // Recursively render directory trees
  const renderTreeNodes = (nodes: FileNode[], depth = 0) => {
    return nodes
      .filter(node => {
        if (!searchQuery) return true;
        return node.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
               (node.children && node.children.some(c => c.name.toLowerCase().includes(searchQuery.toLowerCase())));
      })
      .map((node) => {
        const isDir = node.type === 'directory';
        const isExpanded = expandedDirs[node.path];
        const isSelected = selectedFilePath === node.path;

        return (
          <div key={node.path} className="select-none font-mono">
            <div 
              style={{ paddingLeft: `${depth * 10 + 6}px` }}
              className={`group flex items-center justify-between py-1.5 pr-2 rounded text-xs transition duration-150 cursor-pointer my-0.5 ${
                isSelected 
                  ? 'bg-emerald-950/45 border-l-2 border-emerald-400 text-[#00ff41]' 
                  : 'bg-transparent text-gray-400 hover:bg-zinc-900/40 hover:text-white'
              }`}
            >
              <div 
                onClick={() => {
                  if (isDir) {
                    toggleDirectory(node.path);
                  } else {
                    selectFileForEditing(node.path);
                  }
                }}
                className="flex items-center gap-1.5 flex-grow min-w-0"
              >
                {isDir ? (
                  <span className="shrink-0 text-amber-500">
                    {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                  </span>
                ) : (
                  <span className="w-3.5" />
                )}

                {isDir ? (
                  isExpanded ? <FolderOpen className="w-3.5 h-3.5 text-amber-400 shrink-0" /> : <Folder className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                ) : (
                  node.name.endsWith('.md') 
                    ? <FileText className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                    : <Code className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                )}

                <span className="truncate text-[10.5px] font-mono leading-none">{node.name}</span>
              </div>

              {/* Action Buttons */}
              <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                {isDir && (
                  <>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        initiateCreate('file', node.path);
                      }}
                      className="p-0.5 text-gray-500 hover:text-emerald-400"
                      title="New File"
                    >
                      <PlusCircle className="w-3 h-3" />
                    </button>
                  </>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeleteWorkspaceItem(node.path, node.type);
                  }}
                  className="p-0.5 text-gray-600 hover:text-rose-400"
                  title="Delete"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            </div>

            {isDir && isExpanded && node.children && (
              <div className="border-l border-zinc-900 ml-2.5 pl-0.5">
                {renderTreeNodes(node.children, depth + 1)}
              </div>
            )}
          </div>
        );
      });
  };

  const fileExtension = selectedFilePath ? selectedFilePath.split('.').pop() : '';

  return (
    <div id="gitnexus-file-system-workspace" className="space-y-5 text-xs text-gray-300 font-mono relative">
      
      {/* Workspace Banner */}
      <div className="bg-[#0b0e14] border border-gray-950 p-4 rounded-xl flex flex-col xl:flex-row justify-between xl:items-center gap-4">
        <div className="flex items-start gap-4">
          <div className="bg-[#00ff41]/10 p-2 rounded-lg border border-[#00ff41]/20">
            <Layers className="w-5.5 h-5.5 text-[#00ff41]" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[9px] text-[#00ff41] bg-emerald-950 px-1.5 py-0.5 rounded font-bold uppercase tracking-wider">GITNEXUS SUITE</span>
              <span className="text-[9px] text-amber-500 bg-amber-950/60 px-1.5 py-0.5 rounded font-bold uppercase tracking-wider animate-pulse">INTELLIGENT VM</span>
            </div>
            <h3 className="text-xs font-bold text-white uppercase tracking-tight mt-1">
              GitNexus Developer Sandboxed Testing Grounds
            </h3>
            <p className="text-[11px] text-gray-500 mt-0.5 font-sans leading-normal">
              Fully interactive containerized IDE workspace featuring high-contrast file editor, docker process emulation, vector memory clusters, and browser hardware optimization discovery.
            </p>
          </div>
        </div>

        <div className="flex gap-2">
          <button 
            onClick={fetchFilesTree}
            disabled={loadingTree}
            className="px-2.5 py-1 bg-zinc-900 hover:bg-zinc-850 border border-zinc-800 text-gray-300 rounded flex items-center gap-1 transition text-[10px] uppercase cursor-pointer"
          >
            <RefreshCw className={`w-3 h-3 ${loadingTree ? 'animate-spin text-[#00ff41]' : ''}`} />
            Sync Storage
          </button>
          <button 
            onClick={() => initiateCreate('file', '')}
            className="px-2.5 py-1 bg-emerald-700 hover:bg-emerald-600 text-white font-bold rounded flex items-center gap-1 transition text-[10px] uppercase cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            File Ingestion
          </button>
        </div>
      </div>

      {/* Primary Sub-Tab Navifiers */}
      <div className="flex border-b border-gray-900 bg-black/45 p-1 rounded-lg gap-1.5 shrink-0 select-none">
        <button
          onClick={() => setWorkspaceActiveSubTab('ide')}
          className={`px-4 py-2 text-[10px] uppercase tracking-wider font-bold rounded-md transition duration-200 cursor-pointer flex items-center gap-1.5 ${
            workspaceActiveSubTab === 'ide' 
              ? 'bg-[#00ff41]/15 text-[#00ff41] border border-[#00ff41]/30 shadow-[0_0_12px_rgba(0,255,65,0.05)]' 
              : 'text-gray-400 hover:text-white hover:bg-zinc-950'
          }`}
        >
          <Code className="w-3.5 h-3.5" />
          IDE File Workspace
        </button>
        <button
          onClick={() => setWorkspaceActiveSubTab('docker')}
          className={`px-4 py-2 text-[10px] uppercase tracking-wider font-bold rounded-md transition duration-200 cursor-pointer flex items-center gap-1.5 ${
            workspaceActiveSubTab === 'docker' 
              ? 'bg-amber-400/10 text-amber-400 border border-amber-500/30' 
              : 'text-gray-400 hover:text-white hover:bg-zinc-950'
          }`}
        >
          <Terminal className="w-3.5 h-3.5" />
          Docker Development Sandbox
        </button>
        <button
          onClick={() => setWorkspaceActiveSubTab('memory')}
          className={`px-4 py-2 text-[10px] uppercase tracking-wider font-bold rounded-md transition duration-200 cursor-pointer flex items-center gap-1.5 ${
            workspaceActiveSubTab === 'memory' 
              ? 'bg-purple-400/10 text-purple-400 border border-purple-500/30' 
              : 'text-gray-400 hover:text-white hover:bg-zinc-950'
          }`}
        >
          <Database className="w-3.5 h-3.5" />
          AI Long-Term Memory
        </button>
        <button
          onClick={() => setWorkspaceActiveSubTab('hardware')}
          className={`px-4 py-2 text-[10px] uppercase tracking-wider font-bold rounded-md transition duration-200 cursor-pointer flex items-center gap-1.5 ${
            workspaceActiveSubTab === 'hardware' 
              ? 'bg-cyan-400/10 text-cyan-400 border border-cyan-500/30' 
              : 'text-gray-400 hover:text-white hover:bg-zinc-950'
          }`}
        >
          <Monitor className="w-3.5 h-3.5" />
          AI Hardware Consultant
        </button>
      </div>

      {/* TAB CONTAINER 1: THE INTEGRATED DEVS IDE */}
      {workspaceActiveSubTab === 'ide' && (() => {
        // Group files for the interactive Neural Mind Map representation safely
        const getDirectoryGroups = (nodesList: FileNode[]) => {
          const groups: { [key: string]: FileNode[] } = {};
          
          const recurse = (list: FileNode[], parentDir = 'root') => {
            if (!groups[parentDir]) groups[parentDir] = [];
            if (!list || !Array.isArray(list)) return;
            
            list.forEach(node => {
              if (node.type === 'file') {
                groups[parentDir].push(node);
              } else if (node.type === 'directory') {
                const dirName = node.path;
                groups[dirName] = [];
                if (node.children) {
                  recurse(node.children, dirName);
                }
              }
            });
          };

          recurse(nodesList);

          // Prune empty directories ONLY at the very end to prevent mid-traversal deletion
          Object.keys(groups).forEach(key => {
            if (groups[key] && groups[key].length === 0 && key !== 'root') {
              delete groups[key];
            }
          });
          
          return groups;
        };

        const directoryGroups = getDirectoryGroups(filesTree);

        return (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 animate-fade-in text-xs font-mono">
            
            {/* LEFT SIDEBAR: DUAL VIEW FILE EXPLORER (Traditional Tree vs Neural Synapses Map) */}
            <div className="lg:col-span-5 bg-[#0a0d14]/90 border border-[#222] rounded-xl p-4 flex flex-col h-[525px] shadow-[0_4px_24px_rgba(0,0,0,0.6)] relative z-10 transition duration-150">
              <div className="space-y-3.5 mb-3.5 shrink-0 select-none">
                <div className="flex items-center justify-between">
                  <span className="text-[9px] text-[#00ff41] font-mono font-black uppercase tracking-wider">Repository Workspace</span>
                  
                  {/* EXPLORER MODE TOGGLE */}
                  <div className="flex bg-black border border-zinc-850 p-0.5 rounded text-[8px] font-bold">
                    <button
                      type="button"
                      onClick={() => setExplorerMode('neural')}
                      className={`px-2 py-1 rounded transition uppercase ${
                        explorerMode === 'neural' 
                          ? 'bg-[#00ff41]/10 text-[#00ff41] border border-[#00ff41]/20' 
                          : 'text-gray-500 hover:text-gray-300'
                      }`}
                      title="Neural Map mode"
                    >
                      🧠 Neural Map
                    </button>
                    <button
                      type="button"
                      onClick={() => setExplorerMode('traditional')}
                      className={`px-2 py-1 rounded transition uppercase ${
                        explorerMode === 'traditional' 
                          ? 'bg-zinc-900 text-gray-350 border border-zinc-850' 
                          : 'text-gray-500 hover:text-gray-300'
                      }`}
                      title="Traditional Folder Tree mode"
                    >
                      📁 Folders
                    </button>
                  </div>
                </div>

                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-gray-500 absolute left-2.5 top-1.5" />
                  <input
                    type="text"
                    placeholder="Index seek .ts, .json, .md..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full bg-black/65 border border-zinc-900 rounded pl-8 pr-6 py-1 text-xs text-gray-200 outline-none focus:border-[#00ff41]"
                  />
                </div>
              </div>

              {/* DYNAMIC SCENE CONTAINER */}
              <div className="flex-1 overflow-y-auto pr-1">
                {explorerMode === 'traditional' ? (
                  /* ================= Traditional view ================= */
                  <div className="space-y-1">
                    {loadingTree && filesTree.length === 0 ? (
                      <div className="flex flex-col items-center justify-center py-20 text-gray-600 space-y-2">
                        <RefreshCw className="w-4 h-4 animate-spin text-emerald-500" />
                        <span className="text-[10px]">Calling physical descriptors...</span>
                      </div>
                    ) : (
                      renderTreeNodes(filesTree)
                    )}
                  </div>
                ) : (
                  /* ================= NEURAL MIND MAP OF WORKSPACE (Synaptic Dendrite Map as requested) ================= */
                  <div className="space-y-4">
                    <div className="bg-black/60 border border-zinc-900 rounded p-2 text-center text-[9px] font-sans text-emerald-450 leading-tight">
                       ⚡ Each folder groups a <strong>Neuron Core</strong>. Click file capsules below to instantly transmit their bytes directly to the IDE Editor core.
                    </div>

                    <div className="space-y-3.5 max-h-[380px] overflow-y-auto pr-1">
                      {Object.entries(directoryGroups).map(([dir, files]) => {
                        const simpleDirName = dir === 'root' ? '/' : dir + '/';
                        // Filter by search query if any
                        const filteredFiles = files.filter(f => f.name.toLowerCase().includes(searchQuery.toLowerCase()));
                        if (filteredFiles.length === 0 && searchQuery) return null;

                        return (
                          <div 
                            key={dir} 
                            className="bg-black/40 rounded-lg p-3 border border-zinc-900 hover:border-cyan-500/20 transition relative"
                          >
                            {/* Directory Nerve Core Nucleus */}
                            <div className="flex items-center justify-between border-b border-zinc-900/60 pb-1.5 mb-2 select-none">
                              <span className="text-[9.5px] text-cyan-400 font-bold flex items-center gap-1.5 font-mono">
                                <Sparkles className="w-3 h-3 text-cyan-400 animate-pulse" />
                                {simpleDirName}
                              </span>
                              <span className="text-[8px] font-mono bg-[#111] text-gray-500 border border-zinc-850 px-1 py-0.5 rounded">
                                {filteredFiles.length} synapses
                              </span>
                            </div>

                            {/* Floating File Pods Capsules */}
                            <div className="flex flex-wrap gap-1.5">
                              {filteredFiles.map(f => {
                                const isSelected = selectedFilePath === f.path;
                                const isMarkdown = f.name.endsWith('.md');
                                const isJson = f.name.endsWith('.json');
                                
                                let capsStyle = 'border-zinc-850 bg-black text-gray-300 hover:border-[#00ff41] hover:text-white';
                                if (isSelected) {
                                  capsStyle = 'border-[#00ff41] bg-emerald-950/20 text-[#00ff41] ring-1 ring-[#00ff41]/25';
                                } else if (isMarkdown) {
                                  capsStyle = 'border-rose-950/40 text-rose-405 bg-rose-950/10 hover:border-rose-500';
                                } else if (isJson) {
                                  capsStyle = 'border-amber-950/40 text-amber-500 bg-amber-950/10 hover:border-amber-500';
                                }

                                return (
                                  <button
                                    key={f.path}
                                    onClick={() => selectFileForEditing(f.path)}
                                    className={`px-2 py-1.5 rounded-md border text-[9px] font-mono transition text-left flex items-center gap-1.5 cursor-pointer max-w-full truncate ${capsStyle}`}
                                    title={`Synapse payload: ${(f.size || 500).toLocaleString()} bytes`}
                                  >
                                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                      isSelected ? 'bg-[#00ff41]' : isMarkdown ? 'bg-rose-450' : 'bg-cyan-400'
                                    }`} />
                                    <span className="truncate">{f.name}</span>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* RIGHT SIDEBAR: CODE EDITOR AND CONRAD IDE PORTAL */}
            <div className="lg:col-span-7 bg-[#0d0f14] border border-gray-950 rounded-xl p-4 flex flex-col h-[525px] justify-between shadow-2xl relative">
              {selectedFilePath ? (
                <div className="flex-grow flex flex-col justify-between">
                  <div className="flex items-center justify-between border-b border-zinc-900 pb-2.5 mb-2.5 shrink-0 select-none">
                    <div className="flex items-center gap-2">
                      <span className="text-[9px] bg-emerald-950 font-mono text-[#00ff41] px-2 py-0.5 rounded border border-emerald-900/40">CORTEX READ</span>
                      <span className="text-xs font-bold text-white font-mono">{selectedFilePath.split('/').pop()}</span>
                      {isDirty && (
                        <span className="text-[8px] bg-amber-500/15 text-amber-405 border border-amber-500/30 px-1 py-0.5 rounded font-mono font-bold animate-pulse">
                          MODIFIED SYNAPSE
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={handleSaveWorkspaceFile}
                        disabled={savingFile || !isDirty}
                        className={`px-3 py-1 text-[10px] font-bold rounded flex items-center gap-1 transition uppercase cursor-pointer ${
                          isDirty 
                            ? 'bg-[#00ff41] hover:bg-emerald-500 text-black shadow-[0_0_10px_rgba(0,255,65,0.15)]' 
                            : 'bg-zinc-900 text-gray-500 cursor-not-allowed border border-transparent'
                        }`}
                      >
                        <Save className="w-3 h-3" />
                        {savingFile ? 'Syncing...' : 'Sync Disk'}
                      </button>
                      <button
                        onClick={() => {
                          setSelectedFilePath(null);
                          setFileContent('');
                          setIsDirty(false);
                        }}
                        className="px-2 py-1 bg-black border border-gray-900 hover:text-white rounded text-[10px]"
                      >
                        Close
                      </button>
                    </div>
                  </div>

                  <div className="flex-1 flex flex-row border border-gray-950 bg-black/40 rounded-lg overflow-hidden relative min-h-[340px]">
                    <div className="w-8 bg-zinc-950 border-r border-gray-950/60 flex flex-col text-right pr-1.5 pt-2 text-[8px] text-zinc-650 font-mono select-none overflow-hidden leading-snug">
                      {Array.from({ length: fileContent.split('\n').length || 1 }).map((_, idx) => (
                        <div key={idx}>{idx + 1}</div>
                      ))}
                    </div>
                    {loadingFileContent ? (
                      <div className="absolute inset-0 bg-black/80 flex flex-col items-center justify-center text-gray-500 gap-1.5">
                        <RefreshCw className="w-6 h-6 animate-spin text-emerald-500" />
                        <span className="text-[10px]">Reading bytes map safely...</span>
                      </div>
                    ) : (
                      <textarea
                        value={fileContent}
                        onChange={(e) => {
                          setFileContent(e.target.value);
                          setIsDirty(e.target.value !== originalContent);
                        }}
                        className="w-full h-full bg-transparent p-2.5 font-mono text-[11px] leading-snug text-gray-350 outline-none resize-none overflow-y-auto"
                        placeholder="// Insert file script instructions..."
                      />
                    )}
                  </div>
                </div>
              ) : (
                <div className="flex-grow flex flex-col items-center justify-center p-6 text-center text-gray-550 select-none">
                  <Code className="w-10 h-10 text-gray-750 mb-3 animate-pulse" />
                  <h4 className="text-white text-xs font-bold uppercase tracking-wider">Dynamic Workspace Neural Cortex</h4>
                  <p className="text-[11px] text-gray-500 max-w-sm mt-1 mb-4 font-sans leading-relaxed">
                    Select a code file or system descriptor card from the interactive <strong>Synapse Map on the left</strong> to flash editing bytes in this arena instantly.
                  </p>
                  <div className="flex gap-2">
                    <button 
                      onClick={() => selectFileForEditing('soul.md')}
                      className="px-3 py-1.5 bg-black border border-gray-850 hover:border-[#00ff41] text-[10px] text-gray-300 hover:text-white rounded uppercase cursor-pointer"
                    >
                      Load soul.md
                    </button>
                    <button 
                      onClick={() => selectFileForEditing('package.json')}
                      className="px-3 py-1.5 bg-black border border-gray-850 hover:border-[#00ff41] text-[10px] text-gray-300 hover:text-white rounded uppercase cursor-pointer"
                    >
                      Load package.json
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* TAB CONTAINER 2: DOCKER SIMULATED SANDBOX & TEST GRUNDS */}
      {workspaceActiveSubTab === 'docker' && (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-5">
          {/* Virtual Containers Fleet Management */}
          <div className="xl:col-span-5 bg-[#0d0f14] border border-gray-950 p-4 rounded-xl space-y-4">
            <div>
              <span className="text-[9px] text-[#00ff41] bg-emerald-950 font-bold px-1.5 py-0.5 rounded">HYPERVISOR STATUS</span>
              <h4 className="text-xs font-bold text-white uppercase tracking-tight mt-1 flex items-center gap-1.5">
                Cardinal Frame Emulated Container Fleet
              </h4>
              <p className="text-[10px] text-gray-500 font-sans leading-normal">
                Virtual execution processes hosting agent microservices. Halt, start, or balance live resource quotas.
              </p>
            </div>

            <div className="space-y-2.5">
              {dockerContainers.map((container, i) => (
                <div key={container.id} className="bg-black/40 border border-gray-950/80 p-3 rounded-lg flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <div className={`w-1.5 h-1.5 rounded-full ${container.status === 'RUNNING' ? 'bg-[#00ff41] animate-ping' : 'bg-gray-600'}`} />
                      <span className="text-[11px] font-bold text-gray-200">{container.name}</span>
                    </div>
                    <span className={`text-[8px] font-bold px-1.5 py-0.5 rounded font-mono ${
                      container.status === 'RUNNING' ? 'bg-emerald-950/40 text-emerald-400 border border-emerald-900/50' : 'bg-zinc-950 text-gray-400'
                    }`}>
                      {container.status}
                    </span>
                  </div>

                  <div className="grid grid-cols-3 gap-2 text-[9px] font-sans text-gray-500 border-t border-gray-900 pt-2 font-mono">
                    <div>
                      <span className="block text-[7px] text-gray-600 uppercase font-bold font-sans">CPU Share</span>
                      <span className="text-gray-300">{container.cpu}</span>
                    </div>
                    <div>
                      <span className="block text-[7px] text-gray-600 uppercase font-bold font-sans">RAM Occupied</span>
                      <span className="text-gray-300">{container.ram}</span>
                    </div>
                    <div>
                      <span className="block text-[7px] text-gray-600 uppercase font-bold font-sans">Uptime</span>
                      <span className="text-yellow-500">{container.uptime}</span>
                    </div>
                  </div>

                  <div className="flex gap-1.5 pt-1">
                    <button
                      onClick={() => {
                        setDockerContainers(prev => prev.map((c, idx) => idx === i ? { ...c, status: c.status === 'RUNNING' ? 'STOPPED' : 'RUNNING', cpu: '0.0%', ram: '0MB / 256MB' } : c));
                        onAddLog(`${consoleTimestamp()} DOCKER: State shift processed on docker process: ${container.name}`);
                      }}
                      className="text-[9px] px-2 py-0.5 rounded bg-zinc-900 hover:bg-zinc-850 hover:text-white transition cursor-pointer font-bold uppercase"
                    >
                      {container.status === 'RUNNING' ? 'Halt Process' : 'Resume'}
                    </button>
                    <button
                      onClick={() => {
                        setDockerContainers(prev => prev.map((c, idx) => idx === i ? { ...c, cpu: '48%', ram: '110MB / 512MB' } : c));
                        onAddLog(`${consoleTimestamp()} DOCKER: Reboot command triggered on container: ${container.name}`);
                      }}
                      className="text-[9px] px-2 py-0.5 rounded bg-zinc-900 hover:bg-zinc-850 hover:text-white transition cursor-pointer font-bold uppercase"
                    >
                      Reset State
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="bg-black border border-gray-950 rounded p-2.5 text-[10px] space-y-1">
              <span className="text-[8px] font-bold text-amber-500 uppercase tracking-widest block font-serif">Docker Engine Overheads:</span>
              <div className="flex justify-between text-gray-500">
                <span>Core Hypervisor:</span>
                <span className="text-gray-300">Active (WSL-3)</span>
              </div>
              <div className="flex justify-between text-gray-500">
                <span>Storage Cluster:</span>
                <span className="text-gray-300">Mapped Ext4 (1.4 GB)</span>
              </div>
            </div>
          </div>

          {/* Sandboxed VM Terminal Execution Space */}
          <div className="xl:col-span-7 bg-[#0d0f14] border border-gray-950 p-4 rounded-xl flex flex-col justify-between h-[480px]">
            <div className="space-y-3 shrink-0">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-[9px] text-amber-400 bg-amber-950/60 font-bold px-1.5 py-0.5 rounded flex items-center gap-1 w-max">
                    <Terminal className="w-3 h-3 text-amber-400" />
                    SANDBOX COMPILE RIG
                  </span>
                  <h4 className="text-xs font-bold text-white uppercase tracking-tight mt-1">Docker Test Ground Execution Console</h4>
                </div>
              </div>

              <div className="bg-black/60 border border-gray-950 p-3 rounded-lg flex items-center gap-3">
                <div className="flex-1 space-y-1">
                  <label className="block text-[8px] text-gray-500 uppercase tracking-widest font-bold">Isolated Exec Target File:</label>
                  <select
                    value={activeSandboxScript}
                    onChange={(e) => setActiveSandboxScript(e.target.value)}
                    className="w-full bg-black border border-gray-900 rounded p-1.5 text-xs text-gray-300 outline-none focus:border-amber-400"
                  >
                    <option value="soul.md">Soul Personality Guide (soul.md)</option>
                    <option value="persona.md">Voice Custom Definitions (persona.md)</option>
                    <option value="user.md">Host Local Parameter Profile (user.md)</option>
                    <option value="package.json">Package Dependency Config (package.json)</option>
                  </select>
                </div>
                <button
                  type="button"
                  onClick={triggerDockerSimRun}
                  disabled={isSandboxRunning}
                  className={`px-4 py-3 text-black font-bold uppercase tracking-wider rounded flex items-center gap-2 cursor-pointer transition h-max ${
                    isSandboxRunning ? 'bg-zinc-800 text-gray-500 animate-pulse' : 'bg-amber-400 hover:bg-amber-300 shadow-[0_0_12px_rgba(251,191,36,0.15)]'
                  }`}
                >
                  <Play className="w-4 h-4 text-black" />
                  {isSandboxRunning ? 'Running Build...' : 'Spin Up Box'}
                </button>
              </div>
            </div>

            {/* Simulated Black Dev Terminal Output GUI */}
            <div className="flex-grow flex flex-col bg-[#050608] border border-gray-950/90 rounded-lg overflow-hidden my-3 relative p-3">
              <div className="flex items-center justify-between border-b border-zinc-900 pb-1.5 mb-2 shrink-0 select-none">
                <span className="text-[8px] text-gray-600 font-bold uppercase tracking-widest flex items-center gap-1">
                  <span className="w-1.5 h-1.5 bg-amber-500 rounded-full animate-pulse" />
                  STDOUT_BRIDGE:/dev/sandbox_isolate
                </span>
                <button 
                  onClick={() => setSandboxLogs(['[SYSTEM] Logs cleared safely.'])}
                  className="text-[8px] text-zinc-650 hover:text-white uppercase"
                >
                  Clear Console
                </button>
              </div>

              <div className="flex-1 overflow-y-auto font-mono text-[10px] text-emerald-450 leading-relaxed space-y-1 pr-1.5 select-text">
                {sandboxLogs.map((log, idx) => (
                  <div key={idx} className={log.includes('[SYSTEM]') ? 'text-cyan-400' : log.includes('SUCCESS') ? 'text-[#00ff41]' : 'text-zinc-450'}>
                    {log}
                  </div>
                ))}
                <div ref={terminalLogEndRef} />
              </div>
            </div>

            <div className="flex justify-between items-center text-[9px] text-gray-550 shrink-0 select-none">
              <span>Environment: Docker 26.1 / Node.js Dev Sandbox</span>
              <span>Memory Limit: 512MB hard isolation CAP</span>
            </div>
          </div>
        </div>
      )}

      {/* TAB CONTAINER 3: ADVANCED COGNITIVE AI MEMORY */}
      {workspaceActiveSubTab === 'memory' && (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-5">
          {/* Memory Records Ingestion Dashboard */}
          <div className="xl:col-span-4 bg-[#0d0f14] border border-gray-950 p-4 rounded-xl space-y-4">
            <div>
              <span className="text-[9px] text-purple-400 bg-purple-950 font-bold px-1.5 py-0.5 rounded">COGNITIVE ENGINE</span>
              <h4 className="text-xs font-bold text-white uppercase tracking-tight mt-1">Associate Vector Memory</h4>
              <p className="text-[10px] text-gray-500 font-sans leading-normal">
                Directly inject facts or custom core rules into the long-term cognitive vector matrix parsed by models on thread simulations.
              </p>
            </div>

            <form onSubmit={handleAddMemoryFact} className="space-y-3 border-t border-gray-950 pt-3">
              <div className="space-y-1">
                <label className="block text-[8px] text-gray-400 uppercase tracking-widest font-bold">New Memory Fact Content:</label>
                <textarea
                  value={newMemoryFact}
                  onChange={(e) => setNewMemoryFact(e.target.value)}
                  placeholder="e.g. Always respond using high-priority professional terminology for API routes, avoiding simple mock responses..."
                  className="w-full bg-black border border-gray-900 rounded p-2 text-xs text-gray-200 outline-none focus:border-purple-400 h-24 resize-none leading-snug"
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <label className="block text-[8px] text-gray-400 uppercase tracking-widest font-bold">Cluster Index:</label>
                  <select
                    value={newMemoryCategory}
                    onChange={(e) => setNewMemoryCategory(e.target.value)}
                    className="w-full bg-black border border-gray-900 rounded p-1 text-xs text-gray-300 outline-none"
                  >
                    <option value="User Preference">User Preference</option>
                    <option value="Architecture">Architecture</option>
                    <option value="Persona Instructions">Persona Info</option>
                    <option value="Models Settings">Models Settings</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="block text-[8px] text-gray-400 uppercase tracking-widest font-bold">Priority Weight (1-10):</label>
                  <input
                    type="number"
                    min="1"
                    max="10"
                    value={newMemoryImportance}
                    onChange={(e) => setNewMemoryImportance(parseInt(e.target.value, 10))}
                    className="w-full bg-black border border-gray-900 rounded p-1 text-xs text-gray-300 outline-none"
                  />
                </div>
              </div>

              <button
                type="submit"
                className="w-full py-2 bg-purple-850 hover:bg-purple-700 text-white font-bold rounded uppercase tracking-wider text-[11px] transition duration-200 cursor-pointer flex items-center justify-center gap-1.5"
              >
                <Plus className="w-4 h-4" />
                Ingest Vector Fact
              </button>
            </form>
          </div>

          {/* Cognitive Network Cluster Explorer List */}
          <div className="xl:col-span-8 bg-[#0d0f14] border border-gray-950 p-4 rounded-xl flex flex-col h-[480px]">
            <div className="flex items-center justify-between border-b border-zinc-950 pb-3 mb-3 shrink-0">
              <div>
                <h4 className="text-xs font-bold text-white uppercase tracking-tight">Active Vector Memory Clusters</h4>
                <p className="text-[10px] text-gray-500 font-sans leading-normal">
                  Showing active logical rules stored inside <code className="text-rose-400">memory.md</code> template file.
                </p>
              </div>

              {/* Memory Search */}
              <div className="relative w-48">
                <Search className="w-3.5 h-3.5 text-gray-650 absolute left-2 top-2" />
                <input
                  type="text"
                  placeholder="Query semantic database..."
                  value={memorySearch}
                  onChange={(e) => setMemorySearch(e.target.value)}
                  className="w-full bg-black border border-gray-900 rounded pl-7 pr-2 py-1.5 text-[10px] text-gray-200 outline-none focus:border-purple-400"
                />
              </div>
            </div>

            <div className="flex-grow overflow-y-auto space-y-2.5 pr-1.5">
              {memoryRecords
                .filter(rec => !memorySearch || rec.fact.toLowerCase().includes(memorySearch.toLowerCase()) || rec.category.toLowerCase().includes(memorySearch.toLowerCase()))
                .map((rec) => (
                  <div key={rec.id} className="bg-black/50 border border-gray-950 p-3 rounded-lg flex gap-3 relative hover:border-[#8b5cf6]/30 transition group select-none">
                    <div className="p-2 bg-purple-950/20 border border-purple-900/40 rounded-lg shrink-0 flex flex-col items-center justify-center w-12 text-center h-12">
                      <span className="text-[7px] text-gray-500 uppercase font-sans font-bold">WEIGHT</span>
                      <span className="text-sm font-bold text-purple-400 font-mono mt-0.5">{rec.importance}/10</span>
                    </div>

                    <div className="flex-1 space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[9px] bg-purple-950/45 text-purple-400 border border-purple-900/50 px-1.5 py-0.5 rounded font-bold uppercase tracking-wider font-mono">
                          {rec.category}
                        </span>
                        <span className="text-[8px] text-gray-650 font-mono">{rec.timestamp}</span>
                      </div>
                      <p className="text-[11px] text-gray-300 font-sans leading-relaxed">{rec.fact}</p>
                      
                      <div className="flex items-center gap-1.5 pt-1">
                        <span className="text-[7.5px] text-gray-650 font-bold uppercase font-sans">Semantic Keys:</span>
                        {rec.associations.map((t, idx) => (
                          <span key={idx} className="bg-zinc-900 text-gray-500 text-[8px] px-1 rounded font-mono">#{t}</span>
                        ))}
                      </div>
                    </div>

                    <button
                      onClick={() => handleDeleteMemory(rec.id, rec.fact)}
                      className="absolute right-2.5 top-2.5 p-1 text-gray-750 hover:text-rose-400 opacity-0 group-hover:opacity-100 transition rounded"
                      title="Deindex Memory"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
            </div>

            <div className="border-t border-gray-900 pt-2.5 mt-2.5 text-[9px] text-gray-550 flex items-center justify-between shrink-0 select-none">
              <span className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-purple-500" />
                Active Index: L2 Cosine Distance Matcher
              </span>
              <span>Loaded Memory Cluster Blocks: {memoryRecords.length}</span>
            </div>
          </div>
        </div>
      )}

      {/* TAB CONTAINER 4: DEVISE HARDWARE SCANNER AND AI REOMMENATION ENGINE */}
      {workspaceActiveSubTab === 'hardware' && (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-5">
          {/* Active Workstation Discovery Spec */}
          <div className="xl:col-span-5 bg-[#0d0f14] border border-gray-950 p-4 rounded-xl space-y-4 flex flex-col justify-between">
            <div className="space-y-4">
              <div>
                <span className="text-[9px] text-cyan-400 bg-cyan-950 font-bold px-1.5 py-0.5 rounded uppercase">HARDWARE PROFILER</span>
                <h4 className="text-xs font-bold text-white uppercase tracking-tight mt-1">Client Workstation Scan</h4>
                <p className="text-[10px] text-gray-500 font-sans leading-normal">
                  Identified active hardware capabilities of this machine through the Sandbox hypervisor hook.
                </p>
              </div>

              {/* Graphic Spec Board */}
              <div className="space-y-2">
                <div className="bg-black/60 border border-gray-950 p-3 rounded-lg flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Cpu className="w-4 h-4 text-cyan-400" />
                    <span className="text-[10.5px] font-bold text-gray-300">Processing Cores:</span>
                  </div>
                  <span className="text-[11px] font-mono font-bold text-cyan-405">{hardwareSpecs.cores} logical Threads</span>
                </div>

                <div className="bg-black/60 border border-gray-950 p-3 rounded-lg flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <HardDrive className="w-4 h-4 text-emerald-400" />
                    <span className="text-[10.5px] font-bold text-gray-300">System Memory (RAM):</span>
                  </div>
                  <span className="text-[11px] font-mono font-bold text-emerald-405">{hardwareSpecs.memoryGB} GB Capacity</span>
                </div>

                <div className="bg-black/60 border border-gray-950 p-3 rounded-lg flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <Monitor className="w-4 h-4 text-purple-400" />
                    <span className="text-[10.5px] font-bold text-gray-300">WebGL Graphic Unit (GPU):</span>
                  </div>
                  <p className="text-[10px] font-mono text-gray-400 leading-normal pl-6 bg-black p-1.5 rounded">{hardwareSpecs.gpuName}</p>
                </div>

                <div className="bg-black/60 border border-gray-950 p-3 rounded-lg flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Shield className="w-4 h-4 text-amber-500" />
                    <span className="text-[10.5px] font-bold text-gray-300">Host OS Environment:</span>
                  </div>
                  <span className="text-[11px] font-mono font-bold text-amber-500">{hardwareSpecs.osName}</span>
                </div>
              </div>
            </div>

            <div className="border-t border-gray-950/80 pt-3 mt-3">
              <button
                onClick={() => {
                  runHardwareAutodetect();
                  showNotify('success', 'Hardware capability matrices successfully reloaded!');
                }}
                className="w-full py-1.5 border border-zinc-800 hover:border-cyan-500 hover:text-white rounded bg-zinc-950 transition opacity-80"
              >
                Re-scan Host Specs
              </button>
            </div>
          </div>

          {/* AI Model Intelligence Architecture Recommeder */}
          <div className="xl:col-span-7 bg-[#0d0f14] border border-gray-950 p-4 rounded-xl flex flex-col justify-between h-auto">
            <div className="space-y-4">
              <div>
                <span className="text-[9px] text-amber-500 bg-amber-950 font-bold px-1.5 py-0.5 rounded">AI MODEL RECOMMENDATION</span>
                <h4 className="text-xs font-bold text-white uppercase tracking-tight mt-1">Smart Model Architectural Mapping</h4>
                <p className="text-[10px] text-gray-500 font-sans leading-normal">
                  Based on the physical capacities of the detected local device, here is the customized deployment mapping.
                </p>
              </div>

              {/* The Recommendation Display */}
              <div className="bg-gradient-to-tr from-black via-[#081a24]/10 to-black p-3.5 border border-[#163a4e]/70 rounded-xl space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-bold text-cyan-400 uppercase tracking-widest flex items-center gap-1">
                    <Sparkles className="w-4 h-4 text-amber-400" />
                    {detectedAiOptions.recommendation}
                  </span>
                  <span className={`text-[8px] font-bold uppercase px-2 py-0.5 rounded tracking-widest ${
                    detectedAiOptions.acceleratorType === 'NPU-Local' ? 'bg-purple-950 text-purple-400' :
                    detectedAiOptions.acceleratorType === 'GPU-Direct' ? 'bg-emerald-950 text-emerald-400 animate-pulse' :
                    detectedAiOptions.acceleratorType === 'CPU-Fallback' ? 'bg-amber-950 text-amber-400' :
                    'bg-zinc-950 text-gray-400'
                  }`}>
                    {detectedAiOptions.acceleratorType}
                  </span>
                </div>

                <p className="text-[11px] text-gray-350 leading-relaxed font-sans">{detectedAiOptions.reason}</p>

                <div className="space-y-1.5">
                  <span className="text-[8px] text-cyan-500 uppercase tracking-widest font-bold">Recommended Local Models list:</span>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    {detectedAiOptions.possibleModels.map((model, i) => (
                      <div key={i} className="bg-black/80 border border-gray-950 p-2.5 rounded text-center">
                        <span className="text-[9.5px] font-bold text-gray-300 font-mono block truncate">{model.split('-').shift()}</span>
                        <span className="text-[8px] text-gray-500 block mt-0.5 truncate">{model}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Cloud API Key fallback insertion recommendation */}
              <div className="border-t border-gray-950/80 pt-4 space-y-2.5">
                <div>
                  <h5 className="text-[11px] font-bold text-white uppercase flex items-center gap-1">
                    <Key className="w-3.5 h-3.5 text-yellow-500" />
                    Cloud API Key Configuration (Optional Target Bypass)
                  </h5>
                  <p className="text-[10px] text-gray-500 font-sans leading-relaxed">
                    If local accelerator modeling is disabled, you can proxy calculations using your direct developer API key. Expose keys safely via server configuration.
                  </p>
                </div>

                <div className="flex gap-2">
                  <input
                    type="password"
                    placeholder="Enter your Gemini / OpenAI private developer API Key..."
                    value={cloudApiKeyInput}
                    onChange={(e) => {
                      setCloudApiKeyInput(e.target.value);
                      setApiKeyStatus('idle');
                      setKeyConfirmMessage('Status modified. Save key to run verification handshake again.');
                    }}
                    disabled={isVerifyingKey}
                    className="flex-grow bg-black border border-gray-950 rounded px-3 py-1.5 text-xs text-gray-300 outline-none focus:border-yellow-500 font-mono disabled:opacity-50"
                  />
                  <button
                    type="button"
                    onClick={handleSaveApiKey}
                    disabled={isVerifyingKey}
                    className="px-4 py-1.5 bg-yellow-500 hover:bg-yellow-400 text-black font-bold rounded text-[10px] uppercase cursor-pointer disabled:bg-zinc-800 disabled:text-zinc-550 disabled:cursor-not-allowed flex items-center gap-1"
                  >
                    {isVerifyingKey ? (
                      <>
                        <span className="w-2.5 h-2.5 border-2 border-black border-t-transparent rounded-full animate-spin"></span>
                        VERIFYING...
                      </>
                    ) : apiKeyStatus === 'saved' ? (
                      'KEY CONFIGURED'
                    ) : (
                      'SAVE CLOUD KEY'
                    )}
                  </button>
                </div>
                {keyConfirmMessage && (
                  <div className={`text-[9.5px] font-mono leading-relaxed mt-1 flex items-center gap-1.5 ${
                    apiKeyStatus === 'saved' ? 'text-[#00ff41] font-bold' : 
                    keyConfirmMessage.includes('❌') ? 'text-rose-500 font-bold' : 'text-yellow-400 animate-pulse'
                  }`}>
                    {keyConfirmMessage}
                  </div>
                )}
                {apiKeyStatus === 'saved' && (
                  <span className="text-[9px] text-[#00ff41] font-bold uppercase tracking-wider block flex items-center gap-1 animate-pulse">
                    <Check className="w-3.5 h-3.5" />
                    Cloud bypass bridge active: Prioritizing low-latency Google Gemini Cloud API
                  </span>
                )}
              </div>
            </div>

            <div className="text-[9px] text-gray-550 border-t border-gray-990 pt-3 mt-4 text-right">
              Hardware Scanner: W3C Navigator Profiler API v2
            </div>
          </div>
        </div>
      )}

      {/* CREATE MODAL POPUP WINDOW */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-xs z-[9999] flex items-center justify-center p-4">
          <form 
            onSubmit={handleCreateWorkspaceItem}
            className="w-full max-w-sm bg-[#0b0e14] border border-gray-950 rounded-xl p-5 space-y-4 relative"
          >
            <div className="flex items-center justify-between border-b border-gray-800 pb-2.5">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                <h4 className="text-xs font-bold text-white uppercase tracking-wider">
                  Create new {showCreateModal}
                </h4>
              </div>
              <button 
                type="button"
                onClick={() => setShowCreateModal(null)}
                className="text-gray-500 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-[10px] text-gray-500 font-sans leading-normal font-mono">
              Provide a relative filename or folder target. Relative path context: 
              <strong className="text-gray-300 font-mono text-[9px] block bg-black p-1 rounded mt-1 border border-zinc-950">
                {newItemPath ? `/${newItemPath}/` : '/ [ROOT]'}
              </strong>
            </p>

            <div>
              <label className="block text-[8px] text-gray-400 uppercase tracking-widest mb-1.5 font-bold">
                Target Name
              </label>
              <input
                type="text"
                required
                placeholder={showCreateModal === 'file' ? 'e.g. sampleScript.ts' : 'e.g. dataUtils'}
                value={newItemName}
                onChange={(e) => setNewItemName(e.target.value)}
                className="w-full bg-black/60 border border-gray-950 rounded px-2.5 py-1.5 text-xs text-gray-200 outline-none focus:border-emerald-500 font-mono"
                autoFocus
              />
            </div>

            <div className="flex gap-2 pt-2">
              <button
                type="submit"
                className="flex-grow py-2 bg-emerald-700 hover:bg-emerald-600 text-white font-bold rounded transition text-xs uppercase"
              >
                Create {showCreateModal}
              </button>
              <button
                type="button"
                onClick={() => setShowCreateModal(null)}
                className="px-4 py-2 bg-zinc-900 hover:bg-zinc-850 text-gray-400 border border-zinc-800 rounded transition text-xs"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

    </div>
  );
}
