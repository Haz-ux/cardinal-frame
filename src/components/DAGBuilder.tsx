import React, { useState, useRef } from 'react';
import { AgentNode, NodeEdge, AgentNodeType, NodeProcessor } from '../types';
import { 
  Plus, 
  Trash2, 
  ArrowRight, 
  Cpu, 
  Radio, 
  Zap, 
  HelpCircle, 
  Layers, 
  ChevronRight, 
  Folder, 
  File, 
  Activity, 
  ShieldAlert, 
  GitBranch, 
  Gauge, 
  Code,
  Compass,
  Brain,
  Sparkles,
  ArrowUp,
  ArrowDown,
  Eye,
  Sliders,
  Percent,
  Save,
  FolderOpen,
  Database,
  CheckCircle2,
  AlertTriangle,
  Workflow,
  Sparkle
} from 'lucide-react';

interface DAGBuilderProps {
  nodes: AgentNode[];
  edges: NodeEdge[];
  onAddNode: (node: AgentNode) => void;
  onDeleteNode: (id: string) => void;
  onAddEdge: (edge: NodeEdge) => void;
  onDeleteEdge: (id: string) => void;
  onUpdateNode: (node: AgentNode) => void;
  discoveredModels?: { name: string; displayName: string }[];
  isSimulating?: boolean;
}

export default function DAGBuilder({
  nodes,
  edges,
  onAddNode,
  onDeleteNode,
  onAddEdge,
  onDeleteEdge,
  onUpdateNode,
  discoveredModels = [],
  isSimulating = false
}: DAGBuilderProps) {
  const [selectedNode, setSelectedNode] = useState<AgentNode | null>(null);
  const [isOptimizingLayout, setIsOptimizingLayout] = useState(false);

  const runForceDirectedLayout = () => {
    if (nodes.length === 0 || isOptimizingLayout) return;
    setIsOptimizingLayout(true);

    // Capture initial positions and velocities
    let physicsNodes = nodes.map(n => ({
      id: n.id,
      x: n.x,
      y: n.y,
      vx: 0,
      vy: 0
    }));

    // Multiplier for repulsion based on node's connection density (degree)
    const getDegree = (nodeId: string) => {
      return edges.filter(e => e.source === nodeId || e.target === nodeId).length;
    };

    const canvasW = 1200; // Visual constellation layout canvas width boundaries
    const canvasH = 600;
    const centerX = canvasW / 2;
    const centerY = canvasH / 2;

    const maxIterations = 70;
    let currentStep = 0;

    const intervalId = setInterval(() => {
      // 1. Repulsive forces (Coulomb's Law style, nodes push each other away)
      for (let i = 0; i < physicsNodes.length; i++) {
        const u = physicsNodes[i];
        const degU = getDegree(u.id);
        // Scale repulsion strength based on connection density (highly connected nodes spread out more)
        const baseRepel = 75000 * (1 + degU * 0.45);

        for (let j = 0; j < physicsNodes.length; j++) {
          if (i === j) continue;
          const v = physicsNodes[j];
          const dx = u.x - v.x;
          const dy = u.y - v.y;
          const distSq = dx * dx + dy * dy || 4;
          const dist = Math.sqrt(distSq);

          // Force vector pointing away
          const force = baseRepel / distSq;
          u.vx += (dx / dist) * force;
          u.vy += (dy / dist) * force;
        }
      }

      // 2. Attractive forces (Hooke's Law style springs along connected edges)
      const kAttract = 0.055;
      edges.forEach(edge => {
        const u = physicsNodes.find(n => n.id === edge.source);
        const v = physicsNodes.find(n => n.id === edge.target);
        if (!u || !v) return;

        const dx = v.x - u.x;
        const dy = v.y - u.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;

        // Target spring length depending on latency hierarchy!
        // Low latency: 150px; Medium: 250px; High: 420px
        let optimalDist = 240;
        if (edge.latencyNs < 500) {
          optimalDist = 140; // tightly knit high-speed nodes
        } else if (edge.latencyNs > 1500) {
          optimalDist = 380; // loose low-speed pipeline modules
        }

        const distortion = dist - optimalDist;
        const force = kAttract * distortion;

        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;

        u.vx += fx;
        u.vy += fy;
        v.vx -= fx;
        v.vy -= fy;
      });

      // 3. Gravity attraction to layout center & drag friction damping
      const kGravity = 0.016;
      physicsNodes.forEach(node => {
        const dx = centerX - node.x;
        const dy = centerY - node.y;
        node.vx += dx * kGravity;
        node.vy += dy * kGravity;

        // Friction parameter damping
        node.vx *= 0.55;
        node.vy *= 0.55;

        // Apply velocities
        node.x += node.vx;
        node.y += node.vy;

        // Bounding limits clamps inside our massive 2400x1200 constellation card
        node.x = Math.max(80, Math.min(2250, node.x));
        node.y = Math.max(80, Math.min(1050, node.y));
      });

      // Synchronize iterative positions to parent state smoothly
      physicsNodes.forEach(p => {
        const original = nodes.find(n => n.id === p.id);
        if (original) {
          onUpdateNode({
            ...original,
            x: Math.round(p.x),
            y: Math.round(p.y)
          });
        }
      });

      currentStep++;
      if (currentStep >= maxIterations) {
        clearInterval(intervalId);
        setIsOptimizingLayout(false);
      }
    }, 24); // 40fps fluid physics animation!
  };
  
  // Layout and view modes
  const [layoutMode, setLayoutMode] = useState<'constellation' | 'sequential'>('constellation');
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [simScenario, setSimScenario] = useState<'success' | 'failure_permission' | 'failure_timeout'>('success');

  // Zoom & Pan Workspace states (n8n feel)
  const [zoom, setZoom] = useState<number>(0.9);
  const [pan, setPan] = useState({ x: 50, y: 50 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });

  // Drag and Drop implementation states (Planetary view)
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  
  // Left pillar layout sub-tab switcher
  const [leftTab, setLeftTab] = useState<'stats' | 'n8n'>('n8n');

  // Interactive Live Cable Drafting States
  const [linkingSourceId, setLinkingSourceId] = useState<string | null>(null);
  const [currentMousePos, setCurrentMousePos] = useState({ x: 0, y: 0 });

  const canvasRef = useRef<HTMLDivElement>(null);

  // Responsive full-bleed sidebar overlays & canvas dimensions configuration
  const [leftSidebarOpen, setLeftSidebarOpen] = useState(true);
  const [rightSidebarOpen, setRightSidebarOpen] = useState(true);
  const [canvasHeightExpanded, setCanvasHeightExpanded] = useState(true);

  // Wheel custom zoom listener that calls e.preventDefault() on native events
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleWheel = (e: WheelEvent) => {
      if (layoutMode !== 'constellation') return;
      e.preventDefault(); // blocks browser-level page scale/scroll
      const zoomFactor = 0.05;
      setZoom((z) => {
        let newZoom;
        if (e.deltaY < 0) {
          newZoom = Math.min(2.0, z + zoomFactor);
        } else {
          newZoom = Math.max(0.4, z - zoomFactor);
        }
        return newZoom;
      });
    };

    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      canvas.removeEventListener('wheel', handleWheel);
    };
  }, [layoutMode]);

  // States for adding node
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<AgentNodeType>('LocalInference');
  const [newProcessor, setNewProcessor] = useState<NodeProcessor>('NPU-Local');
  const [newModel, setNewModel] = useState('Qwen-2.5-Coder-7B-NPU');
  const [newBatchSize, setNewBatchSize] = useState(8);
  const [newLimit, setNewLimit] = useState(16);

  // States for adding Edge
  const [sourceId, setSourceId] = useState('');
  const [targetId, setTargetId] = useState('');
  const [edgeTransport, setEdgeTransport] = useState<'Channel' | 'gRPC' | 'SharedMemory' | 'ZeroCopyRing'>('Channel');

  // n8n Rich Node Presets Palette
  const nodeTemplates = [
    {
      type: 'IngressRouter' as AgentNodeType,
      displayName: 'Ingress Router',
      desc: 'Gateway routing incoming triggers, JSON parameters, and multi-agent events.',
      color: 'border-cyan-500/60 text-cyan-400 bg-cyan-950/20 hover:border-cyan-400',
      icon: <Compass className="w-4 h-4 text-cyan-400" />,
      defaultModel: 'GoRouter-Embedded',
      defaultProcessor: 'CPU' as NodeProcessor,
    },
    {
      type: 'TaskPlanner' as AgentNodeType,
      displayName: 'Task Planner',
      desc: 'Orchestrates workflow logic, charts decisions, and assigns agent loops.',
      color: 'border-amber-500/60 text-amber-400 bg-amber-950/20 hover:border-amber-400',
      icon: <Brain className="w-4 h-4 text-amber-400" />,
      defaultModel: 'Qwen-2.5-Coder-7B-NPU',
      defaultProcessor: 'NPU-Local' as NodeProcessor,
    },
    {
      type: 'LocalInference' as AgentNodeType,
      displayName: 'Model Inference',
      desc: 'Local high-performance LLM core execution for reasoning and processing text.',
      color: 'border-emerald-500/60 text-emerald-400 bg-emerald-950/20 hover:border-emerald-400',
      icon: <Cpu className="w-4 h-4 text-emerald-400" />,
      defaultModel: 'Qwen-2.5-Coder-7B-NPU',
      defaultProcessor: 'NPU-Local' as NodeProcessor,
    },
    {
      type: 'ToolExecutor' as AgentNodeType,
      displayName: 'Tool Executor',
      desc: 'Triggers CLI commands, system scripts, web requests and file tools.',
      color: 'border-violet-500/60 text-violet-400 bg-violet-950/20 hover:border-violet-400',
      icon: <Zap className="w-4 h-4 text-violet-400" />,
      defaultModel: 'BashTools-Engine',
      defaultProcessor: 'CPU' as NodeProcessor,
    },
    {
      type: 'ResponseAggregator' as AgentNodeType,
      displayName: 'Output Collector',
      desc: 'Collates and normalizes concurrent agent responses into JSON files on host.',
      color: 'border-rose-500/60 text-rose-400 bg-rose-950/20 hover:border-rose-400',
      icon: <Layers className="w-4 h-4 text-rose-400" />,
      defaultModel: 'JSONCopier-Local',
      defaultProcessor: 'CPU' as NodeProcessor,
    }
  ];

  // Right Drawer Variable / Preset Templates
  const presetTemplates = [
    {
      category: 'Variable Helpers',
      name: 'Read User Var',
      desc: 'Retrieve active subscriber property cards from memory grids.',
      action: 'Read: user_context_key',
      icon: 'FolderOpen',
      type: 'IngressRouter' as AgentNodeType,
      processor: 'CPU' as NodeProcessor,
      modelName: 'Memory Pointer (SHM)',
      badge: 'VAR_READ'
    },
    {
      category: 'Variable Helpers',
      name: 'Write Token Var',
      desc: 'Persist output token benchmarks into dynamic SRAM buffers.',
      action: 'Write: output_metrics',
      icon: 'Save',
      type: 'ResponseAggregator' as AgentNodeType,
      processor: 'CPU' as NodeProcessor,
      modelName: 'Memory Pointer (SHM)',
      badge: 'VAR_WRITE'
    },
    {
      category: 'Math operations',
      name: 'Add Counter Step',
      desc: 'Calculate math iteration loop count variables atomically.',
      action: 'Math: count_increment++',
      icon: 'Plus',
      type: 'ToolExecutor' as AgentNodeType,
      processor: 'CPU' as NodeProcessor,
      modelName: 'Algebra Solver (Float64)',
      badge: 'MATH_OP'
    },
    {
      category: 'Math operations',
      name: 'Divide Core Weight',
      desc: 'Formula balance CPU & NPU queues based on context scales.',
      action: 'Math: div_ring_balance',
      icon: 'Percent',
      type: 'ToolExecutor' as AgentNodeType,
      processor: 'CPU' as NodeProcessor,
      modelName: 'Parallel Scaling Optimizer',
      badge: 'MATH_OP'
    },
    {
      category: 'Flow controls',
      name: 'Inbound API Trigger',
      desc: 'Boot flow chain on incoming JSON webhook payloads.',
      action: 'Trigger: http_request',
      icon: 'Radio',
      type: 'IngressRouter' as AgentNodeType,
      processor: 'CPU' as NodeProcessor,
      modelName: 'GoRouter-Embedded',
      badge: 'TRIGGER'
    },
    {
      category: 'Flow controls',
      name: 'Permission Check',
      desc: 'Evaluate true/false conditional logic for security validation.',
      action: 'Check: validated_auth_flag',
      icon: 'GitBranch',
      type: 'TaskPlanner' as AgentNodeType,
      processor: 'GPU-TensorCore' as NodeProcessor,
      modelName: 'Decision-Boundary-LLM',
      badge: 'CONDITION'
    },
    {
      category: 'Advanced AI Prompt',
      name: 'Execute NPU Prompt',
      desc: 'Fire prompt query into silicon accelerator modules.',
      action: 'NPU Prompt: run_summary',
      icon: 'Sparkles',
      type: 'LocalInference' as AgentNodeType,
      processor: 'NPU-Local' as NodeProcessor,
      modelName: 'Qwen-2.5-Coder-7B-NPU',
      badge: 'NPU_AI'
    }
  ];

  const renderPresetIcon = (iconName: string) => {
    switch (iconName) {
      case 'FolderOpen': return <FolderOpen className="w-3.5 h-3.5 text-cyan-400" />;
      case 'Save': return <Save className="w-3.5 h-3.5 text-emerald-400" />;
      case 'Plus': return <Plus className="w-3.5 h-3.5 text-[#00ff41]" />;
      case 'Percent': return <Percent className="w-3.5 h-3.5 text-[#00e5ff]" />;
      case 'Radio': return <Radio className="w-3.5 h-3.5 text-amber-500 animate-pulse" />;
      case 'GitBranch': return <GitBranch className="w-3.5 h-3.5 text-violet-400" />;
      case 'Sparkles': return <Sparkles className="w-3.5 h-3.5 text-pink-400 animate-pulse" />;
      default: return <Code className="w-3.5 h-3.5 text-gray-400" />;
    }
  };

  // Directories visual mock
  const mockFileTree = [
    { type: 'dir', name: 'cardinal-frame-core', children: [
      { type: 'dir', name: 'ringbuffer', children: [
        { type: 'file', name: 'lockless_ring.go', lines: 420 },
        { type: 'file', name: 'shm_transport.go', lines: 812 }
      ]},
      { type: 'dir', name: 'scheduler', children: [
        { type: 'file', name: 'goroutine_pool.go', lines: 1104 }
      ]},
      { type: 'file', name: 'main.go', lines: 320 },
      { type: 'file', name: 'config.go', lines: 180 }
    ]}
  ];

  const handleCreateNode = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName) return;
    
    // Spread node placement dynamically in view
    const xCoord = 140 + Math.random() * 200;
    const yCoord = 80 + Math.random() * 200;

    const newNode: AgentNode = {
      id: `node_${Date.now()}`,
      name: newName,
      type: newType,
      processor: newProcessor,
      modelName: newModel,
      batchSize: Number(newBatchSize),
      inputTokens: 0,
      outputTokens: 0,
      concurrencyLimit: Number(newLimit),
      status: 'idle',
      x: Math.round(xCoord),
      y: Math.round(yCoord),
    };

    onAddNode(newNode);
    setNewName('');
    if (newType === 'IngressRouter') setNewModel('GoRouter-Embedded');
    else if (newType === 'ToolExecutor') setNewModel('BashTools-Engine');
    else if (newType === 'ResponseAggregator') setNewModel('JSONCopier-Local');
  };

  // Instantiates a library node directly at the center of the active panned/zoomed canvas viewport
  const handleAddNodeFromClick = (templateIdx: number) => {
    const template = nodeTemplates[templateIdx];
    if (!template) return;

    // Center coordinates adjusted for current zoom scale and translation pan offsets
    const centerX = Math.round((420 - pan.x) / zoom);
    const centerY = Math.round((260 - pan.y) / zoom);

    const clampedX = Math.round(Math.max(10, Math.min(2320, centerX)));
    const clampedY = Math.round(Math.max(10, Math.min(1120, centerY)));

    const randSeed = Math.floor(100 + Math.random() * 900);
    const shortType = template.type.replace('ResponseAggregator', 'Collector').replace('LocalInference', 'LLM');
    const nodeName = `n8n_${shortType}_${randSeed}`;

    const newNode: AgentNode = {
      id: `node_visual_${Date.now()}`,
      name: nodeName,
      type: template.type,
      processor: template.defaultProcessor,
      modelName: template.defaultModel,
      batchSize: 8,
      inputTokens: 0,
      outputTokens: 0,
      concurrencyLimit: 16,
      status: 'idle',
      x: clampedX,
      y: clampedY,
    };

    onAddNode(newNode);
    setSelectedNode(newNode); // Open right panel configuration in n8n customizer sidebar!
  };

  // Adding nodes from Preset Side panel Drawer
  const handleAddPresetNode = (preset: typeof presetTemplates[0]) => {
    const list = [...nodes].sort((a, b) => a.x - b.x);
    const nextX = list.length > 0 ? list[list.length - 1].x + 180 : 100;
    const nextY = 150;

    const newNode: AgentNode = {
      id: `node_preset_${Date.now()}`,
      name: `${preset.name.replace(/\s+/g, '_')}_${Math.floor(100 + Math.random() * 899)}`,
      type: preset.type,
      processor: preset.processor,
      modelName: preset.modelName,
      batchSize: 8,
      inputTokens: 0,
      outputTokens: 0,
      concurrencyLimit: 16,
      status: 'idle',
      x: nextX,
      y: nextY
    };

    onAddNode(newNode);

    // Auto connect following stream sequentially
    if (list.length > 0) {
      const parent = list[list.length - 1];
      onAddEdge({
        id: `edge_auto_${Date.now()}`,
        source: parent.id,
        target: newNode.id,
        transportType: 'Channel',
        latencyNs: 2500
      });
    }

    if (!selectedNode) {
      setSelectedNode(newNode);
    }
  };

  const handleCreateEdge = (e: React.FormEvent) => {
    e.preventDefault();
    if (!sourceId || !targetId || sourceId === targetId) return;

    const exists = edges.some(edge => edge.source === sourceId && edge.target === targetId);
    if (exists) return;

    let latency = 2500; 
    if (edgeTransport === 'ZeroCopyRing') latency = 450; 
    else if (edgeTransport === 'SharedMemory') latency = 1200; 
    else if (edgeTransport === 'gRPC') latency = 45000; 

    const newEdge: NodeEdge = {
      id: `edge_${Date.now()}`,
      source: sourceId,
      target: targetId,
      transportType: edgeTransport,
      latencyNs: latency,
    };

    onAddEdge(newEdge);
    setSourceId('');
    setTargetId('');
  };

  const getNodeColorTheme = (type: AgentNodeType) => {
    switch (type) {
      case 'IngressRouter': 
        return {
          glow: 'shadow-[0_0_15px_rgba(6,182,212,0.3)] border-cyan-500 text-cyan-400 focus:ring-cyan-400 bg-cyan-950/20',
          dot: 'bg-cyan-400',
          ring: 'border-cyan-500/30'
        };
      case 'TaskPlanner': 
        return {
          glow: 'shadow-[0_0_15px_rgba(245,158,11,0.3)] border-amber-500 text-amber-400 focus:ring-amber-500 bg-amber-950/20',
          dot: 'bg-amber-400',
          ring: 'border-amber-500/30'
        };
      case 'LocalInference': 
        return {
          glow: 'shadow-[0_0_15px_rgba(16,185,129,0.3)] border-emerald-500 text-emerald-400 focus:ring-emerald-500 bg-emerald-950/20',
          dot: 'bg-emerald-400',
          ring: 'border-emerald-500/30'
        };
      case 'ToolExecutor': 
        return {
          glow: 'shadow-[0_0_15px_rgba(139,92,246,0.3)] border-violet-500 text-violet-400 focus:ring-violet-500 bg-violet-950/20',
          dot: 'bg-violet-400',
          ring: 'border-violet-500/30'
        };
      case 'ResponseAggregator': 
        return {
          glow: 'shadow-[0_0_15px_rgba(244,63,94,0.3)] border-rose-500 text-rose-400 bg-rose-950/20',
          dot: 'bg-rose-400',
          ring: 'border-rose-500/30'
        };
      default: 
        return {
          glow: 'shadow-[0_0_15px_rgba(107,114,128,0.3)] border-gray-500 text-gray-400 focus:ring-gray-500 bg-gray-950/20',
          dot: 'bg-gray-400',
          ring: 'border-gray-500/30'
        };
    }
  };

  const getEdgeStyle = (transport: string) => {
    switch (transport) {
      case 'ZeroCopyRing': return { stroke: '#ec4899', dash: undefined }; 
      case 'SharedMemory': return { stroke: '#06b6d4', dash: undefined }; 
      case 'Channel': return { stroke: '#10b981', dash: undefined }; 
      case 'gRPC': return { stroke: '#f59e0b', dash: '4,4' }; 
      default: return { stroke: '#6b7280', dash: undefined };
    }
  };

  // Node Dragging & Canvas Panning interactive events (Planetary graph)
  const handleNodeMouseDown = (nodeId: string, e: React.MouseEvent) => {
    if (e.button !== 0) return; 
    const node = nodes.find(n => n.id === nodeId);
    if (!node) return;
    
    setDraggingNodeId(nodeId);
    setSelectedNode(node);
    e.stopPropagation();
  };

  const handleCanvasMouseDown = (e: React.MouseEvent) => {
    if (e.button === 2) return; // Ignore right click
    
    const isTargetCanvasBG = e.target === e.currentTarget || 
                             (e.target as HTMLElement).id === "constellation-bg-grid" ||
                             (e.target as HTMLElement).id === "constellation-scroll-container" ||
                             (e.target as HTMLElement).tagName.toLowerCase() === 'svg' ||
                             (e.target as HTMLElement).classList.contains('canvas-bg-grid');
                             
    if (isTargetCanvasBG || e.button === 1 /* Middle click */) {
      setIsPanning(true);
      setPanStart({
        x: e.clientX - pan.x,
        y: e.clientY - pan.y
      });
      e.preventDefault();
    }
  };

  const handleCanvasMouseMove = (e: React.MouseEvent) => {
    if (!canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    
    if (isPanning) {
      const newX = e.clientX - panStart.x;
      const newY = e.clientY - panStart.y;
      setPan({ x: newX, y: newY });
      return;
    }

    // Convert screen coordinates to canvas space mapped by zoom and pan
    const mouseX = Math.round((e.clientX - rect.left - pan.x) / zoom);
    const mouseY = Math.round((e.clientY - rect.top - pan.y) / zoom);
    
    if (linkingSourceId) {
      setCurrentMousePos({ x: mouseX, y: mouseY });
    }

    if (!draggingNodeId) return;
    
    const node = nodes.find(n => n.id === draggingNodeId);
    if (!node) return;

    const computedX = mouseX - 36; 
    const computedY = mouseY - 36;

    // Expanded bounds matching the larger 2400x1200 field
    const clampedX = Math.round(Math.max(10, Math.min(2320, computedX)));
    const clampedY = Math.round(Math.max(10, Math.min(1120, computedY)));

    onUpdateNode({
      ...node,
      x: clampedX,
      y: clampedY
    });
  };

  const handleCanvasMouseUp = () => {
    setDraggingNodeId(null);
    setIsPanning(false);
  };

  const handleCanvasDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleCanvasDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (!canvasRef.current) return;

    try {
      const templateIdxStr = e.dataTransfer.getData('text/plain');
      if (!templateIdxStr) return;

      const templateIdx = parseInt(templateIdxStr, 10);
      const template = nodeTemplates[templateIdx];
      if (!template) return;

      const rect = canvasRef.current.getBoundingClientRect();
      // Drop coordinates mapped into zoomed/translated space
      const dropX = (e.clientX - rect.left - pan.x) / zoom - 36;
      const dropY = (e.clientY - rect.top - pan.y) / zoom - 36;

      const clampedX = Math.round(Math.max(10, Math.min(2320, dropX)));
      const clampedY = Math.round(Math.max(10, Math.min(1120, dropY)));

      const randSeed = Math.floor(100 + Math.random() * 900);
      const shortType = template.type.replace('ResponseAggregator', 'Collector').replace('LocalInference', 'LLM');
      const nodeName = `n8n_${shortType}_${randSeed}`;

      const newNode: AgentNode = {
        id: `node_visual_${Date.now()}`,
        name: nodeName,
        type: template.type,
        processor: template.defaultProcessor,
        modelName: template.defaultModel,
        batchSize: 8,
        inputTokens: 0,
        outputTokens: 0,
        concurrencyLimit: 16,
        status: 'idle',
        x: clampedX,
        y: clampedY,
      };

      onAddNode(newNode);
      setSelectedNode(newNode);
    } catch (err) {
      console.warn('Canvas drop parse issue:', err);
    }
  };

  // Re-ordering Snapped Blocks
  const handleMoveUp = (idx: number) => {
    if (idx === 0) return;
    const list = [...nodes].sort((a, b) => a.x - b.x);
    const current = list[idx];
    const prev = list[idx - 1];
    
    // Swap their coordinates to update serial layout order
    const currentX = current.x;
    onUpdateNode({ ...current, x: prev.x });
    onUpdateNode({ ...prev, x: currentX });
  };

  const handleMoveDown = (idx: number) => {
    const list = [...nodes].sort((a, b) => a.x - b.x);
    if (idx >= list.length - 1) return;
    const current = list[idx];
    const next = list[idx + 1];
    
    // Swap coordinate values
    const currentX = current.x;
    onUpdateNode({ ...current, x: next.x });
    onUpdateNode({ ...next, x: currentX });
  };

  const calculateNodeBlastRadius = (node: AgentNode | null) => {
    if (!node) {
      if (nodes.length === 0) return 0;
      return Math.round(Math.min(100, (edges.length / Math.max(1, nodes.length)) * 32 + 35));
    }
    if (node.type === 'IngressRouter') return 88;
    if (node.type === 'TaskPlanner') return 68;
    if (node.type === 'LocalInference') return 48;
    if (node.type === 'ToolExecutor') return 35;
    return 18; 
  };

  const blastRadiusScore = calculateNodeBlastRadius(selectedNode);

  // Sorting sequential nodes
  const sortedSequentialNodes = [...nodes].sort((a, b) => a.x - b.x);

  return (
    <div 
      id="dag-builder-root" 
      className={`font-mono text-xs select-none ${
        layoutMode === 'constellation' 
          ? 'w-full flex flex-col gap-4' 
          : 'grid grid-cols-1 xl:grid-cols-4 gap-6'
      }`}
    >
      
      {/* 1. LEFT SIDE STATS & N8N PALETTE COLUMN (ONLY RENDERED FOR SEQUENTIAL MODE) */}
      {layoutMode === 'sequential' && (
        <div id="codeflow-left-stats" className="bg-[#0b0e14] border border-gray-900 rounded-xl p-4 flex flex-col gap-4">
        
        {/* Tab Selector Buttons */}
        <div className="grid grid-cols-2 gap-1.5 p-1 bg-black/60 rounded-lg border border-gray-950">
          <button
            onClick={() => setLeftTab('n8n')}
            type="button"
            className={`py-1.5 text-[10px] uppercase font-bold tracking-wider rounded font-mono transition duration-200 cursor-pointer ${
              leftTab === 'n8n' 
                ? 'bg-[#00ff41]/10 text-[#00ff41] border border-[#00ff41]/40' 
                : 'text-gray-400 hover:text-white hover:bg-zinc-950 border border-transparent'
            }`}
          >
            n8n Library
          </button>
          <button
            onClick={() => setLeftTab('stats')}
            type="button"
            className={`py-1.5 text-[10px] uppercase font-bold tracking-wider rounded font-mono transition duration-200 cursor-pointer ${
              leftTab === 'stats' 
                ? 'bg-cyan-950/45 text-cyan-400 border border-cyan-800/60' 
                : 'text-gray-400 hover:text-white hover:bg-zinc-950 border border-transparent'
            }`}
          >
            Monitor Stats
          </button>
        </div>

        {leftTab === 'n8n' ? (
          /* N8N STYLE DRAGGABLE NODE SELECTION PALETTE */
          <div className="flex-1 flex flex-col gap-3 min-h-[300px]">
            <div className="border-b border-gray-800/80 pb-2">
              <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest flex items-center gap-1">
                <Sparkles className="w-3.5 h-3.5 text-[#00ff41] animate-pulse" />
               n8n Nodes Library (loaded)
              </span>
              <p className="text-[9px] text-[#555] font-sans leading-relaxed mt-1">
                Drag any module below directly onto the visual canvas workspace to instantiate new live agent units!
              </p>
            </div>

            <div className="flex-1 overflow-y-auto space-y-2.5 max-h-[360px] pr-1">
              {nodeTemplates.map((template, idx) => (
                <div
                  key={idx}
                  draggable="true"
                  onDragStart={(e) => {
                    e.dataTransfer.setData('text/plain', idx.toString());
                    e.dataTransfer.effectAllowed = 'copy';
                  }}
                  className={`border p-3 rounded-lg cursor-grab active:cursor-grabbing hover:-translate-y-0.5 transition duration-150 select-none flex gap-2.5 shadow-md ${template.color}`}
                  title="Drag and drop this node into the grid workspace card!"
                >
                  <div className="p-1.5 bg-black/45 rounded-md border border-gray-800/60 flex items-center justify-center shrink-0 self-start">
                    {template.icon}
                  </div>
                  <div className="space-y-0.5 animate-fade-in">
                    <div className="flex items-center gap-1.5 justify-between">
                      <span className="text-[10px] font-bold uppercase tracking-tight text-gray-200">{template.displayName}</span>
                      <span className="text-[7px] bg-[rgba(255,255,255,0.04)] px-1 py-0.5 rounded text-[#555] font-semibold font-mono">DRAG</span>
                    </div>
                    <p className="text-[9px] text-gray-500 font-sans leading-snug">{template.desc}</p>
                  </div>
                </div>
              ))}
            </div>

            <div className="bg-black/55 border border-zinc-900 rounded p-2 text-center text-[9px] font-sans text-amber-500/95 leading-normal">
              💡 <strong>ProTip:</strong> Switch to <span className="text-cyan-400 font-bold">APK Sequential</span> mode to build responsive sequences easily using direct Presets!
            </div>
          </div>
        ) : (
          /* TRADITIONAL CODEFLOW SYSTEM OVERVIEW telemetry */
          <div className="flex-1 flex flex-col gap-5">
            <div>
              <div className="flex items-center justify-between border-b border-gray-800 pb-2 mb-3">
                <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">CODEFLOW SUMMARY</span>
                <span className="text-[9px] bg-emerald-950/40 text-[#00ff41] border border-emerald-900/60 font-bold px-1.5 py-0.5 rounded">
                  98% Core Aligned
                </span>
              </div>

              {/* Interactive visual layout dials */}
              <div className="space-y-3">
                <div>
                  <div className="flex justify-between items-center text-[10px] text-gray-500 mb-1">
                    <span>Core Signal Strength</span>
                    <span className="text-white font-bold">94/100 Excellent</span>
                  </div>
                  <div className="w-full bg-black/40 h-2 rounded outline outline-1 outline-gray-900 overflow-hidden">
                    <div className="h-full bg-gradient-to-r from-emerald-500 to-cyan-500 animate-pulse" style={{ width: '94%' }} />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 text-center text-gray-300">
                  <div className="bg-black/50 border border-gray-900 p-2 rounded">
                    <div className="text-[8px] text-gray-500 uppercase tracking-tight">TOTAL CODE LINES</div>
                    <div className="text-sm font-bold text-[#00ff41] mt-0.5">140,108</div>
                  </div>
                  <div className="bg-black/50 border border-gray-900 p-2 rounded">
                    <div className="text-[8px] text-gray-500 uppercase tracking-tight">PINNED LOGS</div>
                    <div className="text-sm font-bold text-[#00e5ff] mt-0.5">1,478</div>
                  </div>
                  <div className="bg-black/50 border border-gray-900 p-2 rounded">
                    <div className="text-[8px] text-gray-500 uppercase tracking-tight">STREAM PIPES</div>
                    <div className="text-sm font-bold text-amber-500 mt-0.5">{edges.length} Links</div>
                  </div>
                  <div className="bg-black/50 border border-gray-900 p-2 rounded">
                    <div className="text-[8px] text-gray-500 uppercase tracking-tight">CHANNELS</div>
                    <div className="text-sm font-bold text-rose-500 mt-0.5">{nodes.length} Nodes</div>
                  </div>
                </div>
              </div>
            </div>

            {/* Directory mock list with stylish vertical indent markers */}
            <div className="flex-1">
              <span className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">FILE CLUSTER DIRECTORY</span>
              <div className="bg-black/40 p-3 rounded border border-gray-900 max-h-[160px] xl:max-h-[220px] overflow-y-auto space-y-2 text-[11px] text-gray-400">
                {mockFileTree.map((dir, i) => (
                  <div key={i} className="space-y-1">
                    <div className="flex items-center gap-1.5 text-gray-200 font-bold">
                      <Folder className="w-3.5 h-3.5 text-cyan-500 shrink-0" />
                      <span>{dir.name}/</span>
                    </div>
                    {dir.children.map((sub, j) => (
                      <div key={j} className="pl-4 border-l border-gray-800/80 ml-1.5 space-y-1">
                        {sub.type === 'dir' ? (
                          <>
                            <div className="flex items-center gap-1.5 text-gray-300 font-medium">
                              <Folder className="w-3.5 h-3.5 text-cyan-600 shrink-0" />
                              <span>{sub.name}/</span>
                            </div>
                            {sub.children?.map((file, k) => (
                              <div key={k} className="pl-4 border-l border-gray-800/80 ml-1.5 flex items-center justify-between text-[10px]">
                                <span className="flex items-center gap-1 text-gray-400 font-mono">
                                  <File className="w-3 h-3 text-emerald-400 shrink-0" />
                                  {file.name}
                                </span>
                                <span className="text-[9px] text-[#555]">{file.lines} LOC</span>
                              </div>
                            ))}
                          </>
                        ) : (
                          <div className="flex items-center justify-between text-[10px]">
                            <span className="flex items-center gap-1 text-gray-400">
                              <File className="w-3 h-3 text-emerald-400 shrink-0" />
                              {sub.name}
                            </span>
                            <span className="text-[9px] text-[#555]">{sub.lines} LOC</span>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
      )}

      {/* 2. CENTER INTERACTIVE CANVAS PANEL - Can toggle between planetary & snap-sequential list views */}
      <div 
        id="interactive-dag-canvas" 
        className={`${
          layoutMode === 'constellation' 
            ? 'w-full flex-1 min-h-[600px]' 
            : 'xl:col-span-2'
        } bg-[#080a0f] rounded-xl border border-gray-900 p-4 relative flex flex-col justify-between overflow-hidden`}
      >
        
        {/* Canvas visual header */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 border-b border-gray-900 pb-3 mb-3 z-10 font-mono">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-[#00ff41] stroke-[1.5] animate-pulse" />
            <h3 className="text-[11px] font-bold text-gray-200 uppercase tracking-widest">
              Design Network Workspace
            </h3>
          </div>
          
          {/* Sizing, Layout, and Drawer collapsers */}
          <div className="flex flex-wrap items-center gap-1.5">
            {/* View switcher toggle */}
            <div className="flex bg-black/60 p-0.5 rounded border border-zinc-800/60 text-[9px] font-bold">
              <button
                type="button"
                onClick={() => {
                  setLayoutMode('constellation');
                  setDrawerOpen(false); // Collapsed drawer by default for planetary spacing
                }}
                className={`px-2 py-1 rounded transition duration-200 uppercase tracking-tighter flex items-center gap-1 cursor-pointer ${
                  layoutMode === 'constellation' 
                    ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/35' 
                    : 'text-gray-500 hover:text-gray-300'
                }`}
                title="Planetary interactive graph workspace with manual drag-coords"
              >
                🌌 Constellation
              </button>
              <button
                type="button"
                onClick={() => {
                  setLayoutMode('sequential');
                  setDrawerOpen(true); // Open drawer automatically for sequential Presets matching user request
                }}
                className={`px-2 py-1 rounded transition duration-200 uppercase tracking-tighter flex items-center gap-1 cursor-pointer ${
                  layoutMode === 'sequential' 
                    ? 'bg-[#00ff41]/10 text-[#00ff41] border border-[#00ff41]/35' 
                    : 'text-gray-500 hover:text-gray-300'
                }`}
                title="Mobile APK Sequential snappy workflow cards sequence with presets drawer"
              >
                📱 APK Sequential
              </button>
            </div>

            {/* Run Force-Directed Graph Layout Optimization button */}
            {layoutMode === 'constellation' && (
              <button
                type="button"
                onClick={runForceDirectedLayout}
                disabled={isOptimizingLayout || nodes.length === 0}
                className={`px-2.5 py-1.5 border rounded text-[9px] font-bold transition flex items-center gap-1.5 cursor-pointer select-none ${
                  isOptimizingLayout 
                    ? 'bg-amber-500/20 border-amber-500/40 text-amber-300 animate-pulse' 
                    : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/40 hover:bg-emerald-500/25 hover:text-white'
                }`}
                title="Run force-directed optimization algorithm considering connection density & latency hierarchy!"
              >
                <Sparkle className={`w-3.5 h-3.5 text-emerald-400 ${isOptimizingLayout ? 'animate-spin' : ''}`} />
                {isOptimizingLayout ? 'Aligning Galaxy...' : 'Optimize Layout ⚡'}
              </button>
            )}
            
            {/* Collapse Preset Drawer toggle */}
            {layoutMode === 'sequential' && (
              <button
                type="button"
                onClick={() => setDrawerOpen(d => !d)}
                className={`px-2 py-1 border rounded text-[9px] font-bold transition flex items-center gap-1 cursor-pointer ${
                  drawerOpen 
                    ? 'bg-rose-950/20 text-rose-400 border-rose-900/60' 
                    : 'bg-[#00ff41]/10 text-[#00ff41] border-[#00ff41]/40'
                }`}
              >
                <Sliders className="w-2.5 h-2.5" />
                {drawerOpen ? 'Hide Drawer' : 'Show Presets'}
              </button>
            )}
          </div>
        </div>

        {/* CSS KEYFRAMES INJECTOR FOR ACTIVE VERTICAL DATA FLOW PACKETS AND NEON GLOWS */}
        <span className="hidden">
          <style>{`
            @keyframes flowPacketDown {
              0% { top: 0%; opacity: 0; }
              15% { opacity: 1; }
              85% { opacity: 1; }
              100% { top: 100%; opacity: 0; }
            }
            .animate-packet-vertical {
              animation: flowPacketDown 1.8s linear infinite;
            }
            .animate-packet-vertical-fast {
              animation: flowPacketDown 0.8s linear infinite;
            }
            @keyframes borderGlowPulse {
              0%, 100% { border-color: rgba(239, 68, 68, 0.4); box-shadow: 0 0 5px rgba(239, 68, 68, 0.2); }
              50% { border-color: rgba(239, 68, 68, 1); box-shadow: 0 0 15px rgba(239, 68, 68, 0.6); }
            }
            .animate-border-error-pulse {
              animation: borderGlowPulse 1.5s infinite;
            }
          `}</style>
        </span>

        {/* main workspace content splits based on mode */}
        <div 
          style={{ height: canvasHeightExpanded ? '660px' : '480px' }}
          className="flex-1 flex overflow-hidden w-full relative transition-all duration-300 rounded-lg border border-gray-950 overflow-hidden"
        >
          
          {layoutMode === 'constellation' ? (
            /* ====================🌌🌌🌌 PLANETARY GRAPH WORKSPACE 🌌🌌🌌==================== */
            <div className="w-full h-full relative flex overflow-hidden select-none z-10 bg-[#03060a]">
              
              {/* ====================🌌 COLLAPSIBLE LEFT SIDEBAR: DRAG/CLICK PALETTE & TELEMETRY 🌌==================== */}
              <div 
                style={{ 
                  width: '288px',
                  transform: leftSidebarOpen ? 'translateX(0)' : 'translateX(-100%)',
                  transition: 'transform 300ms cubic-bezier(0.16, 1, 0.3, 1)',
                }}
                className="absolute left-0 top-0 bottom-0 z-20 h-full bg-[#070b13]/97 border-r border-[#101524] backdrop-blur-md flex flex-col p-4 overflow-y-auto select-none"
              >
                {/* Subtab Buttons */}
                <div className="grid grid-cols-2 gap-1.5 p-1 bg-black/60 rounded-lg border border-gray-950/80 shrink-0 select-none mb-3">
                  <button
                    onClick={() => setLeftTab('n8n')}
                    type="button"
                    className={`py-1.5 text-[9px] uppercase font-bold tracking-wider rounded font-mono transition duration-200 cursor-pointer ${
                      leftTab === 'n8n' 
                        ? 'bg-[#00ff41]/10 text-[#00ff41] border border-[#00ff41]/40' 
                        : 'text-gray-400 hover:text-white hover:bg-[#03060a] border border-transparent'
                    }`}
                  >
                    n8n Library
                  </button>
                  <button
                    onClick={() => setLeftTab('stats')}
                    type="button"
                    className={`py-1.5 text-[9px] uppercase font-bold tracking-wider rounded font-mono transition duration-200 cursor-pointer ${
                      leftTab === 'stats' 
                        ? 'bg-cyan-950/45 text-cyan-400 border border-cyan-805/60' 
                        : 'text-gray-400 hover:text-white hover:bg-[#03060a] border border-transparent'
                    }`}
                  >
                    Monitor Stats
                  </button>
                </div>

                {leftTab === 'n8n' ? (
                  <div className="flex-1 flex flex-col gap-3 min-h-0">
                    <div className="pb-1 shrink-0 text-left">
                      <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest flex items-center gap-1.5 font-mono">
                        <Sparkles className="w-3.5 h-3.5 text-[#00ff41]" />
                       n8n Nodes Library (loaded)
                      </span>
                      <p className="text-[8.5px] text-zinc-500 font-sans leading-relaxed mt-0.5">
                        Drag onto canvas, or <span className="text-[#00ff41] font-semibold">CLICK</span> card to spawn at center!
                      </p>
                    </div>

                    <div className="space-y-2 overflow-y-auto pr-1 scrollbar-thin select-none">
                      {nodeTemplates.map((template, idx) => (
                        <div
                          key={idx}
                          draggable="true"
                          onDragStart={(e) => {
                            e.dataTransfer.setData('text/plain', idx.toString());
                            e.dataTransfer.effectAllowed = 'copy';
                          }}
                          onClick={() => handleAddNodeFromClick(idx)}
                          className={`border p-2.5 rounded-xl cursor-grab active:cursor-grabbing hover:-translate-y-0.5 transition duration-150 select-none flex gap-2.5 shadow-md ${template.color}`}
                          title="Drag onto canvas or click to spawn immediately!"
                        >
                          <div className="p-1.5 bg-black/45 rounded-md border border-gray-850/60 flex items-center justify-center shrink-0 self-start">
                            {template.icon}
                          </div>
                          <div className="space-y-0.5 flex-1 min-w-0 text-left">
                            <div className="flex items-center gap-1 justify-between">
                              <span className="text-[10px] font-bold uppercase tracking-tight text-gray-200 truncate">{template.displayName}</span>
                              <span className="text-[6.5px] bg-[rgba(255,255,255,0.04)] px-1 py-0.5 rounded text-[#00ff41] font-semibold font-mono shrink-0">ADD</span>
                            </div>
                            <p className="text-[8.5px] text-gray-405 font-sans leading-snug">{template.desc}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="flex-1 flex flex-col gap-4 text-left min-h-0">
                    <div>
                      <div className="flex items-center justify-between border-b border-[#121829] pb-2 mb-2 font-mono">
                        <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">CODEFLOW SUMMARY</span>
                        <span className="text-[8px] bg-emerald-950/40 text-[#00ff41] border border-emerald-950/60 font-bold px-1 py-0.5 rounded">
                          98% Core Aligned
                        </span>
                      </div>

                      <div className="space-y-2">
                        <div>
                          <div className="flex justify-between items-center text-[9px] text-gray-500 mb-0.5">
                            <span>Core Signal Strength</span>
                            <span className="text-white font-bold">94%</span>
                          </div>
                          <div className="w-full bg-black/40 h-1.5 rounded overflow-hidden">
                            <div className="h-full bg-gradient-to-r from-emerald-500 to-cyan-500" style={{ width: '94%' }} />
                          </div>
                        </div>

                        <div className="grid grid-cols-2 gap-1.5 text-center text-gray-300 font-mono">
                          <div className="bg-black/50 border border-[#141b2e] p-1.5 rounded">
                            <div className="text-[7.5px] text-gray-500 uppercase">SYS CODE LINES</div>
                            <div className="text-xs font-bold text-[#00ff41]">140,108</div>
                          </div>
                          <div className="bg-black/50 border border-[#141b2e] p-1.5 rounded">
                            <div className="text-[7.5px] text-gray-500 uppercase">STREAM PIPES</div>
                            <div className="text-xs font-bold text-amber-500">{edges.length} Links</div>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="flex-1 min-h-0 flex flex-col">
                      <span className="block text-[9px] font-bold text-gray-500 uppercase tracking-widest mb-1.5 shrink-0 font-mono">FILE DIRECTORY</span>
                      <div className="flex-1 bg-black/45 p-2 rounded border border-[#141b2e] overflow-y-auto space-y-1.5 text-[10.5px] text-zinc-400 scrollbar-thin text-left">
                        {mockFileTree.map((dir, i) => (
                          <div key={i} className="space-y-1">
                            <div className="flex items-center gap-1 text-zinc-200 font-bold">
                              <Folder className="w-3 h-3 text-cyan-500" />
                              <span>{dir.name}/</span>
                            </div>
                            {dir.children.map((sub, j) => (
                              <div key={j} className="pl-3 border-l border-[#131929] ml-1.5 space-y-1">
                                {sub.type === 'dir' ? (
                                  <>
                                    <div className="flex items-center gap-1 text-zinc-300">
                                      <Folder className="w-3 h-3 text-cyan-600" />
                                      <span>{sub.name}/</span>
                                    </div>
                                    {sub.children?.map((file, k) => (
                                      <div key={k} className="pl-3 border-l border-[#131929] ml-1.5 flex items-center justify-between text-[8px] text-zinc-500">
                                        <span className="flex items-center gap-1 text-gray-400">
                                          <File className="w-3 h-3 text-emerald-400 shrink-0" />
                                          {file.name}
                                        </span>
                                        <span>{file.lines} L</span>
                                      </div>
                                    ))}
                                  </>
                                ) : (
                                  <div className="flex items-center justify-between text-[8px] text-zinc-500">
                                    <span className="flex items-center gap-1 text-gray-400 font-mono">
                                      <File className="w-3 h-3 text-emerald-400 shrink-0" />
                                      {sub.name}
                                    </span>
                                    <span>{sub.lines} L</span>
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Left Sidebar slide trigger tab sticking out */}
              <button
                type="button"
                onClick={() => setLeftSidebarOpen(!leftSidebarOpen)}
                style={{ 
                  left: leftSidebarOpen ? '288px' : '0px',
                  transition: 'left 300ms cubic-bezier(0.16, 1, 0.3, 1)',
                }}
                className="absolute top-1/2 -translate-y-1/2 z-20 w-5 h-16 bg-[#0c101b] border border-[#131929] border-l-0 text-[#00ff41] hover:bg-zinc-850 hover:text-white rounded-r-md flex items-center justify-center transition-all cursor-pointer font-bold text-[9px] shadow-[2px_0_10px_rgba(0,0,0,0.5)] select-none font-mono"
                title={leftSidebarOpen ? "Hide Library Nodes" : "Show Library Nodes"}
              >
                {leftSidebarOpen ? "◀" : "▶"}
              </button>

              {/* ====================🌌 COLLAPSIBLE RIGHT SIDEBAR: PROPERTIES INSPECTOR & TOOLS 🌌==================== */}
              <div 
                style={{ 
                  width: '320px',
                  transform: rightSidebarOpen ? 'translateX(0)' : 'translateX(100%)',
                  transition: 'transform 300ms cubic-bezier(0.16, 1, 0.3, 1)',
                }}
                className="absolute right-0 top-0 bottom-0 z-20 h-full bg-[#080d15]/97 border-l border-zinc-900/85 backdrop-blur-md flex flex-col p-4 overflow-y-auto select-none"
              >
                {selectedNode ? (
                  /* Selected Node Inspector View */
                  <div className="flex-1 flex flex-col gap-3 h-full text-left">
                    <div className="flex items-center justify-between border-b border-zinc-800 pb-2">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse shrink-0" />
                        <span className="font-bold text-gray-200 uppercase tracking-wider text-[10px] truncate">
                          INSPECT: {selectedNode.name.replace(/_Preset_\d+/i, '').substring(0, 16)}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setSelectedNode(null)}
                        className="text-gray-505 hover:text-white text-[9.5px] px-1.5 py-0.5 bg-black border border-zinc-800 rounded cursor-pointer shrink-0 font-mono"
                      >
                        ✕ Close
                      </button>
                    </div>

                    <div className="space-y-3 flex-1 overflow-y-auto pr-1 scrollbar-thin font-mono text-[10.5px]">
                      <div>
                        <label className="block text-[8px] text-gray-500 uppercase tracking-wider mb-1 font-bold">Ident Label Name</label>
                        <input
                          type="text"
                          value={selectedNode.name}
                          onChange={(e) => {
                            const updated = { ...selectedNode, name: e.target.value };
                            setSelectedNode(updated);
                            onUpdateNode(updated);
                          }}
                          className="w-full bg-black/60 border border-zinc-800 rounded px-2.5 py-1 text-xs text-gray-205 outline-none focus:border-cyan-400 font-mono"
                        />
                      </div>

                      <div>
                        <label className="block text-[8px] text-gray-500 uppercase tracking-wider mb-1 font-bold">Agent Layer Role</label>
                        <select
                          value={selectedNode.type}
                          onChange={(e) => {
                            const updated = { ...selectedNode, type: e.target.value as AgentNodeType };
                            setSelectedNode(updated);
                            onUpdateNode(updated);
                          }}
                          className="w-full bg-black/60 border border-zinc-800 rounded px-2 py-1 text-xs text-gray-200 outline-none font-mono"
                        >
                          <option value="IngressRouter">Inbound Gateway / Router</option>
                          <option value="TaskPlanner">Decision Planner</option>
                          <option value="LocalInference">Model Local Inference</option>
                          <option value="ToolExecutor">Exec Tool Call</option>
                          <option value="ResponseAggregator">Output Collector</option>
                        </select>
                      </div>

                      <div>
                        <label className="block text-[8px] text-gray-500 uppercase tracking-wider mb-1 font-bold">Target Model Catalog</label>
                        {discoveredModels && discoveredModels.length > 0 ? (
                          <select
                            value={selectedNode.modelName}
                            onChange={(e) => {
                              const updated = { ...selectedNode, modelName: e.target.value };
                              setSelectedNode(updated);
                              onUpdateNode(updated);
                            }}
                            className="w-full bg-black/60 border border-zinc-800 rounded px-2 py-1 text-xs text-gray-100 outline-none font-mono"
                          >
                            {!discoveredModels.some(m => m.name === selectedNode.modelName) && (
                              <option value={selectedNode.modelName}>{selectedNode.modelName}</option>
                            )}
                            {discoveredModels.map(m => (
                              <option key={m.name} value={m.name}>{m.displayName || m.name}</option>
                            ))}
                          </select>
                        ) : (
                          <input
                            type="text"
                            value={selectedNode.modelName}
                            onChange={(e) => {
                              const updated = { ...selectedNode, modelName: e.target.value };
                              setSelectedNode(updated);
                              onUpdateNode(updated);
                            }}
                            className="w-full bg-black/60 border border-zinc-800 rounded px-2.5 py-1 text-xs text-gray-200 outline-none font-mono"
                          />
                        )}
                      </div>

                      <div>
                        <label className="block text-[8px] text-gray-500 uppercase tracking-wider mb-1 font-bold">Accelerator Core</label>
                        <select
                          value={selectedNode.processor}
                          onChange={(e) => {
                            const updated = { ...selectedNode, processor: e.target.value as NodeProcessor };
                            setSelectedNode(updated);
                            onUpdateNode(updated);
                          }}
                          className="w-full bg-black/60 border border-zinc-800 rounded px-2 py-1 text-xs text-gray-202 outline-none font-mono"
                        >
                          <option value="NPU-Local">Local NPU Core</option>
                          <option value="GPU-TensorCore">Local GPU Core</option>
                          <option value="CPU">Node Pinned CPU</option>
                          <option value="Remote-Cloud">Remote Fallback Cloud</option>
                        </select>
                      </div>

                      <div className="bg-black/40 border border-[#141b2e] rounded p-2 text-[8px] text-zinc-500 space-y-1 leading-normal font-mono">
                        <div className="flex justify-between">
                          <span>SRAM MEM ADDRESS</span>
                          <span className="text-[#00ff41] font-bold">0x7F9B{selectedNode.name.charCodeAt(0).toString(16).toUpperCase()}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>CONCURRENCY LOCK REGISTER</span>
                          <span className="text-white font-semibold">STABLE_THREAD_LOCK</span>
                        </div>
                      </div>

                      {/* Manual fast edge wire connecter under selected inspect node */}
                      <div className="bg-[#0b0f17] border border-[#141b2e] rounded-xl p-3 space-y-2.5 mt-1">
                        <span className="font-bold text-[9px] text-[#00ff41] uppercase tracking-wider flex items-center gap-1 font-mono">
                          <Radio className="w-3.5 h-3.5 text-cyan-400" />
                          LINKED PIPES ({edges.filter(e => e.source === selectedNode.id).length} OUT)
                        </span>

                        <div className="space-y-1 bg-black/40 p-2 rounded border border-zinc-850">
                          <span className="block text-[7px] text-zinc-500 uppercase font-bold text-left">Link Pipe to Target:</span>
                          <div className="grid grid-cols-2 gap-1.5">
                            <select
                              id="target-node-inspector-select"
                              className="bg-[#0e111a] border border-[#141b2e] text-[9.5px] px-1 py-1 text-zinc-350 outline-none rounded font-mono"
                              defaultValue=""
                            >
                              <option value="">Select Target</option>
                              {nodes.filter(n => n.id !== selectedNode.id).map(n => (
                                <option key={n.id} value={n.id}>{n.name.substring(0, 15)}</option>
                              ))}
                            </select>
                            <button
                              type="button"
                              onClick={() => {
                                const selectEl = document.getElementById('target-node-inspector-select') as HTMLSelectElement;
                                if (selectEl && selectEl.value) {
                                  const exists = edges.some(edge => edge.source === selectedNode.id && edge.target === selectEl.value);
                                  if (!exists) {
                                    onAddEdge({
                                      id: `edge_${Date.now()}`,
                                      source: selectedNode.id,
                                      target: selectEl.value,
                                      transportType: 'Channel',
                                      latencyNs: 2500,
                                    });
                                  }
                                  selectEl.value = "";
                                }
                              }}
                              className="bg-cyan-950/60 border border-cyan-800/80 hover:bg-cyan-900 rounded text-[8px] font-bold text-cyan-400 uppercase py-1 cursor-pointer font-mono"
                            >
                              + Wire Link
                            </button>
                          </div>
                        </div>

                        <div className="space-y-1 select-none">
                          {edges.filter(e => e.source === selectedNode.id).map(edge => {
                            const destNode = nodes.find(n => n.id === edge.target);
                            if (!destNode) return null;
                            return (
                              <div key={edge.id} className="flex items-center justify-between bg-black/40 border border-[#141b2e] rounded p-1 text-[8.5px] font-mono">
                                <span className="text-zinc-350 truncate max-w-[150px]">➡️ {destNode.name.replace(/_Preset_\d+/i, '')}</span>
                                <button
                                  type="button"
                                  onClick={() => onDeleteEdge(edge.id)}
                                  className="text-zinc-550 hover:text-rose-455 transition cursor-pointer"
                                  title="Sever pipeline wire"
                                >
                                  <Trash2 className="w-3 h-3 text-rose-500" />
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>

                    <div className="pt-2 border-t border-zinc-800">
                      <button
                        type="button"
                        onClick={() => {
                          onDeleteNode(selectedNode.id);
                          setSelectedNode(null);
                        }}
                        className="w-full flex items-center justify-center gap-1 px-3 py-2 bg-rose-950/30 hover:bg-rose-950/60 border border-rose-900 text-[10px] text-rose-400 font-bold tracking-wider uppercase transition rounded-xl cursor-pointer font-mono"
                      >
                        <Trash2 className="w-3.5 h-3.5 text-rose-500" />
                        Dismantle Node
                      </button>
                    </div>
                  </div>
                ) : (
                  /* Fallback View: Scaffold Node, Wires builder, dependency analyzer */
                  <div className="flex-1 flex flex-col gap-3 text-left font-mono h-full">
                    <div className="border-b border-[#121829] pb-1.5 shrink-0 select-none">
                      <span className="font-mono text-[10px] font-bold text-zinc-400 uppercase tracking-widest flex items-center gap-1">
                        <Sliders className="w-3.5 h-3.5 text-[#00ff41]" />
                        WORKSPACE UTILITIES
                      </span>
                      <p className="text-[8px] text-zinc-500 font-sans mt-0.5 leading-normal">Click any node in the graph workspace to customize its local variables / memory registers.</p>
                    </div>

                    <div className="flex-1 overflow-y-auto space-y-3 pr-1 scrollbar-thin select-text text-[10px]">
                      {/* Blast Radius gauge ratio */}
                      <div className="bg-black/55 border border-zinc-900 rounded-xl p-2.5 flex items-center gap-3 select-none shrink-0 border-[#141b2e]">
                        <div className="relative w-11 h-11 shrink-0 flex items-center justify-center">
                          <svg className="w-full h-full transform -rotate-90">
                            <circle cx="22" cy="22" r="18" stroke="#111622" strokeWidth="2.5" fill="transparent" />
                            <circle cx="22" cy="22" r="18" stroke="#f43f5e" strokeWidth="3" fill="transparent" 
                              strokeDasharray="113"
                              strokeDashoffset={113 - (113 * blastRadiusScore) / 100}
                              className="transition-all duration-500"
                            />
                          </svg>
                          <span className="absolute text-[8px] font-bold text-rose-400 font-mono">{blastRadiusScore}%</span>
                        </div>
                        <div className="min-w-0 flex-1 leading-normal text-left">
                          <span className="block text-[7px] text-zinc-500 uppercase tracking-wider font-semibold">ALL GRAVITY DISRUPT RATIO</span>
                          <span className="text-[8.5px] text-zinc-300 font-bold block mt-0.5">GRAVITY: ACTIVE BALANCE</span>
                        </div>
                      </div>

                      {/* Scaffold form */}
                      <div className="bg-[#0e111a]/85 border border-[#141b2e] rounded-xl p-3 space-y-2.5 text-left">
                        <span className="font-bold text-[8.5px] text-[#00ff41] uppercase tracking-wider flex items-center gap-1">
                          <Plus className="w-3 h-3" />
                          SCAFFOLD AGENT NODE
                        </span>
                        <form onSubmit={handleCreateNode} className="space-y-2">
                          <div>
                            <label className="block text-[7px] text-zinc-500 uppercase mb-0.5">Node Label Name</label>
                            <input
                              type="text"
                              required
                              placeholder="e.g. Decoder_Unit_X"
                              value={newName}
                              onChange={(e) => setNewName(e.target.value)}
                              className="w-full bg-black/60 border border-[#141b2e] rounded px-2 px-1.5 py-1 text-xs text-gray-202 outline-none focus:border-emerald-500 font-mono"
                            />
                          </div>

                          <div className="grid grid-cols-2 gap-1">
                            <div>
                              <select
                                value={newType}
                                onChange={(e) => setNewType(e.target.value as AgentNodeType)}
                                className="w-full bg-black/60 border border-[#141b2e] rounded px-1 py-1 text-[9.5px] text-zinc-350 outline-none font-mono"
                              >
                                <option value="IngressRouter">Router Node</option>
                                <option value="TaskPlanner">Planner Node</option>
                                <option value="LocalInference">LLM Inference</option>
                                <option value="ToolExecutor">Tool Handler</option>
                                <option value="ResponseAggregator">Collector</option>
                              </select>
                            </div>
                            <div>
                              <select
                                value={newProcessor}
                                onChange={(e) => setNewProcessor(e.target.value as NodeProcessor)}
                                className="w-full bg-[#0c101b] border border-[#141b2e] rounded px-1 py-1 text-[9.5px] text-zinc-350 outline-none font-mono"
                              >
                                <option value="NPU-Local">Local NPU</option>
                                <option value="GPU-TensorCore">Local GPU</option>
                                <option value="CPU">Core CPU</option>
                                <option value="Remote-Cloud">Cloud Core</option>
                              </select>
                            </div>
                          </div>

                          <div>
                            {discoveredModels && discoveredModels.length > 0 ? (
                              <select
                                value={newModel}
                                onChange={(e) => setNewModel(e.target.value)}
                                className="w-full bg-[#0c101b] border border-[#141b2e] rounded px-1 py-1 text-[9.5px] text-zinc-350 outline-none font-mono"
                              >
                                {discoveredModels.map(m => (
                                  <option key={m.name} value={m.name}>{m.displayName || m.name}</option>
                                ))}
                              </select>
                            ) : (
                              <input
                                type="text"
                                value={newModel}
                                onChange={(e) => setNewModel(e.target.value)}
                                className="w-full bg-black/60 border border-[#141b2e] rounded px-2 py-1 text-[9.5px] text-zinc-350 outline-none font-mono"
                              />
                            )}
                          </div>

                          <button
                            type="submit"
                            className="w-full bg-[#00ff41] hover:bg-[#00cc33] text-black font-bold text-[9px] py-1.5 rounded font-mono transition uppercase flex items-center justify-center gap-1 cursor-pointer"
                          >
                            <Plus className="w-3 h-3 text-black" /> Scaffold Node
                          </button>
                        </form>
                      </div>

                      {/* Create Edge form */}
                      <div className="bg-[#0e111a]/85 border border-[#141b2e] rounded-xl p-3 space-y-2.5 text-left">
                        <span className="font-bold text-[8.5px] text-[#00ff41] uppercase tracking-wider flex items-center gap-1 font-mono">
                          <Radio className="w-3 h-3" />
                          CONNECT LINK PIPES
                        </span>
                        <form onSubmit={handleCreateEdge} className="space-y-2">
                          <div className="grid grid-cols-2 gap-1.5">
                            <select
                              value={sourceId}
                              onChange={(e) => setSourceId(e.target.value)}
                              className="bg-black/60 border border-[#141b2e] rounded px-1 py-1 text-[9px] text-zinc-300 outline-none font-mono"
                            >
                              <option value="">Source</option>
                              {nodes.map(n => (
                                <option key={n.id} value={n.id}>{n.name.substring(0, 12)}</option>
                              ))}
                            </select>
                            <select
                              value={targetId}
                              onChange={(e) => setTargetId(e.target.value)}
                              className="bg-black/60 border border-[#141b2e] rounded px-1 py-1 text-[9px] text-zinc-300 outline-none font-mono"
                            >
                              <option value="">Target</option>
                              {nodes.map(n => (
                                <option key={n.id} value={n.id}>{n.name.substring(0, 12)}</option>
                              ))}
                            </select>
                          </div>

                          <select
                            value={edgeTransport}
                            onChange={(e) => setEdgeTransport(e.target.value as any)}
                            className="w-full bg-black/60 border border-[#141b2e] rounded px-1.5 py-1 text-[9px] text-zinc-300 outline-none font-mono"
                          >
                            <option value="Channel">Go Channel (Lock-Safe)</option>
                            <option value="ZeroCopyRing">Lock-Free Ring</option>
                            <option value="SharedMemory">CGo SHM Pointer</option>
                            <option value="gRPC">Low-Latency gRPC Stream</option>
                          </select>

                          <button
                            type="submit"
                            disabled={!sourceId || !targetId}
                            className={`w-full font-bold text-[9px] py-1.5 rounded transition font-mono uppercase flex items-center justify-center gap-1 ${
                              sourceId && targetId 
                                ? 'bg-cyan-500 hover:bg-cyan-400 text-black cursor-pointer' 
                                : 'bg-zinc-900 text-zinc-700 cursor-not-allowed border border-zinc-950'
                            }`}
                          >
                            <ArrowRight className="w-3 h-3 text-black" /> Link Pipe
                          </button>
                        </form>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Right Sidebar slide trigger tab sticking out */}
              <button
                type="button"
                onClick={() => setRightSidebarOpen(!rightSidebarOpen)}
                style={{ 
                  right: rightSidebarOpen ? '320px' : '0px',
                  transition: 'right 300ms cubic-bezier(0.16, 1, 0.3, 1)',
                }}
                className="absolute top-1/2 -translate-y-1/2 z-20 w-5 h-16 bg-[#0c101b] border border-gray-900 border-r-0 text-cyan-405 hover:bg-zinc-800 hover:text-white rounded-l-md flex items-center justify-center transition-all cursor-pointer font-bold text-[9px] shadow-[-2px_0_10px_rgba(0,0,0,0.5)] select-none font-mono"
                title={rightSidebarOpen ? "Hide Customizer Drawer" : "Show Customizer Drawer"}
              >
                {rightSidebarOpen ? "▶" : "◀"}
              </button>

              {/* Massive Canvas Area */}
              <div 
                id="constellation-scroll-container"
                ref={canvasRef}
                onMouseDown={handleCanvasMouseDown}
                onMouseMove={handleCanvasMouseMove}
                onMouseUp={handleCanvasMouseUp}
                onMouseLeave={handleCanvasMouseUp}
                onDragOver={handleCanvasDragOver}
                onDrop={handleCanvasDrop}
                onClick={() => setLinkingSourceId(null)}
                className="absolute inset-0 w-full h-full bg-[#03060a] overflow-hidden select-none cursor-grab active:cursor-grabbing z-10"
              >
                {/* Floating Navigation HUD (Static viewport HUD) */}
                <div className="absolute top-3 left-3 bg-black/90 border border-zinc-800/85 px-2.5 py-1.5 rounded font-mono text-[8.5px] text-[#00ff41] z-30 flex flex-col gap-1 shadow-lg pointer-events-none text-left">
                  <div className="flex items-center gap-1 font-bold">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    <span>🌌 PLANETARY NEBULAE DESIGNER</span>
                  </div>
                  <div className="text-zinc-400 leading-normal font-sans">
                    • DRAG nodes inside viewport to relocate.<br />
                    • SHIFT/WHEEL or drag background to pan & zoom ({Math.round(zoom * 100)}%).<br />
                    • LINK nodes: Drag orange circles onto candidate ports.<br />
                    • SELECT: Click node to customize registers inline.
                  </div>
                </div>

                {/* Interactive Zoom HUD Buttons */}
                <div className="absolute bottom-4 right-4 bg-black/90 border border-zinc-800 p-1.5 rounded z-30 flex items-center gap-1.5 shadow-xl font-mono">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setZoom(z => Math.max(0.4, z - 0.1));
                    }}
                    className="w-6 h-6 bg-zinc-900 border border-zinc-750 hover:bg-zinc-800 hover:border-[#00ff41] rounded text-[#00ff41] flex items-center justify-center font-bold text-xs select-none transition cursor-pointer"
                    title="Zoom Out"
                  >
                    -
                  </button>
                  <span className="text-[9px] text-gray-400 font-mono w-10 text-center select-none">
                    {Math.round(zoom * 100)} %
                  </span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setZoom(z => Math.min(2.0, z + 0.1));
                    }}
                    className="w-6 h-6 bg-zinc-900 border border-zinc-750 hover:bg-zinc-800 hover:border-[#00ff41] rounded text-[#00ff41] flex items-center justify-center font-bold text-xs select-none transition cursor-pointer"
                    title="Zoom In"
                  >
                    +
                  </button>
                  <div className="h-4 w-[1px] bg-zinc-800" />
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setZoom(0.9);
                      setPan({ x: 50, y: 50 });
                    }}
                    className="px-1.5 py-1 bg-zinc-900 border border-zinc-750 rounded text-[9px] text-gray-300 hover:text-cyan-400 hover:border-cyan-500/50 tracking-tighter select-none transition cursor-pointer"
                    title="Reset viewport transform"
                  >
                    RESET
                  </button>
                </div>

                {/* Massive 2400x1200 inner coordinate grid matching zoom & translation positions */}
                <div 
                  id="constellation-bg-grid"
                style={{
                  transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                  transformOrigin: '0 0',
                }}
                className="w-[2400px] h-[1200px] relative bg-[radial-gradient(#111622_1.2px,transparent_1.2px)] [background-size:20px_20px] overflow-hidden transition-transform duration-75 ease-out canvas-bg-grid"
              >

                {nodes.length === 0 ? (
                  <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-6 text-gray-600 font-mono text-xs max-w-none z-10 leading-relaxed">
                    <HelpCircle className="w-9 h-9 stroke-[1.1] mb-2 text-gray-700" />
                    <span>No nodes active. Switch to <strong>APK Sequential</strong> or drag modules here to begin compiling logic sequences.</span>
                  </div>
                ) : (
                  <>
                    <svg className="absolute inset-0 w-[2400px] h-[1200px] pointer-events-none z-0">
                      <defs>
                        <marker id="arrow" viewBox="0 0 10 10" refX="18" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                          <path d="M 0 0 L 10 5 L 0 10 z" fill="#1e293b" />
                        </marker>
                      </defs>

                      {/* Linking cable drafts */}
                      {(() => {
                        const srcItemForLinking = nodes.find(n => n.id === linkingSourceId);
                        if (srcItemForLinking) {
                          const srcX = srcItemForLinking.x + 36;
                          const srcY = srcItemForLinking.y + 36;
                          const tgtX = currentMousePos.x;
                          const tgtY = currentMousePos.y;
                          
                          const dx = tgtX - srcX;
                          const cp1x = srcX + dx * 0.5;
                          const cp1y = srcY;
                          const cp2x = srcX + dx * 0.5;
                          const cp2y = tgtY;
                          const curveData = `M ${srcX} ${srcY} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${tgtX} ${tgtY}`;

                          return (
                            <g>
                              <path 
                                d={curveData} 
                                fill="none" 
                                stroke="#eab308" 
                                strokeWidth="3" 
                                strokeDasharray="5,5" 
                                className="opacity-90 animate-[pulse_1.5s_infinite]"
                                style={{ filter: 'drop-shadow(0 0 5px rgba(234,179,8,0.7))' }}
                              />
                              <circle cx={tgtX} cy={tgtY} r="5" fill="#eab308" className="animate-ping" />
                              <circle cx={tgtX} cy={tgtY} r="3" fill="#ffffff" />
                            </g>
                          );
                        }
                        return null;
                      })()}

                      {/* rendering connection wires with animated particle packets (green by default) */}
                      {edges.map((edge) => {
                        const srcItem = nodes.find(n => n.id === edge.source);
                        const tgtItem = nodes.find(n => n.id === edge.target);
                        if (!srcItem || !tgtItem) return null;

                        const srcX = srcItem.x + 36;
                        const srcY = srcItem.y + 36;
                        const tgtX = tgtItem.x + 36;
                        const tgtY = tgtItem.y + 36;

                        const dx = tgtX - srcX;
                        const cp1x = srcX + dx * 0.5;
                        const cp1y = srcY;
                        const cp2x = srcX + dx * 0.5;
                        const cp2y = tgtY;
                        const curveData = `M ${srcX} ${srcY} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${tgtX} ${tgtY}`;

                        const esty = getEdgeStyle(edge.transportType);
                        const speed = isSimulating ? '0.7s' : '3.0s';

                        return (
                          <g key={edge.id} className="group/wire">
                            <path d={curveData} fill="none" stroke="transparent" strokeWidth="12" className="cursor-pointer" />
                            <path 
                              d={curveData} 
                              fill="none" 
                              stroke={esty.stroke} 
                              strokeWidth="2.5" 
                              strokeDasharray={esty.dash}
                              className="opacity-70 group-hover/wire:opacity-100 transition duration-150"
                              style={{ filter: 'drop-shadow(0 0 2.5px ' + esty.stroke + ')' }}
                            />
                            <circle r="4.5" fill="#00ff41" className="filter drop-shadow-[0_0_6px_#00ff41]">
                              <animateMotion dur={speed} repeatCount="indefinite" path={curveData} />
                            </circle>
                          </g>
                        );
                      })}
                    </svg>

                    {/* Circular planet nodes layout */}
                    <div className="absolute inset-0 pointer-events-none z-10 w-[2400px] h-[1200px]">
                      {nodes.map((node) => {
                        const isSelected = selectedNode?.id === node.id;
                        const theme = getNodeColorTheme(node.type);

                        const getRoleIcon = (type: AgentNodeType) => {
                          switch (type) {
                            case 'IngressRouter': return <Compass className="w-5 h-5 text-cyan-405" />;
                            case 'TaskPlanner': return <Brain className="w-5 h-5 text-amber-500" />;
                            case 'LocalInference': return <Cpu className="w-5 h-5 text-emerald-450" />;
                            case 'ToolExecutor': return <Zap className="w-5 h-5 text-violet-400 animate-pulse" />;
                            case 'ResponseAggregator': return <Layers className="w-5 h-5 text-rose-405" />;
                            default: return <HelpCircle className="w-5 h-5 text-gray-400" />;
                          }
                        };

                        return (
                          <div
                            key={node.id}
                            style={{ left: `${node.x}px`, top: `${node.y}px`, position: 'absolute' }}
                            onMouseDown={(e) => {
                              if (linkingSourceId) return;
                              handleNodeMouseDown(node.id, e);
                            }}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (linkingSourceId) {
                                  if (linkingSourceId !== node.id) {
                                    const exists = edges.some(edge => edge.source === linkingSourceId && edge.target === node.id);
                                    if (!exists) {
                                      onAddEdge({
                                        id: `edge_${Date.now()}`,
                                        source: linkingSourceId,
                                        target: node.id,
                                        transportType: 'Channel',
                                        latencyNs: 2500,
                                      });
                                    }
                                  }
                                  setLinkingSourceId(null);
                              } else {
                                setSelectedNode(node);
                              }
                            }}
                            className={`w-[72px] h-[72px] rounded-full border-[2px] bg-[#0c0e14] pointer-events-auto cursor-grab active:cursor-grabbing flex flex-col items-center justify-center transition hover:scale-[1.06] select-none ${theme.glow} ${
                              isSelected ? 'border-white ring-4 ring-white/10' : ''
                            }`}
                          >
                            {/* Input Port */}
                            <div 
                              className="absolute left-[-5px] top-[28px] w-3 h-3 rounded-full border border-gray-750 bg-zinc-950 flex items-center justify-center cursor-crosshair z-30"
                              title="Connect target wire here"
                            >
                              <div className="w-1 h-1 bg-gray-500 rounded-full" />
                            </div>

                            {/* Output Port */}
                            <div 
                              className="absolute right-[-5px] top-[28px] w-3 h-3 rounded-full border border-amber-500/60 bg-amber-950/80 flex items-center justify-center hover:scale-125 transition cursor-crosshair z-30"
                              onMouseDown={(e) => {
                                e.stopPropagation();
                                setLinkingSourceId(node.id);
                                setCurrentMousePos({ x: node.x + 36, y: node.y + 36 });
                              }}
                              title="Drag connection wire from here"
                            >
                              <div className="w-1 h-1 bg-amber-500 rounded-full" />
                            </div>

                            <div className="relative">
                              {getRoleIcon(node.type)}
                              <span className={`absolute -top-1 -right-1 w-2 h-2 rounded-full ${theme.dot} shadow-[0_0_5px_currentColor]`} />
                            </div>

                            <div className="absolute -bottom-5 left-1/2 -translate-x-1/2 bg-black/80 px-1.5 py-0.5 rounded border border-gray-900 text-[8px] text-gray-300 font-bold uppercase tracking-tight truncate max-w-[95px] text-center whitespace-nowrap">
                              {node.name.replace(/_Preset_\d+/i, '').substring(0, 12)}
                            </div>
                            <span className="text-[7px] text-gray-500 font-mono mt-1 font-bold">
                              {node.processor === 'NPU-Local' ? 'NPU' : node.processor === 'GPU-TensorCore' ? 'GPU' : 'CPU'}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
          ) : (
            /* ====================📱📱📱 APK SEQUENTIAL WORKSPACE 📱📱📱==================== */
            <div className="flex-1 flex overflow-hidden w-full relative min-h-[440px]">
              
              {/* Sequential left scroll grid containing Logic Blocks snap nodes */}
              <div id="sequential-wireflow-list" className="flex-1 overflow-y-auto pr-1 py-1 space-y-0 relative z-10 max-h-[470px]">
                
                {/* Simulated Scenarios configuration banner trigger */}
                <div className="mb-4 bg-zinc-950/85 p-3 rounded-lg border border-zinc-900 select-none font-mono text-[10px]">
                  <div className="flex items-center justify-between mb-2 pb-1 border-b border-zinc-900 text-gray-400">
                    <span className="font-bold uppercase tracking-widest text-[#00ff41] flex items-center gap-1">
                      <Sliders className="w-3.5 h-3.5" />
                      SIMULATED WIRE SCENARIO CHANNELS
                    </span>
                    <span className="text-[9px] bg-black px-1.5 py-0.5 border border-zinc-800 rounded font-semibold">DEBUGGER</span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-1.5">
                    <button
                      type="button"
                      onClick={() => setSimScenario('success')}
                      className={`px-2 py-1.5 rounded border text-left flex items-center gap-2 transition cursor-pointer ${
                        simScenario === 'success' 
                          ? 'bg-emerald-950/40 text-emerald-400 border-emerald-500/50' 
                          : 'bg-black/40 border-transparent text-gray-500 hover:text-gray-300'
                      }`}
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                      💚 Flow Success Stream
                    </button>
                    <button
                      type="button"
                      onClick={() => setSimScenario('failure_permission')}
                      className={`px-2 py-1.5 rounded border text-left flex items-center gap-2 transition cursor-pointer ${
                        simScenario === 'failure_permission' 
                          ? 'bg-rose-950/40 text-rose-400 border-rose-500/50' 
                          : 'bg-black/40 border-transparent text-gray-500 hover:text-gray-300'
                      }`}
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
                      🚫 Read Variable Halted
                    </button>
                    <button
                      type="button"
                      onClick={() => setSimScenario('failure_timeout')}
                      className={`px-2 py-1.5 rounded border text-left flex items-center gap-2 transition cursor-pointer ${
                        simScenario === 'failure_timeout' 
                          ? 'bg-amber-950/40 text-amber-500 border-amber-500/50' 
                          : 'bg-black/40 border-transparent text-gray-500 hover:text-gray-300'
                      }`}
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                      ⚡ NPU Queue Throttle
                    </button>
                  </div>
                </div>

                {/* Snappy sequential list loop */}
                {sortedSequentialNodes.length === 0 ? (
                  <div className="text-center p-8 bg-zinc-950/40 rounded-xl border border-dashed border-zinc-900 text-gray-500 font-sans leading-normal my-4">
                    <Workflow className="w-8 h-8 text-zinc-800 mx-auto mb-2 animate-bounce" />
                    <span>No workflow steps present in the sequence. Click the modules in the <strong>Variable Presets Drawer on the right</strong> 👉 to snap your first logic operations sequentially!</span>
                  </div>
                ) : (
                  sortedSequentialNodes.map((node, index) => {
                    const isSelected = selectedNode?.id === node.id;
                    const nodeTheme = getNodeColorTheme(node.type);
                    
                    // Cable Wires logic calculations
                    const isLast = index === sortedSequentialNodes.length - 1;
                    
                    // Determine wire state out of this step
                    let wireColor = 'emerald'; // success standard
                    let wirePulse = true;
                    let wireHalted = false;
                    let wireErrorMsg = '';

                    if (simScenario === 'failure_permission') {
                      // Halts immediately after index 1 (Step 2 "TaskPlanner" or "Condition check")
                      if (index === 1) {
                        wireColor = 'rose';
                        wirePulse = false;
                        wireHalted = true;
                        wireErrorMsg = '🔒 FATAL HALT: Read/permission check failed to compile user secret parameters.';
                      } else if (index > 1) {
                        wireColor = 'offline';
                        wirePulse = false;
                        wireHalted = true;
                      }
                    } else if (simScenario === 'failure_timeout') {
                      // Halts at Step 3 Local Inference execution (index 2)
                      if (index === 2) {
                        wireColor = 'amber';
                        wirePulse = true; // heavy pulsating
                        wireHalted = true;
                        wireErrorMsg = '⚠️ TIMEOUT: Silicon NPU allocation capacity spillover. Concurrency throttled.';
                      } else if (index > 2) {
                        wireColor = 'offline';
                        wirePulse = false;
                        wireHalted = true;
                      }
                    }

                    return (
                      <div key={node.id} className="flex flex-col items-center">
                        
                        {/* THE LOGIC BLOCK CARD - rounded-2xl glass design */}
                        <div
                          onClick={() => setSelectedNode(node)}
                          className={`w-full max-w-lg bg-gradient-to-b from-[#0e111a] to-[#0a0c12] border rounded-2xl p-4 cursor-pointer relative transition duration-200 select-none ${
                            isSelected 
                              ? 'border-white shadow-[0_0_20px_rgba(255,255,255,0.08)] ring-1 ring-white/20' 
                              : 'border-zinc-900 hover:border-[#00ff41]/40 hover:bg-[#101322]/80'
                          } ${
                            node.status === 'error' || (wireHalted && index === sortedSequentialNodes.length - 1) 
                              ? 'border-rose-950 animate-border-error-pulse bg-rose-950/5' 
                              : ''
                          }`}
                        >
                          {/* Card top row header */}
                          <div className="flex items-center justify-between border-b border-zinc-900/80 pb-2.5 mb-2.5">
                            <div className="flex items-center gap-2.5">
                              {/* Step indicator badge */}
                              <span className={`text-[8px] font-mono font-bold px-2 py-0.5 rounded-full uppercase tracking-wider ${
                                index === 0 ? 'bg-cyan-950 text-cyan-400' :
                                index === 1 ? 'bg-amber-950 text-amber-500' :
                                index === 2 ? 'bg-emerald-950 text-emerald-400' :
                                index === 3 ? 'bg-violet-950 text-violet-400' :
                                'bg-rose-950 text-rose-400'
                              }`}>
                                Step {index + 1}
                              </span>
                              
                              <div className="flex items-center gap-1.5">
                                <span className="w-2 h-2 rounded-full bg-[#00ff41] animate-pulse" />
                                <span className="font-mono text-xs font-bold text-gray-200 uppercase tracking-tight truncate max-w-[150px]">
                                  {node.name.replace(/_preset_\d+/i, '').substring(0, 20)}
                                </span>
                              </div>
                            </div>
                            
                            {/* Sequence sorting controls & action buttons (Designed perfect for tiny mobile touch-targets!) */}
                            <div className="flex items-center gap-1.5 shrink-0" onClick={(e) => e.stopPropagation()}>
                              <button
                                type="button"
                                onClick={() => handleMoveUp(index)}
                                disabled={index === 0}
                                className="p-1 rounded bg-[#161a26] border border-zinc-850 hover:bg-black text-gray-450 hover:text-white transition disabled:opacity-30 disabled:hover:bg-[#161a26]"
                                title="Snap Sequence Upwards"
                              >
                                <ArrowUp className="w-3 h-3" />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleMoveDown(index)}
                                disabled={index === sortedSequentialNodes.length - 1}
                                className="p-1 rounded bg-[#161a26] border border-zinc-850 hover:bg-black text-gray-450 hover:text-white transition disabled:opacity-30 disabled:hover:bg-[#161a26]"
                                title="Snap Sequence Downwards"
                              >
                                <ArrowDown className="w-3 h-3" />
                              </button>
                              <button
                                type="button"
                                onClick={() => onDeleteNode(node.id)}
                                className="p-1 rounded bg-rose-950/20 border border-rose-900/30 hover:bg-rose-900/40 text-rose-450 transition ml-1"
                                title="Sever & Delete This Block"
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            </div>
                          </div>

                          {/* Block Body containing functional specs */}
                          <div className="grid grid-cols-2 gap-3.5 text-[11px] font-mono text-gray-400">
                            <div className="space-y-1">
                              <span className="block text-[8px] text-gray-500 uppercase tracking-widest">LAYER OPERATION TYPE</span>
                              <div className="flex items-center gap-1.5 text-gray-300 font-bold uppercase text-[9.5px]">
                                <span className={nodeTheme.dot + " w-1.5 h-1.5 rounded-full"} />
                                {node.type.replace('ResponseAggregator', 'Output Collector').replace('LocalInference', 'AI Model Execution')}
                              </div>
                            </div>

                            <div className="space-y-1">
                              <span className="block text-[8px] text-gray-500 uppercase tracking-widest">EXECUTING HARDWARE ACCELERATOR</span>
                              <div className="text-gray-300 font-bold text-[9.5px]">
                                🦾 {node.processor === 'NPU-Local' ? 'Direct NPU Direct-Mapped' : node.processor === 'GPU-TensorCore' ? 'Fallback Tensor Core' : 'Thread CPU'}
                              </div>
                            </div>

                            <div className="space-y-1">
                              <span className="block text-[8px] text-gray-500 uppercase tracking-widest">RUNNING CONFIG MODULE / MODELS</span>
                              <span className="text-[#00e5ff] font-semibold text-[10px] truncate block font-mono">
                                🛸 {node.modelName}
                              </span>
                            </div>

                            <div className="space-y-1">
                              <span className="block text-[8px] text-gray-500 uppercase tracking-widest">WORK QUEUES LIMITS</span>
                              <span className="text-gray-100 font-bold text-[10px]">
                                {node.batchSize}b / {node.concurrencyLimit} Working Threads
                              </span>
                            </div>
                          </div>

                          {/* Show halted warnings inline if simulation is trapped */}
                          {wireHalted && index === (simScenario === 'failure_permission' ? 1 : 2) && (
                            <div className="mt-3 bg-red-950/20 border border-red-500/35 p-2 rounded-lg flex items-start gap-2 text-[10px] text-rose-400 font-sans animate-pulse">
                              <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                              <span>{simScenario === 'failure_permission' ? '🔒 SECURITY TRIGGER HALT: Permission level insufficient on storage state.' : '⚡ ACCELERATOR BLOCKED: Hexagon-SRAM capacity bounds check failure (VRAM overflow).'}</span>
                            </div>
                          )}
                        </div>

                        {/* HIGH FIDELITY COLOR-CODED SVG FLOWPATH WIRE (CONNECTING BLOCKS) */}
                        {!isLast && (
                          <div className="w-full max-w-lg flex flex-col items-center select-none shrink-0 pointer-events-none p-0">
                            
                            {/* Wires glowing paths based on simulator statuses */}
                            <div className="relative h-11 w-6 flex items-center justify-center">
                              {/* SVG path to give smooth fluid neon wires look */}
                              <svg className="absolute inset-0 w-6 h-11 pointer-events-none">
                                <line 
                                  x1="12" y1="0" x2="12" y2="44" 
                                  stroke={
                                    wireColor === 'emerald' ? '#00ff41' :
                                    wireColor === 'rose' ? '#f43f5e' :
                                    wireColor === 'amber' ? '#f59e0b' : '#1e293b'
                                  } 
                                  strokeWidth="3.2" 
                                  className="transition-all duration-300"
                                  style={{
                                    filter: `drop-shadow(0 0 5px ${
                                      wireColor === 'emerald' ? '#00ff41' :
                                      wireColor === 'rose' ? '#f43f5e' :
                                      wireColor === 'amber' ? '#f59e0b' : 'transparent'
                                    })`
                                  }}
                                />
                                
                                {/* Moving physical energy burst packets */}
                                {wirePulse && wireColor !== 'offline' && (
                                  <circle r="4" fill="#ffffff" cx="12" cy="0">
                                    <animate 
                                      attributeName="cy" 
                                      from="0" to="44" 
                                      dur={wireColor === 'emerald' ? "1.4s" : "0.5s"} 
                                      repeatCount="indefinite" 
                                    />
                                  </circle>
                                )}
                              </svg>

                              {/* Alert Warning node markers */}
                              {wireColor === 'rose' && (
                                <span className="absolute w-4 h-4 rounded-full bg-rose-500 border-2 border-white animate-ping" />
                              )}
                              {wireColor === 'amber' && (
                                <span className="absolute w-4 h-4 rounded-full bg-amber-500 border-2 border-white animate-pulse" />
                              )}
                            </div>
                            
                            {/* Text labels alongside wire highlighting compiler decisions */}
                            <div className="text-[7.5px] font-mono tracking-widest text-[#555] uppercase pb-1 leading-none text-center">
                              {wireColor === 'emerald' ? (isSimulating ? 'FAST_PIPE_PULSING_EMERALD' : 'PIPE_ONLINE_SUCCESS') :
                               wireColor === 'rose' ? '🔒 TRIGGERED_HALT_REDO_PERMISSIONS' :
                               wireColor === 'amber' ? '⚡ RINGBUFF_PEAK_CAPACITY_SPILL' : 'UNREACHED_SEGMENT_OFFLINE'}
                            </div>
                          </div>
                        )}
                        
                      </div>
                    );
                  })
                )}
              </div>

              {/* ====================👉👉👉 EXPANDABLE VARIABLE DRAWER PANEL 👉👉👉==================== */}
              {drawerOpen && (
                <div 
                  id="right-presets-variable-drawer" 
                  className="w-80 bg-[#090c13]/95 border-l border-zinc-900 px-3.5 py-4 shrink-0 overflow-y-auto relative animate-fade-in z-20"
                >
                  <div className="flex items-center justify-between border-b border-zinc-900 pb-2 mb-3 select-none">
                    <span className="text-[10px] font-mono font-bold text-gray-300 uppercase tracking-widest flex items-center gap-1">
                      <Sliders className="w-3.5 h-3.5 text-[#00ff41]" />
                      Variable & Preset Drawer
                    </span>
                    <button 
                      onClick={() => setDrawerOpen(false)}
                      className="text-gray-500 hover:text-white text-[10px] font-bold"
                    >
                      ✕
                    </button>
                  </div>

                  <p className="text-[9px] text-gray-500 font-sans leading-relaxed mb-3">
                    Drag or click high-fidelity elements to snap them directly into your active workflow core container:
                  </p>

                  <div className="space-y-4 max-h-[390px] overflow-y-auto pr-1">
                    {/* Iterate over Categories */}
                    {['Variable Helpers', 'Math operations', 'Flow controls', 'Advanced AI Cores'].map((cat) => {
                      const templatesInCat = presetTemplates.filter(p => {
                        if (cat === 'Advanced AI Cores') return p.category === 'Advanced AI Prompt';
                        return p.category.toLowerCase().includes(cat.substring(0, 8).toLowerCase());
                      });

                      return (
                        <div key={cat} className="space-y-1.5 select-all">
                          <span className="block text-[8px] font-bold text-zinc-500 uppercase tracking-widest pl-1.5">
                            {cat}
                          </span>
                          
                          <div className="space-y-1.5">
                            {templatesInCat.map((preset, idx) => (
                              <div
                                key={idx}
                                onClick={() => handleAddPresetNode(preset)}
                                className="group/preset p-2.5 bg-[#0e111a] hover:bg-[#121625] border border-zinc-900 hover:border-[#00ff41]/40 rounded-xl transition duration-150 cursor-pointer flex gap-2.5 shadow-[0_2px_4px_rgba(0,0,0,0.4)]"
                                title="Click to instant snap this block sequentially into the flow pipeline!"
                              >
                                <div className="p-1.5 bg-zinc-950/80 rounded-lg border border-zinc-904 flex items-center justify-center shrink-0 self-start">
                                  {renderPresetIcon(preset.icon)}
                                </div>
                                <div className="space-y-0.5 flex-1 min-w-0">
                                  <div className="flex items-center gap-1 md:gap-1.5 justify-between">
                                    <span className="text-[9.5px] font-bold text-gray-300 group-hover/preset:text-white transition truncate block">
                                      {preset.name}
                                    </span>
                                    <span className="text-[6px] bg-[#00ff41]/5 px-1 py-0.5 rounded text-[#00ff41] font-mono whitespace-nowrap">
                                      + ADD
                                    </span>
                                  </div>
                                  <span className="block text-[7.5px] font-bold text-[#888] font-mono leading-none font-sans uppercase">
                                    {preset.action}
                                  </span>
                                  <p className="text-[8.5px] text-gray-550 font-sans leading-tight">
                                    {preset.desc}
                                  </p>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              
            </div>
          )}

        </div>

        {/* Selected node variables dashboard in-gantry config */}
        {selectedNode && (
          <div id="inspector-action-form" className="mt-4 bg-[#0c1017] p-3.5 rounded-2xl border border-zinc-900 text-xs text-gray-300 space-y-4 relative z-10 select-none">
            
            <div className="flex items-center justify-between border-b border-zinc-900 pb-2.5">
              <div className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse shadow-[0_0_6px_#34d399]" />
                <h5 className="font-mono text-xs font-semibold uppercase text-white">
                  INSPECT CONTAINER PARAMETERS: <strong className="text-[#00ff41] font-mono">{selectedNode.name.replace(/_Preset_\d+/i, '')}</strong>
                </h5>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    onDeleteNode(selectedNode.id);
                    setSelectedNode(null);
                  }}
                  className="flex items-center gap-1 px-2.5 py-1 bg-rose-950/20 hover:bg-rose-900/40 border border-rose-800/40 rounded-lg text-[9px] text-rose-400 transition"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Dismantle Node
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedNode(null)}
                  className="px-2 py-1 bg-black border border-zinc-800 hover:bg-zinc-900 text-gray-400 text-[9px] rounded-lg"
                >
                  ✕ Close panel
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
              <div>
                <label className="block text-[8px] text-gray-500 uppercase tracking-tight mb-1">Ident/Label Name</label>
                <input
                  type="text"
                  value={selectedNode.name}
                  onChange={(e) => {
                    const updated = { ...selectedNode, name: e.target.value };
                    setSelectedNode(updated);
                    onUpdateNode(updated);
                  }}
                  className="w-full bg-black/50 border border-zinc-900 rounded px-2.5 py-1.5 text-xs text-gray-150 outline-none font-mono"
                />
              </div>

              <div>
                <label className="block text-[8px] text-gray-500 uppercase tracking-tight mb-1">Agent Layer Role</label>
                <select
                  value={selectedNode.type}
                  onChange={(e) => {
                    const updated = { ...selectedNode, type: e.target.value as AgentNodeType };
                    setSelectedNode(updated);
                    onUpdateNode(updated);
                  }}
                  className="w-full bg-black/50 border border-zinc-900 rounded px-1.5 py-1.5 text-xs text-gray-150 outline-none font-mono"
                >
                  <option value="IngressRouter">Inbound Gateway / Router</option>
                  <option value="TaskPlanner">Decision Planner</option>
                  <option value="LocalInference">Model Local Inference</option>
                  <option value="ToolExecutor">Exec Tool Call</option>
                  <option value="ResponseAggregator">Output Collector</option>
                </select>
              </div>

              <div>
                <label className="block text-[8px] text-gray-500 uppercase tracking-tight mb-1">Target Model Catalog</label>
                {discoveredModels && discoveredModels.length > 0 ? (
                  <select
                    value={selectedNode.modelName}
                    onChange={(e) => {
                      const updated = { ...selectedNode, modelName: e.target.value };
                      setSelectedNode(updated);
                      onUpdateNode(updated);
                    }}
                    className="w-full bg-black/50 border border-zinc-900 rounded px-1.5 py-1.5 text-xs text-gray-117 outline-none font-mono"
                  >
                    {!discoveredModels.some(m => m.name === selectedNode.modelName) && (
                      <option value={selectedNode.modelName}>{selectedNode.modelName}</option>
                    )}
                    {discoveredModels.map(m => (
                      <option key={m.name} value={m.name}>{m.displayName || m.name}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={selectedNode.modelName}
                    onChange={(e) => {
                      const updated = { ...selectedNode, modelName: e.target.value };
                      setSelectedNode(updated);
                      onUpdateNode(updated);
                    }}
                    className="w-full bg-black/50 border border-zinc-900 rounded px-2.5 py-1 text-xs text-gray-150 outline-none font-mono"
                  />
                )}
              </div>

              <div>
                <label className="block text-[8px] text-gray-500 uppercase tracking-tight mb-1">Accelerator Core</label>
                <select
                  value={selectedNode.processor}
                  onChange={(e) => {
                    const updated = { ...selectedNode, processor: e.target.value as NodeProcessor };
                    setSelectedNode(updated);
                    onUpdateNode(updated);
                  }}
                  className="w-full bg-black/50 border border-zinc-900 rounded px-1.5 py-1.5 text-xs text-gray-150 outline-none font-mono"
                >
                  <option value="NPU-Local">Local NPU Core</option>
                  <option value="GPU-TensorCore">Local GPU Core</option>
                  <option value="CPU">Node Pinned CPU</option>
                  <option value="Remote-Cloud">Remote Fallback Cloud</option>
                </select>
              </div>
            </div>
            
            {/* Extended Micro Settings Slider block to represent precise APK config inputs */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 border-t border-zinc-900 pt-3 text-[10px] text-gray-400">
              <div className="space-y-1">
                <span className="text-gray-500 uppercase text-[7.5px] tracking-wider font-semibold">Active SRAM Address Space</span>
                <span className="block text-[#00ff41] font-bold">SHM_PTR_0x7F9B{Math.floor(1000 + Math.random() * 8999).toString(16).toUpperCase()}</span>
              </div>
              <div className="space-y-1">
                <span className="text-gray-500 uppercase text-[7.5px] tracking-wider font-semibold">CGo Context Pointers</span>
                <span className="block text-white font-semibold">STABLE_COMPRESSED</span>
              </div>
              <div className="space-y-1">
                <span className="text-gray-500 uppercase text-[7.5px] tracking-wider font-semibold">Batch Threads Spill</span>
                <span className="block text-cyan-400 font-bold">100% HARDWARE LOCK_SAFE</span>
              </div>
              <div className="space-y-1">
                <span className="text-gray-500 uppercase text-[7.5px] tracking-wider font-semibold">Workflow Status</span>
                <span className="block text-amber-500 font-bold">STANDBY_IDLE</span>
              </div>
            </div>

          </div>
        )}
      </div>

      {/* 3. RIGHT SIDE CONTROLS COLUMN - Forms & Blast Radius Analyzer */}
      {layoutMode === 'sequential' && (
      <div id="codeflow-right-operations" className="flex flex-col gap-6">

        {/* Dynamic Blast Radius Dependency Analyzer card */}
        <div className="bg-[#0b0e14] border border-gray-900 rounded-xl p-4 flex flex-col gap-3">
          <div className="flex items-center gap-1.5 border-b border-gray-900 pb-2">
            <ShieldAlert className="w-4 h-4 text-rose-500" />
            <span className="font-mono text-[10px] font-bold text-gray-300 uppercase tracking-widest">
              BLAST RADIUS OVERVIEW
            </span>
          </div>

          <div className="flex items-center gap-4 py-1">
            {/* Simple circular gauge graphic */}
            <div className="relative w-16 h-16 shrink-0 flex items-center justify-center">
              <svg className="w-full h-full transform -rotate-90">
                <circle cx="32" cy="32" r="28" stroke="#111622" strokeWidth="4" fill="transparent" />
                <circle cx="32" cy="32" r="28" stroke="url(#blastGrad)" strokeWidth="4.5" fill="transparent" 
                  strokeDasharray="175"
                  strokeDashoffset={175 - (175 * blastRadiusScore) / 100}
                  className="transition-all duration-500"
                />
                <defs>
                  <linearGradient id="blastGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#f43f5e" />
                    <stop offset="100%" stopColor="#f59e0b" />
                  </linearGradient>
                </defs>
              </svg>
              <span className="absolute text-xs font-bold font-mono text-rose-400">
                {blastRadiusScore}%
              </span>
            </div>

            <div>
              <div className="text-[10px] text-gray-400 uppercase tracking-tight font-bold">
                {selectedNode ? selectedNode.name.replace(/_Preset_\d+/i, '') : 'All System Gravity'}
              </div>
              <p className="text-[9px] text-[#555] leading-normal font-sans mt-0.5">
                Calculates computational blast risk scope. Saturated locks on this channel impacts execution queues.
              </p>
            </div>
          </div>

          <div className="bg-black/40 p-2.5 rounded border border-gray-900 text-[10px] space-y-1.5 text-gray-400">
            <div className="flex justify-between items-center">
              <span>Direct Link Gravity</span>
              <span className="text-white font-bold">{selectedNode ? edges.filter(e => e.source === selectedNode.id || e.target === selectedNode.id).length : edges.length} Active</span>
            </div>
            <div className="flex justify-between items-center">
              <span>CGo Intercept Scope</span>
              <span className="text-orange-400">{selectedNode && selectedNode.processor === 'NPU-Local' ? 'Direct Silicon Mapped' : 'Go Compiler Context'}</span>
            </div>
          </div>
        </div>

        {/* Card: Add Node Form */}
        <div className="bg-[#0b0e14] border border-gray-900 rounded-xl p-4 flex flex-col justify-between">
          <div>
            <div className="flex items-center gap-1.5 border-b border-gray-900 pb-2.5 mb-3">
              <Plus className="w-4 h-4 text-emerald-400" />
              <h3 className="font-mono text-[10px] font-bold text-gray-300 uppercase tracking-widest">
                SCAFFOLD AGENT NODE
              </h3>
            </div>

            <form onSubmit={handleCreateNode} className="space-y-3">
              <div>
                <label className="block text-[8px] text-gray-500 uppercase tracking-wider mb-1">
                  Node Identifier name
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. CodeReview_Bot, PromptGantry"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="w-full bg-black/40 border border-gray-900 rounded px-2.5 py-1.5 text-xs text-gray-200 outline-none focus:border-emerald-500 font-mono"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[8px] text-gray-500 uppercase tracking-wider mb-1">
                    Function Role
                  </label>
                  <select
                    value={newType}
                    onChange={(e) => setNewType(e.target.value as AgentNodeType)}
                    className="w-full bg-black/40 border border-gray-900 rounded px-1.5 py-1 text-xs text-gray-200 outline-none font-mono"
                  >
                    <option value="IngressRouter">Router / Ingress</option>
                    <option value="TaskPlanner">Planner / Router</option>
                    <option value="LocalInference">Model Inference</option>
                    <option value="ToolExecutor">Exec Tool Call</option>
                    <option value="ResponseAggregator">Collector</option>
                  </select>
                </div>

                <div>
                  <label className="block text-[8px] text-gray-500 uppercase tracking-wider mb-1">
                    Hardware core
                  </label>
                  <select
                    value={newProcessor}
                    onChange={(e) => setNewProcessor(e.target.value as NodeProcessor)}
                    className="w-full bg-black/40 border border-gray-900 rounded px-1.5 py-1 text-xs text-gray-200 outline-none font-mono"
                  >
                    <option value="NPU-Local">Local NPU</option>
                    <option value="GPU-TensorCore">Local GPU</option>
                    <option value="CPU">Node Pinned CPU</option>
                    <option value="Remote-Cloud">Fallback Cloud</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-[8px] text-gray-500 uppercase tracking-wider mb-1">
                  Model Target
                </label>
                {discoveredModels && discoveredModels.length > 0 ? (
                  <select
                    value={newModel}
                    onChange={(e) => setNewModel(e.target.value)}
                    className="w-full bg-black/40 border border-gray-900 rounded px-2 py-1 text-xs text-gray-200 outline-none focus:border-emerald-500 font-mono"
                  >
                    {discoveredModels.map(m => (
                      <option key={m.name} value={m.name}>{m.displayName || m.name}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={newModel}
                    onChange={(e) => setNewModel(e.target.value)}
                    className="w-full bg-black/40 border border-gray-900 rounded px-2.5 py-1 text-xs text-gray-200 outline-none focus:border-emerald-500 font-mono"
                    placeholder="Llama-3-8B-Local"
                  />
                )}
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[8px] text-gray-500 uppercase mb-0.5 animate-pulse">BatchSize</label>
                  <input
                    type="number"
                    min="1"
                    max="64"
                    value={newBatchSize}
                    onChange={(e) => setNewBatchSize(Number(e.target.value))}
                    className="w-full bg-black/40 border border-gray-900 rounded px-2 py-1 text-xs text-gray-200 outline-none font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[8px] text-gray-500 uppercase mb-0.5 font-bold">RingWorkers</label>
                  <input
                    type="number"
                    min="1"
                    max="128"
                    value={newLimit}
                    onChange={(e) => setNewLimit(Number(e.target.value))}
                    className="w-full bg-black/40 border border-gray-900 rounded px-2 py-1 text-xs text-gray-200 outline-none font-mono"
                  />
                </div>
              </div>

              <button
                type="submit"
                className="w-full mt-2 bg-[#00ff41] hover:bg-[#00cc33] text-black font-bold text-xs py-2 rounded font-mono transition flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                Scaffold Node
              </button>
            </form>
          </div>
        </div>

        {/* Card: Connect Stream Pipes (Edges) */}
        <div className="bg-[#0b0e14] border border-gray-900 rounded-xl p-4 flex flex-col justify-between">
          <div>
            <div className="flex items-center gap-1.5 border-b border-gray-900 pb-2.5 mb-3">
              <Radio className="w-4 h-4 text-cyan-400" />
              <h3 className="font-mono text-[10px] font-bold text-gray-300 uppercase tracking-widest">
                DISTRIBUTED STREAM PIPES
              </h3>
            </div>

            <form onSubmit={handleCreateEdge} className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[8px] text-gray-500 uppercase mb-1">
                    Source Node (From)
                  </label>
                  <select
                    value={sourceId}
                    onChange={(e) => setSourceId(e.target.value)}
                    className="w-full bg-black/40 border border-gray-900 rounded px-2 py-1 text-xs text-gray-200 outline-none font-mono"
                  >
                    <option value="">Select</option>
                    {nodes.map(n => (
                      <option key={n.id} value={n.id}>{n.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[8px] text-gray-500 uppercase mb-1">
                    Target Node (To)
                  </label>
                  <select
                    value={targetId}
                    onChange={(e) => setTargetId(e.target.value)}
                    className="w-full bg-black/40 border border-gray-900 rounded px-2 py-1 text-xs text-gray-200 outline-none font-mono"
                  >
                    <option value="">Select</option>
                    {nodes.map(n => (
                      <option key={n.id} value={n.id}>{n.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-[8px] text-gray-500 uppercase mb-1">
                  Transport Link Protocol
                </label>
                <select
                  value={edgeTransport}
                  onChange={(e) => setEdgeTransport(e.target.value as any)}
                  className="w-full bg-black/40 border border-gray-900 rounded px-1.5 py-1 text-xs text-gray-200 outline-none font-mono"
                >
                  <option value="Channel">Go Channel (Lock-Safe)</option>
                  <option value="ZeroCopyRing">Lock-Free Circular Ring</option>
                  <option value="SharedMemory">CGo Memory Pointer (SHM)</option>
                  <option value="gRPC">Low-Latency gRPC Stream</option>
                </select>
              </div>

              <button
                type="submit"
                disabled={!sourceId || !targetId}
                className={`w-full mt-1 font-mono text-xs py-2 rounded transition flex items-center justify-center gap-1.5 ${
                  sourceId && targetId 
                    ? 'bg-cyan-500 hover:bg-cyan-400 text-black font-bold cursor-pointer' 
                    : 'bg-gray-900 border border-gray-950 text-gray-600 cursor-not-allowed'
                }`}
              >
                <ArrowRight className="w-3.5 h-3.5" />
                Establish Wires Link
              </button>
            </form>

            {edges.length > 0 && (
              <div className="mt-4 pt-3.5 border-t border-gray-900">
                <span className="block text-[9px] font-bold text-gray-500 uppercase tracking-wider mb-2">
                  ACTIVE CONNECTIONS ({edges.length})
                </span>
                <div className="max-h-[110px] overflow-y-auto space-y-1.5 pr-1 font-mono text-[9px]">
                  {edges.map((edge) => {
                    const srcNode = nodes.find(n => n.id === edge.source);
                    const tgtNode = nodes.find(n => n.id === edge.target);
                    if (!srcNode || !tgtNode) return null;
                    return (
                      <div key={edge.id} className="flex items-center justify-between bg-black/30 border border-gray-900 px-2 py-1 rounded">
                        <div className="truncate text-gray-300 max-w-[130px]">
                          <span className="text-emerald-400 font-bold">{srcNode.name.replace(/_Preset_\d+/i, '').substring(0, 10)}</span>
                          <span className="text-gray-500 mx-1">→</span>
                          <span className="text-cyan-400 font-bold">{tgtNode.name.replace(/_Preset_\d+/i, '').substring(0, 10)}</span>
                        </div>
                        <button
                          onClick={() => onDeleteEdge(edge.id)}
                          className="text-gray-500 hover:text-rose-400 transition ml-2 whitespace-nowrap shrink-0 cursor-pointer"
                          title="Sever Connection"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>

      </div>
      )}
    </div>
  );
}
