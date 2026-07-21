import React, { useState, useEffect, useRef } from 'react';
import { 
  Sparkles, 
  MessageSquare,   
  Send, 
  X, 
  User, 
  HelpCircle,
  Lightbulb,
  Bot,
  Cpu,
  Activity,
  Terminal,
  Settings,
  Plus,
  ArrowRight,
  ShieldAlert,
  Sliders,
  Check,
  RefreshCw,
  Layers,
  Award,
  Zap,
  Monitor,
  Database,
  Compass,
  Brain,
  Video
} from 'lucide-react';

interface CyberMascotCompanionProps {
  currentTab: string;
  nodesCount: number;
  activeNodes?: any[];
  onAddNode?: (n: any) => void;
  onDeleteNode?: (id: string) => void;
  onUpdateNode?: (n: any) => void;
  config?: any;
  onUpdateConfig?: (c: any) => void;
}

interface HardwareProfile {
  deviceClass: 'Mobile' | 'Tablet' | 'Desktop';
  cpuCores: number;
  approxMemoryGb: number;
  safeScaleFactor: number;
  concurrencyRecommendation: number;
  transportRecommendation: string;
  screenWidth: number;
  screenHeight: number;
  isFirstBoot: boolean;
}

export default function CyberMascotCompanion({ 
  currentTab, 
  nodesCount,
  activeNodes = [],
  onAddNode,
  onDeleteNode,
  onUpdateNode,
  config,
  onUpdateConfig
}: CyberMascotCompanionProps) {
  // Navigation tabs inside Mascot console
  const [mascotTab, setMascotTab] = useState<'chat' | 'systems' | 'diagnostics' | 'skills'>('chat');

  // Console sizing, dragging, and side drawer triggers
  const [consoleWidth, setConsoleWidth] = useState<number>(() => {
    const savedW = localStorage.getItem('aimi_console_width_v2');
    return savedW ? parseInt(savedW, 10) : 340;
  });
  const [consoleHeight, setConsoleHeight] = useState<number>(() => {
    const savedH = localStorage.getItem('aimi_console_height_v2');
    return savedH ? parseInt(savedH, 10) : 460;
  });
  const [consolePosition, setConsolePosition] = useState<{ x: number, y: number } | null>(() => {
    const savedPos = localStorage.getItem('aimi_console_position_v2');
    if (savedPos) {
      try { return JSON.parse(savedPos); } catch (_) { return null; }
    }
    return null;
  });

  const [isDraggingConsole, setIsDraggingConsole] = useState(false);
  const consoleDragStartRef = useRef({ x: 0, y: 0 });
  const consolePosStartRef = useRef({ x: 0, y: 0 });

  const [isResizingConsole, setIsResizingConsole] = useState(false);
  const consoleResizeStartRef = useRef({ x: 0, y: 0 });
  const consoleSizeStartRef = useRef({ w: 0, h: 0 });

  const [showSkillsDrawer, setShowSkillsDrawer] = useState(true); // default true for high visibility of achievements

  // Coordinates & Dragging
  const [position, setPosition] = useState({ x: window.innerWidth - 130, y: window.innerHeight - 150 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const posStartRef = useRef({ x: 0, y: 0 });
  const draggedDistance = useRef(0);

  // States
  const [isOpen, setIsOpen] = useState(false);
  const [activeExpression, setActiveExpression] = useState<string>('happy'); // happy, thinking, surprised, sassy, cheering, sitting
  const [message, setMessage] = useState('');
  const [chatHistory, setChatHistory] = useState<Array<{ role: 'user' | 'model'; text: string }>>([
    { role: 'model', text: 'Hello! I am Aimi, your cybernetic microkernel companion! ٩(◕‿◕)۶ I can guide you through the active workspace, explain DAG pipelines, or just hang out! Ask me anything!' }
  ]);
  const [isLoading, setIsLoading] = useState(false);
  const [showGuideTips, setShowGuideTips] = useState(true);
  const [speechBubble, setSpeechBubble] = useState<string | null>("Aimi-chan reporting for systems duty! ✧(◕‿◕)✧ Drag me anywhere, or click to open!");
  
  // Custom Task Scaffolding inside systems tab
  const [scaffoldName, setScaffoldName] = useState('');
  const [scaffoldType, setScaffoldType] = useState<'IngressRouter' | 'TaskPlanner' | 'LocalInference' | 'ToolExecutor' | 'ResponseAggregator'>('LocalInference');
  const [scaffoldProcessor, setScaffoldProcessor] = useState<'CPU' | 'GPU-TensorCore' | 'NPU-Local' | 'Remote-Cloud'>('GPU-TensorCore');
  const [scaffoldModel, setScaffoldModel] = useState('DeepSeek-V3-Local-1.5B');
  const [scaffoldSuccess, setScaffoldSuccess] = useState<string | null>(null);

  // Auto-scanning state
  const [diagnosticReport, setDiagnosticReport] = useState<string[] | null>(null);
  const [runningDiag, setRunningDiag] = useState(false);

  // RPG SKILLS STATS PROFILE
  const [aimiSkills, setAimiSkills] = useState<Array<{
    id: string;
    name: string;
    description: string;
    level: number;
    xp: number;
    maxXp: number;
    statBoost: string;
    iconType: 'memory' | 'pipeline' | 'npu' | 'topology' | 'sandbox';
  }>>(() => {
    const saved = localStorage.getItem('aimi_skills_profile_v2');
    if (saved) {
      try { return JSON.parse(saved); } catch (_) {}
    }
    return [
      {
        id: 'memory',
        name: 'Neural Memory Mapper',
        description: 'Zero-copy direct virtual address buffer pinning.',
        level: 3,
        xp: 310,
        maxXp: 500,
        statBoost: 'Throughput Efficiency +25%, Memory Latency -10%',
        iconType: 'memory'
      },
      {
        id: 'pipeline',
        name: 'Atomic Channel Router',
        description: 'Direct thread-safe ring-buffer pipeline message dispatching without lock blocks.',
        level: 2,
        xp: 180,
        maxXp: 300,
        statBoost: 'Pipeline Sync Velocity +15%, Dispatch Overheads -35ms',
        iconType: 'pipeline'
      },
      {
        id: 'npu',
        name: 'NPU Quantizer Optimizer',
        description: 'Compiles high-dimension tensor arrays into local matrix instruction sets.',
        level: 1,
        xp: 50,
        maxXp: 200,
        statBoost: 'Inference Velocity +4.2 TFLOPS, Quantization Loss -0.01%',
        iconType: 'npu'
      },
      {
        id: 'topology',
        name: 'Constellation Graph Router',
        description: 'Calculates shortest execution routes on active agent multi-agent structures.',
        level: 2,
        xp: 80,
        maxXp: 400,
        statBoost: 'Active Bandwidth Cap +30%, Shortest Route Cycles -12.5%',
        iconType: 'topology'
      },
      {
        id: 'sandbox',
        name: 'Stack Intrusion Shield',
        description: 'Protects thread registers from runtime out-of-bounds pointer crashes.',
        level: 1,
        xp: 120,
        maxXp: 250,
        statBoost: 'Host Memory Security Integrity +80%, Exception Crash Guard +100%',
        iconType: 'sandbox'
      }
    ];
  });

  // Practice loader and statistics mini-game
  const [grindingSkillId, setGrindingSkillId] = useState<string | null>(null);
  const [grindProgress, setGrindProgress] = useState<number>(0);
  const [grindLogs, setGrindLogs] = useState<string[]>([]);

  useEffect(() => {
    localStorage.setItem('aimi_skills_profile_v2', JSON.stringify(aimiSkills));
  }, [aimiSkills]);

  useEffect(() => {
    localStorage.setItem('aimi_console_width_v2', consoleWidth.toString());
  }, [consoleWidth]);

  useEffect(() => {
    localStorage.setItem('aimi_console_height_v2', consoleHeight.toString());
  }, [consoleHeight]);

  useEffect(() => {
    if (consolePosition) {
      localStorage.setItem('aimi_console_position_v2', JSON.stringify(consolePosition));
    } else {
      localStorage.removeItem('aimi_console_position_v2');
    }
  }, [consolePosition]);

  // -------------------------------------------------------------
  // DIGIMON EVOLUTION STATE MACHINE STATE
  // -------------------------------------------------------------
  const [experience, setExperience] = useState<number>(() => {
    const saved = localStorage.getItem('aimi_xp_points');
    return saved ? parseInt(saved, 10) : 55; // Default starts right after Egg (Stage 2 Rookie/In-training transition)
  });
  const [levelUpEvent, setLevelUpEvent] = useState<{ active: boolean; from: number; to: number; msg: string } | null>(null);
  const [forceEvolutionStage, setForceEvolutionStage] = useState<number | null>(null); // Null = use earned level

  // -------------------------------------------------------------
  // HARDWARE AUTO-RESOLUTION DIAGNOSTIC STATE
  // -------------------------------------------------------------
  const [hardwareProfile, setHardwareProfile] = useState<HardwareProfile | null>(null);

  const chatEndRef = useRef<HTMLDivElement>(null);

  // Helper functions for Level progression
  const getLevelFromXp = (xp: number): number => {
    if (xp < 50) return 1;       // Stage 0: DigiEgg
    if (xp < 180) return 2;      // Stage 1: In-Training [AmiBud]
    if (xp < 420) return 3;      // Stage 2: Rookie [Aimi-chan]
    if (xp < 800) return 4;      // Stage 3: Champion [AimiValkyrie]
    return 5;                    // Stage 4: Mega [OmniAimiOS]
  };

  const getEvolutionStageName = (lvl: number): string => {
    switch (lvl) {
      case 1: return "Stage 0: DigiEgg [Neon Seed]";
      case 2: return "Stage 1: In-Training [AmiBud]";
      case 3: return "Stage 2: Rookie [Aimi-chan]";
      case 4: return "Stage 3: Champion [AimiValkyrie]";
      case 5: return "Stage 4: Mega [OmniAimiOS]";
      default: return "Stage 2: Rookie [Aimi-chan]";
    }
  };

  const currentLevel = forceEvolutionStage !== null ? forceEvolutionStage : getLevelFromXp(experience);

  // Progression boundaries
  const getXpBoundaries = (lvl: number) => {
    switch (lvl) {
      case 1: return { min: 0, max: 50 };
      case 2: return { min: 50, max: 180 };
      case 3: return { min: 180, max: 420 };
      case 4: return { min: 420, max: 800 };
      case 5: return { min: 800, max: 1500 };
      default: return { min: 180, max: 420 };
    }
  };

  // Add experience tracker
  const gainExperience = (amount: number, reason: string) => {
    setExperience(prev => {
      const nextXp = prev + amount;
      localStorage.setItem('aimi_xp_points', nextXp.toString());
      
      const oldLvl = getLevelFromXp(prev);
      const newLvl = getLevelFromXp(nextXp);

      if (newLvl > oldLvl && forceEvolutionStage === null) {
        // Trigger Digimon style epic evolution pop-up!
        setLevelUpEvent({
          active: true,
          from: oldLvl,
          to: newLvl,
          msg: getEvolutionStageName(newLvl)
        });
        setSpeechBubble(`*Kyaaa!* ✨ Aimi is evolving! (ﾉ◕ヮ◕)ﾉ*:･ﾟ✧ Transited into: ${getEvolutionStageName(newLvl)}!`);
        setActiveExpression('cheering');
        setTimeout(() => {
          setLevelUpEvent(null);
        }, 5500);
      }
      return nextXp;
    });
  };

  // Clamp window handler updated dynamically matching viewport bounds
  const clampPosition = (x: number, y: number) => {
    const minPaddingX = 25;
    const minPaddingY = 30;
    const maxX = window.innerWidth - minPaddingX;
    const maxY = window.innerHeight - minPaddingY;
    return {
      x: Math.max(minPaddingX, Math.min(x, maxX)),
      y: Math.max(minPaddingY, Math.min(y, maxY))
    };
  };

  // Adjust on screen resize
  useEffect(() => {
    const handleResize = () => {
      setPosition(prev => clampPosition(prev.x, prev.y));
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Window-level mouse & touch pointer dragging listener
  useEffect(() => {
    if (!isDragging) return;

    const handlePointerMove = (e: MouseEvent | TouchEvent) => {
      const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
      const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;

      const deltaX = clientX - dragStartRef.current.x;
      const deltaY = clientY - dragStartRef.current.y;

      draggedDistance.current = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

      const nextX = posStartRef.current.x + deltaX;
      const nextY = posStartRef.current.y + deltaY;

      setPosition(clampPosition(nextX, nextY));
    };

    const handlePointerUp = () => {
      setIsDragging(false);
      if (draggedDistance.current > 15) {
        gainExperience(3, "Relocate mascot physical spatial coordinates");
      }
    };

    window.addEventListener('mousemove', handlePointerMove, { passive: true });
    window.addEventListener('mouseup', handlePointerUp);
    window.addEventListener('touchmove', handlePointerMove, { passive: false });
    window.addEventListener('touchend', handlePointerUp);

    return () => {
      window.removeEventListener('mousemove', handlePointerMove);
      window.removeEventListener('mouseup', handlePointerUp);
      window.removeEventListener('touchmove', handlePointerMove);
      window.removeEventListener('touchend', handlePointerUp);
    };
  }, [isDragging]);

  const onDragStart = (e: React.MouseEvent | React.TouchEvent) => {
    // Only drag on left-button mouse click
    if ('button' in e && e.button !== 0) return;

    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;

    setIsDragging(true);
    draggedDistance.current = 0;
    dragStartRef.current = { x: clientX, y: clientY };
    posStartRef.current = { ...position };
  };

  // -------------------------------------------------------------
  // CONSOLE INTERACTIVE WINDOW DRAGGING & RESIZING SYSTEMS
  // -------------------------------------------------------------
  useEffect(() => {
    if (!isDraggingConsole && !isResizingConsole) return;

    const handlePointerMove = (e: MouseEvent | TouchEvent) => {
      const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
      const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;

      if (isDraggingConsole) {
        const deltaX = clientX - consoleDragStartRef.current.x;
        const deltaY = clientY - consoleDragStartRef.current.y;
        
        const nextX = consolePosStartRef.current.x + deltaX;
        const nextY = consolePosStartRef.current.y + deltaY;

        // Constraint within screen limits
        const clampX = Math.max(10, Math.min(nextX, window.innerWidth - 150));
        const clampY = Math.max(10, Math.min(nextY, window.innerHeight - 150));
        setConsolePosition({ x: clampX, y: clampY });
      } else if (isResizingConsole) {
        const deltaX = clientX - consoleResizeStartRef.current.x;
        const deltaY = clientY - consoleResizeStartRef.current.y;

        const nextW = consoleSizeStartRef.current.w + deltaX;
        const nextH = consoleSizeStartRef.current.h + deltaY;

        // Keep console bounded
        setConsoleWidth(Math.max(280, Math.min(nextW, window.innerWidth - 40)));
        setConsoleHeight(Math.max(350, Math.min(nextH, window.innerHeight - 60)));
      }
    };

    const handlePointerUp = () => {
      setIsDraggingConsole(false);
      setIsResizingConsole(false);
    };

    window.addEventListener('mousemove', handlePointerMove, { passive: true });
    window.addEventListener('mouseup', handlePointerUp);
    window.addEventListener('touchmove', handlePointerMove, { passive: false });
    window.addEventListener('touchend', handlePointerUp);

    return () => {
      window.removeEventListener('mousemove', handlePointerMove);
      window.removeEventListener('mouseup', handlePointerUp);
      window.removeEventListener('touchmove', handlePointerMove);
      window.removeEventListener('touchend', handlePointerUp);
    };
  }, [isDraggingConsole, isResizingConsole]);

  const onConsoleDragStart = (e: React.MouseEvent | React.TouchEvent) => {
    if ('button' in e && e.button !== 0) return; // Left button only

    // Prevent dragging if clicking button or input/select
    const target = e.target as HTMLElement;
    if (target.closest('button') || target.closest('input') || target.closest('select')) {
      return;
    }

    e.preventDefault();

    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;

    setIsDraggingConsole(true);
    consoleDragStartRef.current = { x: clientX, y: clientY };

    let currentLeft = 0;
    let currentTop = 0;

    if (consolePosition) {
      currentLeft = consolePosition.x;
      currentTop = consolePosition.y;
    } else {
      const isLeft = position.x < window.innerWidth / 2;
      const isTop = position.y < window.innerHeight / 2;
      
      currentLeft = position.x + (isLeft ? 85 : -345);
      currentTop = position.y + (isTop ? -40 : -415);
    }

    consolePosStartRef.current = { x: currentLeft, y: currentTop };
  };

  const onConsoleResizeStart = (e: React.MouseEvent | React.TouchEvent) => {
    if ('button' in e && e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();

    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;

    setIsResizingConsole(true);
    consoleResizeStartRef.current = { x: clientX, y: clientY };
    consoleSizeStartRef.current = { w: consoleWidth, h: consoleHeight };
  };

  // Auto-scroll chat inputs
  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatHistory, isOpen, mascotTab]);

  // Tab change greetings
  useEffect(() => {
    if (!isOpen) {
      let greetText = "Need help organizing key registers? Let me check!";
      if (currentTab === 'DAG') greetText = "Welcome to the Topology field! Drag library nodes or write direct tasks! ✧(•̀ᴗ•́)و";
      else if (currentTab === 'GITNEXUS') greetText = "Checking GitNexus local repositories! Need me to audit files? *gasp*";
      else if (currentTab === 'CORE') greetText = "Microkernel firmware parameters loaded! Ready to pin ultra-fast threads? (＾▽＾)";
      else if (currentTab === 'SCHEDULER') greetText = "Cron threads are ticking smoothly! Tick-tock (￣ω￣)";
      else if (currentTab === 'CHAT') greetText = "Aimi can help construct queries for the master core Oracle!";
      
      setSpeechBubble(greetText);
      setActiveExpression('happy');

      const timer = setTimeout(() => {
        setSpeechBubble(null);
      }, 7000);
      return () => clearTimeout(timer);
    }
  }, [currentTab]);

  // ON BOOT DETECT SCREEN, HARDWARE & AUTO-FIT DEVICE CAPABILITIES
  useEffect(() => {
    const scrWidth = window.innerWidth;
    const scrHeight = window.innerHeight;
    const isMobile = scrWidth < 640;
    const isTablet = scrWidth >= 640 && scrWidth < 1024;
    
    // Detect Hardware logic threads count or set standard fallback
    const cores = navigator.hardwareConcurrency || 8;
    // Detect RAM in GB or set standard fallback (usually in navigator.deviceMemory)
    const ram = (navigator as any).deviceMemory || 4;

    const deviceClass = isMobile ? 'Mobile' : isTablet ? 'Tablet' : 'Desktop';
    const scaleFactor = isMobile ? 0.85 : 1.0;

    // Recommend optimal microkernel concurrency based on CPU thread capacity
    const recommendation = Math.max(2, Math.min(16, cores));
    const transportRec = ram >= 8 ? 'SharedMemoryMapped' : 'ZeroCopyRing';

    // Set intelligent Safe positioning out of boundaries on first boot (prevents clipping)
    let safeX = scrWidth - 110;
    let safeY = scrHeight - 120;
    if (isMobile) {
      safeX = scrWidth - 55;
      safeY = scrHeight - 75;
    } else if (isTablet) {
      safeX = scrWidth - 90;
      safeY = scrHeight - 100;
    }

    setPosition({ x: safeX, y: safeY });

    const isFirstTime = !localStorage.getItem('aimi_first_boot_complete_v2');
    
    setHardwareProfile({
      deviceClass,
      cpuCores: cores,
      approxMemoryGb: ram,
      safeScaleFactor: scaleFactor,
      concurrencyRecommendation: recommendation,
      transportRecommendation: transportRec,
      screenWidth: scrWidth,
      screenHeight: scrHeight,
      isFirstBoot: isFirstTime
    });

    if (isFirstTime) {
      localStorage.setItem('aimi_first_boot_complete_v2', 'true');
      setSpeechBubble(`BOOT SEQUENCE: Detected ${cores} CPU hyper-threads & ${ram}GB memory! Initialized Safe Window Clamps (${deviceClass} Mode)! ٩(◕‿◕)۶`);
      setIsOpen(true);
      setMascotTab('diagnostics'); // pop up screen fit results immediately so user knows we detected limits!
      setActiveExpression('cheering');
    }
  }, []);

  // Real-time Dynamic System Diagnostics Checker
  const runOsDiagnosticScan = () => {
    setRunningDiag(true);
    setDiagnosticReport(null);
    setActiveExpression('thinking');
    gainExperience(25, "Initiated full OS core microkernel diagnostics");
    
    setTimeout(() => {
      const reports: string[] = [];
      
      // 1. Analyze Core Orchestrator Config Actions
      if (config) {
        if (!config.pinThreadsToGoRuntime) {
          reports.push("⚠️ CPU CACHE THRASHRISK: OS thread-pinning is NOT active. Recommendation: Lock Virtual threads on high core scheduler registers!");
        } else {
          reports.push("✅ CORE LOCK ENTIRE: Thread Pinning is ACTIVE. OS physical threads are pinned directly to hardware logical registers.");
        }
        
        if (config.networkTransport === 'GoChannels') {
          reports.push("⚠️ DUPLEX REGISTER TRANSIT: Channel communications carry high Go runtime lock blocks (~80ns context payload overhead). Upgrade to 'Zero-Copy Ring Buffers'!");
        } else {
          reports.push(`✅ FASTEST ROUTE: Message dispatching running on speed optimized ring-buffers [${config.networkTransport}].`);
        }
      }

      // 2. Analyze Active Workspace Nodes
      if (activeNodes && activeNodes.length > 0) {
        const cpuNodes = activeNodes.filter(n => n.processor === 'CPU');
        if (cpuNodes.length > 0) {
          reports.push(`⚡ NPU ACCELERATOR FALLBACK: Task Node [${cpuNodes[0].name}] is processed on Host CPU cores. Upgrade core to Local NPU tensor!`);
        } else {
          reports.push("✅ HARDWARE MATRIX MATCH: All pipelines bound directly to local hardware accelerator registers (NPU/GPU).");
        }
        
        if (activeNodes.length < 3) {
          reports.push("💡 CO-PLANNING SCAFFOLD: Topology has scarce core redundance. Scaffold a planning unit node to distribute pipeline loads!");
        }
      } else {
        reports.push("⚠️ PIPELINES EXHAUSTED: Empty graph. Click nodes inside left sliding sidebar tab to instantiate them instantly inside Constellation grid!");
      }

      setDiagnosticReport(reports);
      setRunningDiag(false);
      setActiveExpression('cheering');
      setSpeechBubble("Diagnostic scan completed! Check out Aimi-chan's advice!");
    }, 1200);
  };

  // Direct active Node injection/scaffolder
  const handleScaffoldTaskNode = (e: React.FormEvent) => {
    e.preventDefault();
    if (!scaffoldName.trim() || !onAddNode) return;

    const formattedName = scaffoldName.trim().replace(/\s+/g, '_');
    const spawnedNode = {
      id: `agent_${Date.now()}`,
      name: formattedName,
      type: scaffoldType,
      processor: scaffoldProcessor,
      modelName: scaffoldModel,
      batchSize: 4,
      inputTokens: 0,
      outputTokens: 0,
      concurrencyLimit: 8,
      status: 'idle' as const,
      x: 150 + Math.random() * 250,
      y: 120 + Math.random() * 200
    };

    onAddNode(spawnedNode);
    setScaffoldSuccess(`Synthesized [${spawnedNode.name}] at direct system registry memory!`);
    setScaffoldName('');
    setActiveExpression('cheering');
    gainExperience(22, "Scaffolded and loaded a new active pipeline node in the Topology DAG");

    setTimeout(() => {
      setScaffoldSuccess(null);
    }, 4500);
  };

  // Chat message sender
  const handleSend = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!message.trim() || isLoading) return;

    const userText = message;
    setMessage('');
    setChatHistory(prev => [...prev, { role: 'user', text: userText }]);
    setIsLoading(true);
    setActiveExpression('thinking');
    gainExperience(15, "Engaged chat message query input with Coprocessor");

    // Intercept compatibility or platform requests to report immediate concrete facts!
    const loweredMsg = userText.toLowerCase();
    if (
      loweredMsg.includes('android') || 
      loweredMsg.includes('windows') || 
      loweredMsg.includes('linux') || 
      loweredMsg.includes('run on') || 
      loweredMsg.includes('platform') || 
      loweredMsg.includes('compatib')
    ) {
      setTimeout(() => {
        const platformStatsMsg = `Aimi-chan reporting on multi-system compatibility! ✧(◕‿◕)✧ Yes, this microkernel studio applet has been fully optimized to compile and deploy beautifully across Android, Windows, and Linux! Here is exactly how Aimi structures the pipeline across each ecosystem:

🤖 **Android & Mobile Devices**:
- I am optimized for touch gestures (you can click and drag me with absolute fluid precision using your fingers)!
- The responsive grid auto-detects portable hardware (e.g., safe placement bounds and CPU-conscious cooling ticks).
- You can compile my active view into a native Android APK container by using **Capacitor** or wrapping me into a React Native WebView seamlessly.

🪟 **Windows Desktop**:
- I integrate perfectly with shell executables using web wrappers!
- You can package me with **Tauri** or **Electron** into a lightning-fast local EXE window workspace.
- The thread-pinning controls map directly to CPU task groups on administrative host consoles!

🐧 **Linux Runtimes & Daemons**:
- The microkernel architecture is completely suited for Unix background processes.
- Runs with low footprints under single lightweight **Docker containers**.
- You can lock atomic ring-buffer operations directly on bare-metal POSIX thread lines for absolute maximum packet rates!

🍎 **macOS Frames**:
- Fully responsive on macOS using Tauri helper configurations into custom desktop toolbar widgets.

Let me know if you want me to write code to handle any specific file pipelines for these platforms! ＼(≧▽≦)／`;
        setChatHistory(prev => [...prev, { role: 'model', text: platformStatsMsg }]);
        setActiveExpression('cheering');
        setIsLoading(false);
      }, 750);
      return;
    }

    try {
      const payload = {
        message: userText,
        history: chatHistory.map(h => ({ role: h.role, text: h.text })),
        currentTab,
        nodesCount,
        activeNodes
      };

      const res = await fetch('/api/mascot-chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      
      setChatHistory(prev => [...prev, { role: 'model', text: data.response }]);
      setActiveExpression(data.expression || 'happy');
      setSpeechBubble(null);
    } catch (err) {
      console.error(err);
      setChatHistory(prev => [...prev, { 
        role: 'model', 
        text: "Kyaa! My memory grid matrix got slightly scrambled. Let's try again! (￣ω￣;)" 
      }]);
      setActiveExpression('surprised');
    } finally {
      setIsLoading(false);
    }
  };

  const triggerQuickTopic = (topic: string, promptText: string) => {
    setMessage(promptText);
    setTimeout(() => {
      const dummyBtn = document.getElementById('aimi-send-btn');
      if (dummyBtn) dummyBtn.click();
    }, 100);
  };

  const handlePracticeSkill = (skillId: string) => {
    if (grindingSkillId) return;
    setGrindingSkillId(skillId);
    setGrindProgress(0);
    setActiveExpression('thinking');
    
    const targetSkill = aimiSkills.find(s => s.id === skillId);
    const skillName = targetSkill ? targetSkill.name : 'Skill';
    setSpeechBubble(`Practicing ${skillName}... Commencing binary optimization compiles!`);
    
    const practicePhrases = [
      `Initializing compiler registers for ${skillName}...`,
      `Setting zero-copy atomic channels...`,
      `Mapping safe thread-local pointer segments...`,
      `Pipelining hardware-quantized matrix variables...`,
      `Tuning instruction registers directly...`,
      `Verifying stack structures against overflow crashes...`,
      `Synthesizing logic layers into bare-metal memory cores...`
    ];
    
    setGrindLogs([practicePhrases[0]]);
    
    let currentProg = 0;
    const interval = setInterval(() => {
      currentProg += 10;
      setGrindProgress(currentProg);
      
      const phraseIdx = Math.min(
        practicePhrases.length - 1, 
        Math.floor((currentProg / 100) * practicePhrases.length)
      );
      
      if (currentProg % 20 === 0 && practicePhrases[phraseIdx]) {
        setGrindLogs(prev => {
          if (!prev.includes(practicePhrases[phraseIdx])) {
            return [...prev, practicePhrases[phraseIdx]];
          }
          return prev;
        });
      }
      
      if (currentProg >= 100) {
        clearInterval(interval);
        
        setAimiSkills(prevSkills => {
          const updated = prevSkills.map(s => {
            if (s.id === skillId) {
              let nextXp = s.xp + 45;
              let nextLvl = s.level;
              let nextMax = s.maxXp;
              if (nextXp >= s.maxXp) {
                nextLvl += 1;
                nextXp = nextXp - s.maxXp;
                nextMax = Math.round(s.maxXp * 1.5);
                
                setSpeechBubble(`✧(∗≧▽≦∗)✧ Level Up! Your Skill [${s.name}] has evolved to Level ${nextLvl}!`);
                setActiveExpression('cheering');
              } else {
                setSpeechBubble(`Practice complete! Gained +45 XP for ${s.name}! (＾▽＾)`);
                setActiveExpression('happy');
              }
              return { ...s, level: nextLvl, xp: nextXp, maxXp: nextMax };
            }
            return s;
          });
          localStorage.setItem('aimi_skills_profile_v2', JSON.stringify(updated));
          return updated;
        });
        
        gainExperience(25, `Completed academy compiler practice session for ${skillName}`);
        setGrindingSkillId(null);
        setGrindProgress(0);
      }
    }, 250);
  };

  // Dynamic responsive side determination to prevent offscreen clipping!
  const isAimiOnLeft = position.x < window.innerWidth / 2;
  const isAimiOnTop = position.y < window.innerHeight / 2;

  // VISUAL DECAL CUSTOMIZER: Renders 5 distinct evolutionary stages
  const renderAimiAvatarSVG = () => {
    let eyeColor = "#00f0ff"; 
    let bgGlow = "rgba(0, 240, 255, 0.4)";
    let faceExpr = "normal"; 
    let ribbonColor = "#ff2a85"; 

    if (activeExpression === 'thinking') {
      eyeColor = "#ffb700";
      bgGlow = "rgba(255, 183, 0, 0.45)";
      faceExpr = "focused";
    } else if (activeExpression === 'surprised') {
      eyeColor = "#ff2a85";
      bgGlow = "rgba(255, 42, 133, 0.5)";
      faceExpr = "wide";
    } else if (activeExpression === 'cheering') {
      eyeColor = "#39ff14"; 
      bgGlow = "rgba(57, 255, 20, 0.5)";
      faceExpr = "star";
    } else if (activeExpression === 'sassy') {
      eyeColor = "#a855f7";
      bgGlow = "rgba(168, 85, 247, 0.45)";
      faceExpr = "smirk";
    } else if (activeExpression === 'sitting') {
      eyeColor = "#60a5fa";
      bgGlow = "rgba(96, 165, 250, 0.35)";
      faceExpr = "narrow";
    }

    return (
      <div className="relative w-20 h-20 sm:w-24 sm:h-24 select-none group transition-all duration-300 transform active:scale-95">
        {/* Holographic Projection Platform pedestal underneath avatar */}
        <div className="absolute -bottom-1 left-2 right-2 h-3 bg-[#00f3ff]/10 rounded flex items-center justify-center border border-[#00f3ff]/30 animate-pulse blur-[1px]">
          <span className="w-5/6 h-0.5 bg-[#00f3ff] opacity-40 shadow-[0_0_8px_#00f3ff]" />
        </div>

        {/* Floating Matrix circuit ring under her head */}
        <div 
          style={{ boxShadow: `0 0 30px ${bgGlow}` }}
          className="absolute inset-2.5 rounded-full bg-black/70 z-0 border border-[#00e5ff]/25 transition-all duration-300"
        />

        <svg 
          viewBox="0 0 100 100" 
          className="w-full h-full relative z-10 drop-shadow-[0_0_12px_rgba(0,243,255,0.4)] transition-transform group-hover:scale-105"
        >
          {/* Inject inline keyframes for nice bouncing and swaying animations */}
          <style dangerouslySetInnerHTML={{__html: `
            @keyframes miku-hair-sway-l {
              0%, 100% { transform: rotate(0deg); }
              50% { transform: rotate(-8deg) translate(-2px, 1px); }
            }
            @keyframes miku-hair-sway-r {
              0%, 100% { transform: rotate(0deg); }
              50% { transform: rotate(8deg) translate(2px, 1px); }
            }
            @keyframes aimi-bounce-slow {
              0%, 100% { transform: translateY(0); }
              50% { transform: translateY(-3.5px); }
            }
            @keyframes aimi-pulse-egg {
              0%, 100% { opacity: 0.35; }
              50% { opacity: 0.95; }
            }
            .miku-hair-left {
              transform-origin: 30px 40px;
              animation: miku-hair-sway-l 3.5s ease-in-out infinite;
            }
            .miku-hair-right {
              transform-origin: 70px 40px;
              animation: miku-hair-sway-r 3.5s ease-in-out infinite;
            }
            .aimi-body-bouce {
              animation: aimi-bounce-slow 2s ease-in-out infinite;
            }
            .aimi-egg-pulse {
              animation: aimi-pulse-egg 1.8s ease-in-out infinite;
            }
          `}} />

          {/* Definitions inside the SVG for gradients */}
          <defs>
            <linearGradient id="mikuHairGradient" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="#818cf8" /> {/* lovely periwinkle/lavender */}
              <stop offset="60%" stopColor="#a5b4fc" /> {/* light glowing lavender */}
              <stop offset="100%" stopColor="#1e1b4b" /> {/* dark purple shadows */}
            </linearGradient>
            <linearGradient id="megaCrownGrad" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#eab308" />
              <stop offset="50%" stopColor="#f59e0b" />
              <stop offset="100%" stopColor="#ca8a04" />
            </linearGradient>
            <linearGradient id="eggGrad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#1e1c45" stopOpacity="0.9" />
              <stop offset="50%" stopColor="#818cf8" stopOpacity="0.8" />
              <stop offset="100%" stopColor="#0a051d" stopOpacity="0.95" />
            </linearGradient>
          </defs>

          {/* ==================== 🥚 STAGE 1: DIGI-EGG [NEON SEED] ==================== */}
          {currentLevel === 1 && (
            <g className="aimi-body-bouce">
              {/* Background server rays */}
              <ellipse cx="50" cy="80" rx="18" ry="5" fill="none" stroke="#00f3ff" strokeWidth="0.75" strokeDasharray="3,3" />

              {/* Egg main shep with lavender and cyan highlights */}
              <ellipse cx="50" cy="54" rx="19" ry="24" fill="url(#eggGrad)" stroke="#00ffff" strokeWidth="2.2" />
              
              {/* Glowing cyan data stripes zig zag */}
              <path d="M 40 44 L 56 44 L 43 56 L 57 56 L 46 69" fill="none" stroke="#00ffff" strokeWidth="2" strokeLinecap="round" />
              <path d="M 45 44 L 51 44" stroke="#ff2a85" strokeWidth="0.8" opacity="0.6" />

              {/* Pulsing neon dots inside the core */}
              <circle cx="50" cy="54" r="5" fill="#39ff14" className="aimi-egg-pulse" style={{ filter: 'drop-shadow(0 0 4px #39ff14)' }} />
              <circle cx="50" cy="54" r="2" fill="#fff" />

              {/* Little antenna looking top tail representing early bunny ear buds */}
              <path d="M 50 30 Q 53 18 45 12" fill="none" stroke="#a5b4fc" strokeWidth="1.8" />
              <circle cx="45" cy="12" r="2.2" fill="#00ffff" />
              
              {/* Floating diagnostic strings */}
              <text x="35" y="87" fill="#a5b4fc" fontSize="3.5" fontFamily="monospace" opacity="0.8">BOOT_SEED.DAT</text>
            </g>
          )}

          {/* ==================== 🍼 STAGE 2: IN-TRAINING [AMIBUD] ==================== */}
          {currentLevel === 2 && (
            <g className="aimi-body-bouce">
              {/* Chubby round cyber ball slime body styled as lavender bubble */}
              <ellipse cx="50" cy="62" rx="22" ry="17" fill="#13143c" stroke="#818cf8" strokeWidth="2" />

              {/* Glowing neon headphone circles on ears */}
              <circle cx="23" cy="60" r="4.5" fill="#05051d" stroke="#00ffff" strokeWidth="1.2" />
              <circle cx="77" cy="60" r="4.5" fill="#05051d" stroke="#00ffff" strokeWidth="1.2" />
              
              {/* Glowing headband line */}
              <path d="M 28 55 Q 50 38 72 55" fill="none" stroke="#00e1ff" strokeWidth="1.2" />

              {/* Miniature neon periwinkle bunny ears budding */}
              <path d="M 38 46 Q 30 30 37 32 Z" fill="#a5b4fc" stroke="#818cf8" strokeWidth="0.75" />
              <path d="M 62 46 Q 70 30 63 32 Z" fill="#a5b4fc" stroke="#818cf8" strokeWidth="0.75" />

              {/* Giant sparkling eyes */}
              <g>
                <ellipse cx="38" cy="58" rx="4.5" ry="5.5" fill="#000" />
                <circle cx="39" cy="55" r="1.5" fill="#fff" />
                <circle cx="36.5" cy="60" r="0.7" fill="#00ffff" />

                <ellipse cx="62" cy="58" rx="4.5" ry="5.5" fill="#000" />
                <circle cx="63" cy="55" r="1.5" fill="#fff" />
                <circle cx="60.5" cy="60" r="0.7" fill="#00ffff" />
              </g>

              {/* Smiley tiny curved mouth */}
              <path d="M 47 65 Q 50 68 53 65" fill="none" stroke="#ff2a85" strokeWidth="1.5" strokeLinecap="round" />

              {/* Pink grid blushes */}
              <circle cx="32" cy="63" r="1.5" fill="#ff2a85" opacity="0.6" />
              <circle cx="68" cy="63" r="1.5" fill="#ff2a85" opacity="0.6" />

              {/* Single cute floating vertical sensor rod */}
              <line x1="50" y1="45" x2="50" y2="30" stroke="#00f0ff" strokeWidth="1.5" />
              <circle cx="50" cy="28" r="3" fill="#00ffff" className="animate-ping" style={{ animationDuration: '1.5s' }} />
              <circle cx="50" cy="28" r="1.8" fill="#00ffff" />
            </g>
          )}

          {/* ==================== 👧 STAGE 3: ROOKIE [AIMI-CHAN] (Standard Cyber Companion) ==================== */}
          {currentLevel === 3 && (
            <g className="aimi-body-bouce">
              {/* Cyber Bunny Ears Headband on top of she head */}
              <g>
                {/* Left bunny ear */}
                <path d="M 36 29 Q 20 8 32 3 C 40 -1, 41 15, 39 29" fill="#a5b4fc" stroke="#6366f1" strokeWidth="1" />
                <path d="M 35 25 Q 26 10 32 7 Q 36 7, 37 25" fill="#00ffff" opacity="0.8" />
                
                {/* Right bunny ear */}
                <path d="M 64 29 Q 80 8 68 3 C 60 -1, 59 15, 61 29" fill="#a5b4fc" stroke="#6366f1" strokeWidth="1" />
                <path d="M 65 25 Q 74 10 68 7 Q 64 7, 63 25" fill="#00ffff" opacity="0.8" />
              </g>

              {/* Twin tails in glorious periwinkle hues */}
              <g className="miku-hair-left">
                <path d="M 28 42 C 10 52, -10 70, 2 92 C 8 96, 11 88, 14 78 C 17 65, 23 52, 28 42 Z" fill="url(#mikuHairGradient)" stroke="#00ffff" strokeWidth="0.75" />
                <rect x="23" y="32" width="7" height="10" rx="1" fill="#1e1b4b" stroke="#00ffff" strokeWidth="0.75" />
                <rect x="25" y="34" width="3" height="6" fill="#00ffff" />
              </g>

              <g className="miku-hair-right">
                <path d="M 72 42 C 90 52, 110 70, 98 92 C 92 96, 89 88, 86 78 C 83 65, 77 52, 72 42 Z" fill="url(#mikuHairGradient)" stroke="#00ffff" strokeWidth="0.75" />
                <rect x="70" y="32" width="7" height="10" rx="1" fill="#1e1b4b" stroke="#00ffff" strokeWidth="0.75" />
                <rect x="72" y="34" width="3" height="6" fill="#00ffff" />
              </g>

              {/* Headset ear cups - glowing cyan circles with internal dial designs */}
              <circle cx="15" cy="52" r="9" fill="#090f1a" stroke="#00ffff" strokeWidth="2" style={{ filter: 'drop-shadow(0 0 4px #00ffff)' }} />
              <circle cx="15" cy="52" r="5" fill="none" stroke="#ff2a85" strokeWidth="1.5" />
              <line x1="11" y1="52" x2="19" y2="52" stroke="#00ffff" strokeWidth="1" />
              <line x1="15" y1="48" x2="15" y2="56" stroke="#00ffff" strokeWidth="1" />

              <circle cx="85" cy="52" r="9" fill="#090f1a" stroke="#00ffff" strokeWidth="2" style={{ filter: 'drop-shadow(0 0 4px #00ffff)' }} />
              <circle cx="85" cy="52" r="5" fill="none" stroke="#ff2a85" strokeWidth="1.5" />
              <line x1="81" y1="52" x2="89" y2="52" stroke="#00ffff" strokeWidth="1" />
              <line x1="85" y1="48" x2="85" y2="56" stroke="#00ffff" strokeWidth="1" />

              <path d="M 15 43 Q 50 18 85 43" fill="none" stroke="#00f0ff" strokeWidth="1.5" strokeDasharray="3,3" />

              {/* Tunic dress body with glowing circuit lines & gear */}
              <g>
                {/* Tunic dress skirt base */}
                <path d="M 36 72 L 20 95 L 80 95 L 64 72 Z" fill="#0b1323" stroke="#1d2d44" strokeWidth="1.2" />
                
                {/* Neon cyan circuitry wiring on tunic */}
                <path d="M 50 72 L 50 82 M 50 82 L 35 90 M 50 82 L 65 90" fill="none" stroke="#00ffff" strokeWidth="1.5" style={{ filter: 'drop-shadow(0 0 2px #00ffff)' }} />
                
                {/* Little gear insignia on left chest */}
                <circle cx="38" cy="78" r="3" fill="none" stroke="#00ffff" strokeWidth="1" />
                <path d="M 38 74 L 38 76 M 38 80 L 38 82 M 34 78 L 36 78 M 40 78 L 42 78" stroke="#00ffff" strokeWidth="1" />
                <circle cx="38" cy="78" r="1" fill="#fff" />

                {/* Chibi dangling legs below dress */}
                <rect x="42" y="94" width="5" height="11" rx="2" fill="#fce7f3" stroke="#6366f1" strokeWidth="0.75" />
                <rect x="53" y="94" width="5" height="11" rx="2" fill="#fce7f3" stroke="#6366f1" strokeWidth="0.75" />
                <rect x="42" y="101" width="5" height="2" fill="#00ffff" />
                <rect x="53" y="101" width="5" height="2" fill="#00ffff" />
              </g>

              {/* Face plate/Head */}
              <circle cx="50" cy="52" r="24.5" fill="#0a0e17" stroke="#151e2e" strokeWidth="1.5" />
              <circle cx="50" cy="52" r="22" fill="#0e1320" />

              {/* Computereque blush */}
              <line x1="32" y1="60" x2="38" y2="60" stroke="#ff2a85" strokeWidth="0.85" />
              <line x1="34" y1="62" x2="36" y2="62" stroke="#ff2a85" strokeWidth="0.85" />
              <line x1="68" y1="60" x2="62" y2="60" stroke="#ff2a85" strokeWidth="0.85" />
              <line x1="66" y1="62" x2="64" y2="62" stroke="#ff2a85" strokeWidth="0.85" />

              {/* Eye expressions */}
              {faceExpr === 'star' ? (
                <>
                  <path d="M 33 50 L 37 46 L 41 50 L 37 54 Z" fill="#39ff14" />
                  <path d="M 59 50 L 63 46 L 67 50 L 63 54 Z" fill="#39ff14" />
                  <path d="M 45 61 Q 50 67 55 61 Z" fill="#ff2a85" stroke="#fff" strokeWidth="0.5" />
                </>
              ) : faceExpr === 'focused' ? (
                <>
                  <rect x="29" y="46" width="14" height="9" rx="1.5" fill="none" stroke="#ffb700" strokeWidth="1" opacity="0.8" />
                  <rect x="57" y="46" width="14" height="9" rx="1.5" fill="none" stroke="#ffb700" strokeWidth="1" opacity="0.8" />
                  <line x1="32" y1="50" x2="40" y2="50" stroke={eyeColor} strokeWidth="2.2" strokeLinecap="round" />
                  <line x1="60" y1="50" x2="68" y2="50" stroke={eyeColor} strokeWidth="2.2" strokeLinecap="round" />
                </>
              ) : faceExpr === 'wide' ? (
                <>
                  <circle cx="36" cy="51" r="4.5" fill="none" stroke={eyeColor} strokeWidth="2" />
                  <circle cx="36" cy="51" r="1.5" fill={eyeColor} />
                  <circle cx="64" cy="51" r="4.5" fill="none" stroke={eyeColor} strokeWidth="2" />
                  <circle cx="64" cy="51" r="1.5" fill={eyeColor} />
                  <circle cx="50" cy="62" r="2.5" fill="#ff2a85" stroke="#fff" strokeWidth="0.5" />
                </>
              ) : faceExpr === 'smirk' ? (
                <>
                  <path d="M 30 52 Q 35 45 40 50" fill="none" stroke={eyeColor} strokeWidth="2.5" strokeLinecap="round" />
                  <ellipse cx="64" cy="50" rx="4" ry="2.2" fill={eyeColor} />
                  <path d="M 46 62 Q 53 58 53 62" fill="none" stroke="#ff2a85" strokeWidth="1.8" strokeLinecap="round" />
                </>
              ) : faceExpr === 'narrow' ? (
                <>
                  <path d="M 31 52 Q 36 55 41 52" fill="none" stroke={eyeColor} strokeWidth="2.2" strokeLinecap="round" />
                  <path d="M 59 52 Q 64 55 69 52" fill="none" stroke={eyeColor} strokeWidth="2.2" strokeLinecap="round" />
                  <path d="M 47 61 Q 50 63 53 61" fill="none" stroke="#ff2a85" strokeWidth="1.5" strokeLinecap="round" />
                  <text x="74" y="32" fill="#60a5fa" fontSize="8" fontWeight="bold" className="animate-bounce">Z</text>
                </>
              ) : (
                <>
                  <ellipse cx="36" cy="51" rx="4.2" ry="5.8" fill={eyeColor} />
                  <ellipse cx="36" cy="51" rx="2.2" ry="3.5" fill="#030b14" />
                  <circle cx="37.5" cy="48" r="1.5" fill="#fff" />

                  <ellipse cx="64" cy="51" rx="4.2" ry="5.8" fill={eyeColor} />
                  <ellipse cx="64" cy="51" rx="2.2" ry="3.5" fill="#030b14" />
                  <circle cx="65.5" cy="48" r="1.5" fill="#fff" />
                  <path d="M 45 60 Q 50 65 55 60" fill="none" stroke="#ff2a85" strokeWidth="2" strokeLinecap="round" />
                </>
              )}

              {/* Fringe/Cowlick hair elements */}
              <polygon points="50,25 53,38 47,38" fill="#a5b4fc" opacity="0.9" />
              <circle cx="50" cy="8" r="2.2" fill="#00f3ff" className="antenna-pulse" />
            </g>
          )}

          {/* ==================== ⚔️ STAGE 4: CHAMPION [AIMIVALKYRIE] ==================== */}
          {currentLevel === 4 && (
            <g className="aimi-body-bouce">
              {/* Floating laser cyber wings on back */}
              <g opacity="0.8" className="animate-pulse" style={{ animationDuration: '3s' }}>
                {/* Left wing paths */}
                <path d="M 22 45 S -15 15, -12 10 S 0 35, 15 48 M 22 52 S -25 35, -20 30 S 5 45, 18 53" fill="none" stroke="#00e1ff" strokeWidth="2" strokeLinecap="round" />
                {/* Right wing paths */}
                <path d="M 78 45 S 115 15, 112 10 S 100 35, 85 48 M 78 52 S 125 35, 120 30 S 95 45, 82 53" fill="none" stroke="#00e1ff" strokeWidth="2" strokeLinecap="round" />
              </g>

              {/* Large twin tails with code symbols inside them */}
              <g className="miku-hair-left">
                <path d="M 28 42 C 6 50, -15 65, -2 94 C 5 97, 10 88, 14 74 C 18 60, 24 48, 28 42 Z" fill="url(#mikuHairGradient)" stroke="#00dbf5" strokeWidth="1" />
                {/* Pink block ribbons */}
                <rect x="22" y="30" width="8" height="12" fill={ribbonColor} stroke="#000" strokeWidth="0.8" />
                {/* Visual code lines inside hair stream */}
                <path d="M 12 55 L -6 75" stroke="#39ff14" strokeWidth="0.75" strokeDasharray="3,3" />
              </g>

              <g className="miku-hair-right">
                <path d="M 72 42 C 94 50, 115 65, 102 94 C 95 97, 90 88, 86 74 C 82 60, 76 48, 72 42 Z" fill="url(#mikuHairGradient)" stroke="#00dbf5" strokeWidth="1" />
                <rect x="70" y="30" width="8" height="12" fill={ribbonColor} stroke="#000" strokeWidth="0.8" />
                <path d="M 88 55 L 106 75" stroke="#39ff14" strokeWidth="0.75" strokeDasharray="3,3" />
              </g>

              {/* Giant defensive radar pieces floating beside shoulders */}
              <g className="animate-bounce" style={{ animationDuration: '4s' }}>
                <polygon points="4,40 10,34 16,40 10,46" fill="#ff2a85" stroke="#00f3ff" strokeWidth="0.75" />
                <polygon points="96,40 90,34 84,40 90,46" fill="#ff2a85" stroke="#00f3ff" strokeWidth="0.75" />
              </g>

              {/* Headset audio cups */}
              <rect x="11" y="42" width="8" height="16" rx="2" fill="#0a0c10" stroke="#ff2a85" strokeWidth="1.5" />
              <circle cx="15" cy="50" r="2.5" fill="#00ffff" />
              <rect x="81" y="42" width="8" height="16" rx="2" fill="#0a0c10" stroke="#ff2a85" strokeWidth="1.5" />
              <circle cx="85" cy="50" r="2.5" fill="#00ffff" />

              {/* Main Android face block structure */}
              <circle cx="50" cy="52" r="27" fill="#060910" stroke="#10192a" strokeWidth="2" />
              <circle cx="50" cy="52" r="24.5" fill="#090f1d" />

              {/* Cheek diagnostic metrics */}
              <path d="M 32 58 L 38 58" stroke="#00e1ff" strokeWidth="1" />
              <path d="M 68 58 L 62 58" stroke="#00e1ff" strokeWidth="1" />

              {/* SPECTACLE SCANNING GLOWING VISOR GLASSES */}
              <polygon points="26,45 74,45 70,54 30,54" fill="rgba(255, 42, 133, 0.45)" stroke="#ff2a85" strokeWidth="1" />
              <line x1="28" y1="50" x2="72" y2="50" stroke="#39ff14" strokeWidth="0.8" opacity="0.8" strokeDasharray="2,2" />

              {/* Smiley tactical cute mouth */}
              <path d="M 46 62 Q 50 66 54 62" fill="none" stroke="#00dbf5" strokeWidth="2" strokeLinecap="round" />

              {/* Forehead custom binary crosshair crest */}
              <path d="M 50 25 L 53 38 L 47 38 Z" fill="#ff2a85" />
              <circle cx="50" cy="18" r="3" fill="#ff2a85" className="antenna-pulse" />
            </g>
          )}

          {/* ==================== 😇 STAGE 5: MEGA [OMNIAIMIOS] ==================== */}
          {currentLevel === 5 && (
            <g className="aimi-body-bouce">
              {/* Outer Golden Space Core Orbit Ring */}
              <circle cx="50" cy="51" r="44" fill="none" stroke="rgba(234, 179, 8, 0.35)" strokeWidth="1" strokeDasharray="10,5" className="animate-spin" style={{ animationDuration: '10s' }} />
              <circle cx="50" cy="51" r="39" fill="none" stroke="rgba(0, 240, 255, 0.2)" strokeWidth="0.75" strokeDasharray="2,6" className="animate-spin" style={{ animationDuration: '6s', animationDirection: 'reverse' }} />

              {/* Floating golden server bit nodes */}
              <g className="animate-bounce" style={{ animationDuration: '3.5s' }}>
                <polygon points="12,24 15,20 18,24 15,28" fill="#eab308" stroke="#fff" strokeWidth="0.5" />
                <polygon points="88,24 91,20 94,24 91,28" fill="#eab308" stroke="#fff" strokeWidth="0.5" />
                <polygon points="50,91 53,87 56,91 53,95" fill="#00e1ff" stroke="#fff" strokeWidth="0.5" />
              </g>

              {/* God-like cosmic white twin tails braids */}
              <g className="miku-hair-left">
                <path d="M 28 42 C 4 48, -18 60, -8 95 C 1 100, 8 92, 13 75 C 18 58, 24 46, 28 42 Z" fill="url(#mikuHairGradient)" stroke="#eab308" strokeWidth="1.2" />
                <rect x="22" y="28" width="8" height="14" rx="2" fill="#eab308" />
                <circle cx="26" cy="35" r="2" fill="#000" />
              </g>

              <g className="miku-hair-right">
                <path d="M 72 42 C 96 48, 118 60, 108 95 C 99 100, 92 92, 87 75 C 82 58, 76 46, 72 42 Z" fill="url(#mikuHairGradient)" stroke="#eab308" strokeWidth="1.2" />
                <rect x="70" y="28" width="8" height="14" rx="2" fill="#eab308" />
                <circle cx="74" cy="35" r="2" fill="#000" />
              </g>

              {/* Supreme Royal gold halo crown floating above */}
              <g className="animate-pulse" style={{ animationDuration: '2s' }}>
                <ellipse cx="50" cy="14" rx="16" ry="3" fill="none" stroke="#eab308" strokeWidth="2" />
                <polygon points="50,4 47,12 53,12" fill="#eab308" />
                <polygon points="38,8 37,13 42,13" fill="#eab308" />
                <polygon points="62,8 58,13 63,13" fill="#eab308" />
              </g>

              {/* Elegant translucent deep bio-space helmet plate bubble */}
              <circle cx="50" cy="52" r="26" fill="rgba(8, 22, 45, 0.9)" stroke="url(#megaCrownGrad)" strokeWidth="2.2" />

              {/* Internal neon runes and circuits glowing */}
              <path d="M 33 46 Q 50 36 67 46" fill="none" stroke="#00f3ff" strokeWidth="1" opacity="0.6" />
              <path d="M 33 58 Q 50 68 67 58" fill="none" stroke="#00f3ff" strokeWidth="1" opacity="0.6" />

              {/* Cosmic glowing dual slit eyes */}
              <line x1="33" y1="51" x2="43" y2="51" stroke="#eab308" strokeWidth="3" strokeLinecap="round" />
              <line x1="35" y1="51" x2="41" y2="51" stroke="#fff" strokeWidth="1" strokeLinecap="round" />

              <line x1="57" y1="51" x2="67" y2="51" stroke="#eab308" strokeWidth="3" strokeLinecap="round" />
              <line x1="59" y1="51" x2="65" y2="51" stroke="#fff" strokeWidth="1" strokeLinecap="round" />

              {/* Golden tiny curved laughing mouth line */}
              <path d="M 47 62 Q 50 66 53 62" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
              
              {/* Cheek matrix dots */}
              <circle cx="34" cy="57" r="1" fill="#39ff14" />
              <circle cx="66" cy="57" r="1" fill="#39ff14" />
            </g>
          )}

        </svg>

        {/* Small glowing heart or status light projecting in real space */}
        <span 
          style={{ backgroundColor: eyeColor }}
          className="absolute top-2 left-11.5 w-2 h-2 rounded-full shadow-[0_0_10px_currentColor] animate-ping z-20" 
        />
      </div>
    );
  };

  const xpBounds = getXpBoundaries(getLevelFromXp(experience));
  const progressPercent = Math.min(100, Math.max(0, ((experience - xpBounds.min) / (xpBounds.max - xpBounds.min)) * 100));

  // Determine dynamic placement for fixed or absolute coordinate matrices
  const isConsoleOnLeft = consolePosition 
    ? consolePosition.x < window.innerWidth / 2 
    : isAimiOnLeft;

  const chatPanelStyle: React.CSSProperties = {
    pointerEvents: 'auto',
  };

  if (consolePosition) {
    chatPanelStyle.position = 'fixed';
    chatPanelStyle.left = `${consolePosition.x}px`;
    chatPanelStyle.top = `${consolePosition.y}px`;
    chatPanelStyle.width = `${consoleWidth}px`;
    chatPanelStyle.height = `${consoleHeight}px`;
    chatPanelStyle.transform = 'none';
    chatPanelStyle.borderRadius = '1rem';
  } else {
    // Docked as an elegant, zero-overflow side drawer on the right side of the screen
    chatPanelStyle.position = 'fixed';
    chatPanelStyle.right = isOpen ? '0px' : '-400px';
    chatPanelStyle.top = '0px';
    chatPanelStyle.bottom = '0px';
    chatPanelStyle.height = '100vh';
    chatPanelStyle.width = '100vw';
    chatPanelStyle.maxWidth = '380px';
    chatPanelStyle.transform = 'none';
    chatPanelStyle.borderRadius = '0px';
    chatPanelStyle.borderLeft = '1px solid #141d30';
    chatPanelStyle.transition = 'right 250ms cubic-bezier(0.16, 1, 0.3, 1)';
  }

  return (
    <>
      {/* 1. CHAT & OS HUD CONSOLE CO-PROCESSOR */}
      {isOpen && (
        <div 
          id="aimi-mascot-chat-panel" 
          className="fixed bg-[#070b13]/97 border border-[#141d30] flex flex-col shadow-[0_16px_50px_rgba(0,0,0,0.95)] overflow-hidden backdrop-blur-md font-mono text-xs text-zinc-300 select-none z-[9999]"
          style={chatPanelStyle}
        >
          {/* Top Panel Banner - Draggable handle! Double click resets */}
          <div 
            onMouseDown={onConsoleDragStart}
            onTouchStart={onConsoleDragStart}
            onDoubleClick={() => {
              setConsolePosition(null);
              setSpeechBubble("Mascot console has re-docked directly to Aimi's shoulder! ✧");
              setActiveExpression('happy');
            }}
            title="DRAG to relocate window. DOUBLE CLICK to re-dock to Aimi-chan!"
            className="cursor-move bg-[#0b1220] border-b border-[#141b2a] p-3 flex items-center justify-between select-none shrink-0 active:cursor-grabbing"
          >
            <div className="flex items-center gap-2 pointer-events-none">
              <span className="w-2.5 h-2.5 rounded-full bg-[#39ff14] animate-pulse" />
              <div className="flex flex-col text-left">
                <span className="text-[10px] text-[#00f0ff] font-bold tracking-wide uppercase">AIMI: DIGI-ASSIST </span>
                <span className="text-[7.5px] text-zinc-500 font-bold uppercase tracking-widest">{getEvolutionStageName(currentLevel)}</span>
              </div>
            </div>

            <div className="flex items-center gap-1.5" onMouseDown={(e) => e.stopPropagation()} onTouchStart={(e) => e.stopPropagation()}>
              <button 
                onClick={() => setShowSkillsDrawer(!showSkillsDrawer)}
                className={`px-1.5 py-0.5 border text-[8px] font-mono rounded transition uppercase cursor-pointer ${
                  showSkillsDrawer 
                    ? 'bg-indigo-500/20 border-indigo-500/50 text-indigo-300' 
                    : 'bg-black/45 border-zinc-800 text-zinc-550 hover:text-indigo-400 hover:border-indigo-400/40'
                }`}
                title="Toggle adjacent Skills Ledger cabinet"
              >
                🎓 Skills Book
              </button>
              <button 
                onClick={() => {
                  setActiveExpression('sitting');
                  setSpeechBubble("Aimi tucked into cozy rest mode! Tap me anytime. (￣ω￣)");
                  setIsOpen(false);
                }}
                className="px-1.5 py-0.5 bg-black/45 border border-zinc-800 text-[8px] font-mono text-zinc-400 hover:text-amber-400 hover:border-amber-400/40 rounded transition uppercase cursor-pointer"
                title="Settle Aimi into quiet rest mode"
              >
                💤 Rest
              </button>
              <button 
                onClick={() => setIsOpen(false)}
                className="p-1 hover:bg-zinc-800 rounded text-zinc-400 hover:text-red-400 transition cursor-pointer"
                title="Minimize console"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* EVOLUTION / PROGRESS BAR HUD SECTION (Digimon interface) */}
          <div className="bg-black/75 border-b border-[#111825] p-2.5 flex flex-col gap-1.5 select-none shrink-0 text-left">
            <div className="flex items-center justify-between text-[8px] font-bold uppercase tracking-wider text-gray-400">
              <span className="flex items-center gap-1 text-[#ff2a85]">
                <Award className="w-3.5 h-3.5 text-amber-500 stroke-[2.5]" />
                BIOMAC EXPERIENCES LEVEL:
              </span>
              <span className="text-zinc-505">Level {currentLevel}</span>
            </div>
            
            {/* Experience progression tube */}
            <div className="flex items-center gap-2">
              <div className="flex-1 bg-zinc-950 h-2 bg-gradient-to-r rounded border border-zinc-900 overflow-hidden relative">
                <div 
                  className="h-full bg-gradient-to-r from-cyan-500 via-[#ff2a85] to-[#39ff14] transition-all duration-500 ease-out" 
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
              <span className="text-[7.5px] text-zinc-500 tracking-tighter shrink-0">
                {experience} / {xpBounds.max} XP
              </span>
            </div>
          </div>

          {/* Subtab Navigation Selector */}
          <div className="grid grid-cols-4 p-1 bg-black/50 border-b border-[#111928] select-none shrink-0 font-mono text-[7px] xs:text-[8px] gap-0.5 sm:gap-1 text-center">
            <button
              onClick={() => setMascotTab('chat')}
              className={`py-1.5 rounded uppercase font-bold tracking-wider transition ${
                mascotTab === 'chat' 
                  ? 'bg-[#00f0ff]/10 text-[#00f0ff] border border-[#00f0ff]/30' 
                  : 'text-zinc-500 hover:text-white'
              }`}
            >
              💬 Chat
            </button>
            <button
              onClick={() => setMascotTab('systems')}
              className={`py-1.5 rounded uppercase font-bold tracking-wider transition ${
                mascotTab === 'systems' 
                  ? 'bg-[#ff2a85]/10 text-[#ff2a85] border border-[#ff2a85]/30' 
                  : 'text-zinc-500 hover:text-white'
              }`}
            >
              ⚙️ Sched
            </button>
            <button
              onClick={() => setMascotTab('diagnostics')}
              className={`py-1.5 rounded uppercase font-bold tracking-wider transition ${
                mascotTab === 'diagnostics' 
                  ? 'bg-amber-500/10 text-amber-400 border border-amber-500/30' 
                  : 'text-zinc-500 hover:text-white'
              }`}
            >
              📊 Fit
            </button>
            <button
              onClick={() => setMascotTab('skills')}
              className={`py-1.5 rounded uppercase font-bold tracking-wider transition ${
                mascotTab === 'skills' 
                  ? 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/30' 
                  : 'text-zinc-500 hover:text-white'
              }`}
            >
              🎓 Book
            </button>
          </div>

          {/* CONTENT ACCORDING TO ACTIVE SUBTAB */}
          {mascotTab === 'chat' ? (
            /* ==================== 💬 SUBTAB: CHAT COMPANION SYSTEM ==================== */
            <div className="flex-1 flex flex-col min-h-0">
              
              {/* Scrollable conversation history */}
              <div className="flex-1 overflow-y-auto p-4 space-y-3.5 scrollbar-thin">
                {chatHistory.map((item, idx) => (
                  <div 
                    key={idx} 
                    className={`flex gap-2 items-start ${item.role === 'user' ? 'justify-end' : 'justify-start'}`}
                  >
                    {item.role === 'model' && (
                      <div className="w-6 h-6 rounded-full bg-[#080c14] flex items-center justify-center border border-[#00f3ff]/45 shrink-0 select-none overflow-hidden" title="Aimi Profile Avatar">
                        <svg viewBox="0 0 40 40" className="w-5 h-5 drop-shadow-[0_0_2px_rgba(0,243,255,0.7)]">
                          {/* Cute Blue Anime Hair Back */}
                          <path d="M 12 10 Q 20 6 28 10 Q 34 16 34 26 L 31 34 Q 28 32 26 28 L 24 16 L 16 16 L 14 28 Q 12 32 9 34 L 6 26 Q 6 16 12 10 Z" fill="#818cf8"/>
                          
                          {/* Face skin/body */}
                          <circle cx="20" cy="22" r="10" fill="#090d16" stroke="#121e33" strokeWidth="0.8"/>
                          
                          {/* Cute glowing anime eyes */}
                          <ellipse cx="16" cy="21" rx="1.5" ry="2.2" fill="#00f3ff"/>
                          <circle cx="15.5" cy="19.8" r="0.6" fill="#fff"/>
                          <ellipse cx="24" cy="21" rx="1.5" ry="2.2" fill="#00f3ff"/>
                          <circle cx="23.5" cy="19.8" r="0.6" fill="#fff"/>
                          
                          {/* Glowing blush marks */}
                          <circle cx="13.5" cy="24" r="1" fill="#ff2a85" opacity="0.85"/>
                          <circle cx="26.5" cy="24" r="1" fill="#ff2a85" opacity="0.85"/>

                          {/* Smiley mouth */}
                          <path d="M 19 25 Q 20 27 21 25" fill="none" stroke="#00f3ff" strokeWidth="0.8" strokeLinecap="round"/>

                          {/* Front Bangs */}
                          <path d="M 12 11 Q 20 15 28 11 Q 22 10 20 13 Q 18 10 12 11 Z" fill="#a5b4fc"/>
                          
                          {/* Headset Ears antennas */}
                          <polygon points="11,12 13,4 17,9" fill="#ff2a85"/>
                          <polygon points="29,12 27,4 23,9" fill="#ff2a85"/>
                        </svg>
                      </div>
                    )}
                    
                    <div className={`max-w-[82%] rounded-xl px-3 py-2 text-[10.5px] leading-relaxed font-sans ${
                      item.role === 'user' 
                        ? 'bg-[#00f0ff]/10 border border-[#00f0ff]/20 text-gray-100 rounded-tr-none' 
                        : 'bg-black/35 border border-[#121c2e] text-zinc-350 rounded-tl-none'
                    }`}>
                      {item.role === 'model' ? (
                        <div className="space-y-1.5 select-text text-left">
                          {item.text.split('\n\n').map((para, pIdx) => (
                            <p key={pIdx} className="whitespace-pre-wrap">{para}</p>
                          ))}
                        </div>
                      ) : (
                        <span className="whitespace-pre-wrap select-text text-left block">{item.text}</span>
                      )}
                    </div>

                    {item.role === 'user' && (
                      <div className="w-5 h-5 rounded-full bg-cyan-950 flex items-center justify-center p-0.5 border border-cyan-500/50 shrink-0 select-none">
                        <User className="w-3.5 h-3.5 text-cyan-400" />
                      </div>
                    )}
                  </div>
                ))}
                {isLoading && (
                  <div className="flex gap-2 items-center text-zinc-500 font-mono text-[9px] text-left">
                    <span className="w-1.5 h-1.5 bg-[#00f0ff] rounded-full animate-ping" />
                    <span>Aimi-chan is computing neural systems vectors...</span>
                  </div>
                )}
                <div ref={chatEndRef} />
              </div>

              {/* Quick Guide Tips */}
              {showGuideTips && (
                <div className="px-3 py-2.5 bg-black/60 border-t border-[#121c2e] shrink-0 select-none text-left">
                  <div className="flex justify-between items-center text-[8.5px] text-zinc-500 font-mono uppercase mb-1.5 font-bold">
                    <span className="flex items-center gap-1"><Lightbulb className="w-3 h-3 text-amber-400" /> Prompt suggestions:</span>
                    <button onClick={() => setShowGuideTips(false)} className="hover:text-white uppercase text-[8px]">Dismiss</button>
                  </div>
                  <div className="flex gap-1.5 overflow-x-auto scrollbar-none pb-0.5">
                    <button 
                      type="button" 
                      onClick={() => triggerQuickTopic('explain', 'Can you explain the current layout and how the Topology DAG wires together?')}
                      className="shrink-0 px-2 py-1 bg-zinc-900 border border-[#141b2e] rounded hover:border-[#00f0ff] hover:text-[#00f0ff] text-[8px] font-mono text-zinc-400 transition cursor-pointer"
                    >
                      🧩 Explain Visual DAG
                    </button>
                    <button 
                      type="button" 
                      onClick={() => triggerQuickTopic('sec', 'How do zero-copy atomic ring-buffers protect memory during model inference?')}
                      className="shrink-0 px-2 py-1 bg-zinc-900 border border-[#141b2e] rounded hover:border-[#00f0ff] hover:text-[#00f0ff] text-[8px] font-mono text-zinc-400 transition cursor-pointer"
                    >
                      ⚡ Ring Buffer latency
                    </button>
                    <button 
                      type="button" 
                      onClick={() => triggerQuickTopic('osgrade', 'What are your recommendations to convert this workspace into a full OS-grade AI?')}
                      className="shrink-0 px-2 py-1 bg-zinc-900 border border-[#141b2e] rounded hover:border-[#ff2a85] hover:text-[#ff2a85] text-[8px] font-mono text-zinc-400 transition cursor-pointer"
                    >
                      🤖 Build OS Grade AI
                    </button>
                  </div>
                </div>
              )}

              {/* Chat Send Form Footer */}
              <form 
                onSubmit={handleSend}
                className="p-2.5 bg-[#0a0f19] border-t border-[#131b2c] flex gap-2 items-center shrink-0"
              >
                <input 
                  type="text"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Ask Aimi (e.g. optimize)..."
                  disabled={isLoading}
                  className="flex-1 bg-black/60 border border-[#1d273a] rounded-lg px-2.5 py-1.5 text-[10.5px] text-zinc-200 font-sans outline-none focus:border-[#00f0ff] focus:ring-1 focus:ring-[#00f0ff] transition"
                />
                <button 
                  id="aimi-send-btn"
                  type="submit"
                  disabled={!message.trim() || isLoading}
                  className="w-7 h-7 bg-cyan-950 border border-cyan-900 hover:bg-[#00f0ff] hover:text-black rounded-lg transition flex items-center justify-center shrink-0 cursor-pointer disabled:bg-zinc-900 disabled:text-zinc-600 disabled:border-zinc-850"
                  title="Send query"
                >
                  <Send className="w-3.5 h-3.5" />
                </button>
              </form>
            </div>
          ) : mascotTab === 'systems' ? (
            /* ==================== ⚙️ SUBTAB: OS SCHEDULER SYSTEM STACKS ==================== */
            <div className="flex-1 flex flex-col min-h-0 overflow-y-auto p-3 space-y-3.5 scrollbar-thin text-left">
              
              {/* PLAYGROUND: FORCE EVOLUTION SECTOR (Digimon override) */}
              <div className="bg-black/60 border border-indigo-950 rounded-xl p-3 space-y-2">
                <span className="text-[10px] font-bold text-indigo-400 uppercase tracking-wider flex items-center gap-1.5">
                  <Award className="w-3.5 h-3.5 text-indigo-400 animate-pulse" />
                  Biomac Evolution Playground
                </span>
                <p className="text-[8.5px] text-zinc-400 font-sans leading-relaxed">
                  Grind tasks or cheat her development! Toggle any stage manually to review Aimi's high-tech evolution.
                </p>
                <div className="grid grid-cols-2 gap-1 font-mono text-[8px]">
                  <button 
                    onClick={() => {
                      setForceEvolutionStage(null);
                      setSpeechBubble("Aimi calibrated to your actual task experience levels! ✧✧");
                    }}
                    className={`py-1 rounded border transition uppercase ${
                      forceEvolutionStage === null 
                        ? 'bg-indigo-950 text-indigo-300 border-indigo-500/50' 
                        : 'bg-zinc-900 text-zinc-505 border-transparent'
                    }`}
                  >
                    ⭐ Natural XP Stage
                  </button>
                  <button 
                    onClick={() => setForceEvolutionStage(1)}
                    className={`py-1 rounded border transition uppercase ${
                      forceEvolutionStage === 1 ? 'bg-[#00f0ff]/10 text-[#00f0ff] border-[#00f0ff]/30' : 'bg-zinc-900 text-zinc-500 border-transparent'
                    }`}
                  >
                    Egg [Neon Seed]
                  </button>
                  <button 
                    onClick={() => setForceEvolutionStage(2)}
                    className={`py-1 rounded border transition uppercase ${
                      forceEvolutionStage === 2 ? 'bg-[#00f0ff]/10 text-[#00f0ff] border-[#00f0ff]/30' : 'bg-zinc-900 text-zinc-500 border-transparent'
                    }`}
                  >
                    In-Training [AmiBud]
                  </button>
                  <button 
                    onClick={() => setForceEvolutionStage(3)}
                    className={`py-1 rounded border transition uppercase ${
                      forceEvolutionStage === 3 ? 'bg-[#00f0ff]/10 text-[#00f0ff] border-[#00f0ff]/30' : 'bg-zinc-900 text-zinc-500 border-transparent'
                    }`}
                  >
                    Rookie [Aimi-chan]
                  </button>
                  <button 
                    onClick={() => setForceEvolutionStage(4)}
                    className={`py-1 rounded border transition uppercase ${
                      forceEvolutionStage === 4 ? 'bg-[#ff2a85]/10 text-[#ff2a85] border-[#ff2a85]/30' : 'bg-zinc-900 text-zinc-500 border-transparent'
                    }`}
                  >
                    Champion [Valkyrie]
                  </button>
                  <button 
                    onClick={() => setForceEvolutionStage(5)}
                    className={`py-1 rounded border transition col-span-2 uppercase ${
                      forceEvolutionStage === 5 ? 'bg-amber-500/10 text-amber-400 border-amber-500/30' : 'bg-zinc-900 text-zinc-500 border-transparent'
                    }`}
                  >
                    Mega [OmniAimiOS Supreme]
                  </button>
                </div>
              </div>

              {/* Dynamic Live Advising diagnostics */}
              <div className="bg-black/45 border border-[#121e35] rounded-xl p-3 space-y-2">
                <span className="text-[10px] font-bold text-cyan-400 uppercase tracking-wider flex items-center gap-1.5">
                  <Cpu className="w-3.5 h-3.5 text-[#00f0ff]" />
                  Mascot Microkernel scan advice
                </span>

                <div className="pt-1">
                  <button
                    type="button"
                    onClick={runOsDiagnosticScan}
                    disabled={runningDiag}
                    className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 bg-cyan-950/70 hover:bg-cyan-900/80 border border-cyan-800 text-[9px] font-bold text-cyan-400 rounded-lg cursor-pointer transition uppercase"
                  >
                    <RefreshCw className={`w-3 h-3 ${runningDiag ? 'animate-spin' : ''}`} />
                    {runningDiag ? 'Accessing registers...' : 'Access advice analyzer'}
                  </button>
                </div>

                {/* Audit Logs */}
                {diagnosticReport && (
                  <div className="space-y-1 bg-black/60 border border-zinc-900 rounded p-2 max-h-[110px] overflow-y-auto scrollbar-thin">
                    {diagnosticReport.map((rep, rIdx) => (
                      <div key={rIdx} className="text-[8.5px] leading-relaxed border-b border-zinc-950 pb-1 last:border-0 last:pb-0 font-sans">
                        {rep}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Direct Task Code Scaffolder */}
              <div className="bg-black/45 border border-[#121c2e] rounded-xl p-3 space-y-2">
                <span className="text-[10px] font-bold text-[#ff2a85] uppercase tracking-wider flex items-center gap-1.5">
                  <Plus className="w-3.5 h-3.5 text-[#ff2a85]" />
                  Scaffold New task node
                </span>

                {scaffoldSuccess && (
                  <div className="p-1.5 bg-emerald-950/40 border border-emerald-900 text-emerald-400 text-[8.5px] rounded-lg flex items-center gap-1 font-sans">
                    <Check className="w-3 h-3" />
                    <span>{scaffoldSuccess}</span>
                  </div>
                )}

                <form onSubmit={handleScaffoldTaskNode} className="space-y-2 text-[9px]">
                  <div>
                    <label className="block text-[7.5px] text-zinc-500 uppercase font-bold mb-0.5">Task Node Alias</label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. CGo_Lock_Engine"
                      value={scaffoldName}
                      onChange={(e) => setScaffoldName(e.target.value)}
                      className="w-full bg-black border border-zinc-800 rounded px-2.5 py-1 text-zinc-200 outline-none focus:border-cyan-400 font-mono"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-1.5">
                    <div>
                      <label className="block text-[7.5px] text-zinc-500 uppercase font-bold mb-0.5">Mascot role</label>
                      <select
                        value={scaffoldType}
                        onChange={(e: any) => setScaffoldType(e.target.value)}
                        className="w-full bg-[#111] border border-zinc-800 rounded p-1 text-zinc-300 outline-none font-mono text-[8px]"
                      >
                        <option value="LocalInference">LLM Inference</option>
                        <option value="TaskPlanner">Task Planner</option>
                        <option value="ToolExecutor">Tool Executor</option>
                        <option value="IngressRouter">Inbound Gateway</option>
                        <option value="ResponseAggregator">Collector</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-[7.5px] text-zinc-500 uppercase font-bold mb-0.5">Accelerator</label>
                      <select
                        value={scaffoldProcessor}
                        onChange={(e: any) => setScaffoldProcessor(e.target.value)}
                        className="w-full bg-[#111] border border-zinc-800 rounded p-1 text-zinc-300 outline-none font-mono text-[8px]"
                      >
                        <option value="GPU-TensorCore">Local GPU Core</option>
                        <option value="NPU-Local">Local NPU Core</option>
                        <option value="CPU">Host CPU Pinned</option>
                        <option value="Remote-Cloud">Cloud Fallback</option>
                      </select>
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={!onAddNode || !scaffoldName.trim()}
                    className="w-full bg-[#ff2a85] hover:bg-[#ff1472] text-white font-bold py-1 rounded cursor-pointer transition uppercase flex items-center justify-center gap-1"
                  >
                    Scaffold Task Node <ArrowRight className="w-3 h-3 text-white" />
                  </button>
                </form>
              </div>

              {/* Microkernel parameters modifiers */}
              {config && onUpdateConfig && (
                <div className="bg-black/45 border border-[#121c2e] rounded-xl p-3 space-y-2.5">
                  <span className="text-[10px] font-bold text-yellow-500 uppercase tracking-wider flex items-center gap-1.5 font-mono">
                    <Sliders className="w-3.5 h-3.5 text-yellow-500" />
                    Interactive Microkernel controls
                  </span>

                  <div className="space-y-2">
                    {/* Thread Pinning register toggle */}
                    <div className="flex items-center justify-between border-b border-zinc-900 pb-1.5">
                      <div className="flex flex-col">
                        <span className="text-[9px] font-bold text-zinc-350">PIN_THREADS_TO_GO_CORE</span>
                        <span className="text-[7.5px] text-zinc-500">Lock virtual threads on OS p-cores</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          const nextVal = !config.pinThreadsToGoRuntime;
                          onUpdateConfig({ ...config, pinThreadsToGoRuntime: nextVal });
                          setSpeechBubble(nextVal 
                            ? "Locked Go Scheduler threads direct to hardware cores! Latency minimized!"
                            : "Unlocked threads from physical hardware cores."
                          );
                          gainExperience(12, "Toggled physical OS thread processor pins");
                        }}
                        className={`px-1.5 py-0.5 text-[8px] font-bold rounded cursor-pointer transition ${
                          config.pinThreadsToGoRuntime 
                            ? 'bg-[#39ff14]/15 border border-[#39ff14]/30 text-[#39ff14]' 
                            : 'bg-zinc-900 border border-zinc-800 text-zinc-500'
                        }`}
                      >
                        {config.pinThreadsToGoRuntime ? "LOCKED" : "DYNAMIC"}
                      </button>
                    </div>

                    {/* High Throughput Streaming hyper pipe toggle */}
                    <div className="flex items-center justify-between border-b border-zinc-900 pb-1.5">
                      <div className="flex flex-col">
                        <span className="text-[9px] font-bold text-zinc-350">HIGH_THROUGHPUT_PIPES</span>
                        <span className="text-[7.5px] text-zinc-500">Optimize channels for stream transfers</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          const nextVal = !config.highThroughputMode;
                          onUpdateConfig({ ...config, highThroughputMode: nextVal });
                          setSpeechBubble(nextVal 
                            ? "High-Throughput mode initiated! Streaming buffers expanded!"
                            : "Standard balanced bandwidth enabled."
                          );
                          gainExperience(12, "Toggled core bandwidth streaming registers");
                        }}
                        className={`px-1.5 py-0.5 text-[8px] font-bold rounded cursor-pointer transition ${
                          config.highThroughputMode 
                            ? 'bg-cyan-500/15 border border-cyan-800 text-cyan-400' 
                            : 'bg-zinc-900 border border-zinc-800 text-zinc-500'
                        }`}
                      >
                        {config.highThroughputMode ? "HYPER" : "STANDARD"}
                      </button>
                    </div>

                    {/* Dynamic Concurrency sliding scaler */}
                    <div className="space-y-1">
                      <div className="flex justify-between items-center text-[9px] font-bold text-zinc-350">
                        <span>CONCURRENCY_WORKERS_LIMIT</span>
                        <span className="text-[#00f0ff] text-[8.5px]">{config.concurrencyWorkers} Workers</span>
                      </div>
                      <input
                        type="range"
                        min="2"
                        max="32"
                        value={config.concurrencyWorkers}
                        onChange={(e) => {
                          onUpdateConfig({
                            ...config,
                            concurrencyWorkers: parseInt(e.target.value)
                          });
                        }}
                        className="w-full text-[#00f0ff] bg-zinc-800 cursor-pointer accent-[#00f0ff]"
                      />
                    </div>
                  </div>
                </div>
              )}

            </div>
          ) : mascotTab === 'skills' ? (
            /* ==================== 🎓 SUBTAB: SKILLS TRAINING ACADEMY ==================== */
            <div className="flex-1 flex flex-col min-h-0 overflow-y-auto p-3 sm:p-3.5 space-y-3 sm:space-y-3.5 scrollbar-thin text-left font-mono">
              {grindingSkillId ? (
                // ACTIVE SKILL GRINDING COMPILATION TERMINAL
                <div className="flex-1 flex flex-col bg-black/85 border border-indigo-950 rounded-xl p-3 space-y-3 font-mono justify-between min-h-[200px]">
                  <div className="space-y-2">
                    <div className="flex items-center gap-1.5 text-amber-400 text-[10px] uppercase font-bold tracking-wider animate-pulse">
                      <Sparkles className="w-3.5 h-3.5 text-amber-400 rotate-12" />
                      <span>CO-CHIP COMPILATION BOUND REGISTERS:</span>
                    </div>
                    
                    {/* Live compilation log printouts */}
                    <div className="bg-zinc-950 border border-zinc-900 rounded p-2 font-mono text-[8.5px] text-[#39ff14] leading-normal space-y-1 h-[140px] overflow-y-auto select-text scrollbar-thin">
                      {grindLogs.map((logLine, lIdx) => (
                        <p key={lIdx} className="whitespace-pre-wrap">➔ {logLine}</p>
                      ))}
                      <div className="inline-block w-1.5 h-3.5 bg-[#39ff14]/70 animate-pulse ml-0.5" />
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex justify-between items-center text-[8px] font-bold text-zinc-400">
                      <span>COMPILING OPTIMIZER STRUCT MATRIX:</span>
                      <span className="text-[#39ff14] animate-pulse">{grindProgress}%</span>
                    </div>
                    <div className="w-full bg-zinc-950 h-2.5 rounded border border-zinc-900 overflow-hidden">
                      <div 
                        className="h-full bg-gradient-to-r from-indigo-500 via-cyan-400 to-[#39ff14] transition-all duration-300"
                        style={{ width: `${grindProgress}%` }}
                      />
                    </div>
                  </div>
                </div>
              ) : (
                // SKILLS DIRECTORY
                <div className="space-y-3">
                  <div className="bg-black/40 border border-[#131d2e] rounded-xl p-3 space-y-1.5">
                    <span className="text-[10px] font-bold text-indigo-400 uppercase tracking-wider flex items-center gap-1.5">
                      <Award className="w-3.5 h-3.5 text-indigo-400" />
                      Aimi's Interactive Academy Book
                    </span>
                    <p className="text-[8.5px] font-sans text-zinc-400 leading-normal">
                      Click **"Practice ⚡"** to spin up an interactive compilator micro-game and optimize each skill cluster register! Complete sessions to earn skill experience XP.
                    </p>
                  </div>

                  <div className="space-y-2.5">
                    {aimiSkills.map((skill) => {
                      const skillProg = Math.min(100, Math.max(0, (skill.xp / skill.maxXp) * 100));
                      return (
                        <div key={skill.id} className="bg-[#0b101c]/65 border border-zinc-900 rounded-xl p-3 space-y-2 flex flex-col justify-between hover:border-indigo-500/30 transition">
                          <div className="flex items-start justify-between gap-1.5">
                            <div className="flex flex-col text-left">
                              <span className="text-[9.5px] font-bold text-zinc-100 flex items-center gap-1 flex-wrap">
                                {skill.name} 
                                <span className="bg-indigo-950 border border-indigo-900 text-indigo-400 text-[6.5px] px-1 rounded uppercase font-bold">Lvl {skill.level}</span>
                              </span>
                              <span className="text-[7.5px] text-zinc-500 leading-normal font-sans mt-0.5">{skill.description}</span>
                            </div>
                            
                            <button
                              onClick={() => handlePracticeSkill(skill.id)}
                              className="px-2 py-1 bg-indigo-950 hover:bg-indigo-900 text-indigo-300 hover:text-white border border-indigo-900 text-[7.5px] font-bold rounded cursor-pointer transition uppercase shrink-0 active:scale-95"
                            >
                              Practice ⚡
                            </button>
                          </div>

                          <div className="space-y-1">
                            <div className="flex justify-between items-center text-[7px] text-zinc-500 uppercase font-bold">
                              <span>Skill Exp Progression:</span>
                              <span>{skill.xp} / {skill.maxXp} XP</span>
                            </div>
                            <div className="w-full bg-zinc-950 h-1 rounded overflow-hidden">
                              <div 
                                className="h-full bg-indigo-400 transition-all duration-500" 
                                style={{ width: `${skillProg}%` }}
                              />
                            </div>
                            <div className="text-[7.5px] text-emerald-400 font-bold bg-emerald-950/20 border border-emerald-900/10 p-1.5 rounded mt-1 leading-normal">
                              💎 ACTIVE BOOST: {skill.statBoost}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          ) : (
            /* ==================== 📊 SUBTAB: SYSTEM LIMITS AND SCREEN CORES SCANNER ==================== */
            <div className="flex-1 flex flex-col min-h-0 overflow-y-auto p-4 space-y-4 text-left font-mono">
              <div className="flex items-center gap-1.5 border-b border-zinc-900 pb-2">
                <Monitor className="w-4 h-4 text-amber-500" />
                <span className="text-[10px] font-bold text-zinc-200">FIRST-BOOT DEVICE LIMITATIONS</span>
              </div>

              {hardwareProfile && (
                <div className="space-y-3.5 text-[9.5px]">
                  {/* Summary card element */}
                  <div className="bg-[#101625]/60 border border-amber-500/25 rounded-xl p-3 space-y-2">
                    <div className="flex items-center justify-between col-span-2">
                      <span className="text-[#eab308] font-bold uppercase tracking-wide text-[8px]">Auto-Resolution Profile</span>
                      <span className="px-1.5 py-0.5 bg-amber-950/45 border border-amber-900 text-[6.5px] text-amber-400 rounded font-bold uppercase">
                        {hardwareProfile.deviceClass} Secure Bounds
                      </span>
                    </div>
                    <p className="text-[8.5px] font-sans text-zinc-400 leading-normal">
                      Mascot and widgets auto-tuned their initial viewport offsets, rendering speeds, and interface coordinate matrices safely for your hardware on boot! No layout clipping.
                    </p>
                  </div>

                  {/* Limits Parameters List Grid */}
                  <div className="space-y-2 bg-black/45 border border-zinc-900 p-3 rounded-lg">
                    <div className="flex justify-between border-b border-zinc-950 pb-1.5">
                      <span className="text-zinc-500">SCREEN WIDTH:</span>
                      <span className="text-zinc-200 font-bold">{hardwareProfile.screenWidth} px</span>
                    </div>
                    
                    <div className="flex justify-between border-b border-zinc-950 pb-1.5">
                      <span className="text-zinc-500">SCREEN HEIGHT:</span>
                      <span className="text-zinc-200 font-bold">{hardwareProfile.screenHeight} px</span>
                    </div>

                    <div className="flex justify-between border-b border-zinc-950 pb-1.5">
                      <span className="text-zinc-500">CPU VIRTUAL CORES:</span>
                      <span className="text-[#39ff14] font-bold">{hardwareProfile.cpuCores} Threads</span>
                    </div>

                    <div className="flex justify-between border-b border-zinc-950 pb-1.5">
                      <span className="text-zinc-500">DEVICE RAM VALUE:</span>
                      <span className="text-cyan-400 font-bold">~ {hardwareProfile.approxMemoryGb} GB</span>
                    </div>

                    <div className="flex justify-between border-b border-zinc-950 pb-1.5" title="Responsive coordinate clamp to protect small devices">
                      <span className="text-zinc-500">SAFE SCALING CLAMP:</span>
                      <span className="text-amber-500 font-bold">{hardwareProfile.safeScaleFactor}x Viewport</span>
                    </div>

                    <div className="flex justify-between border-b border-zinc-950 pb-1.5" title="Concurrency worker count recommendation based on actual logical processors">
                      <span className="text-zinc-500">SUGGESTED WORKERS:</span>
                      <span className="text-[#ff2a85] font-bold">{hardwareProfile.concurrencyRecommendation} Workers</span>
                    </div>

                    <div className="flex justify-between">
                      <span className="text-zinc-500">OPTIMAL MEMORY-MODE:</span>
                      <span className="text-zinc-300 font-bold">{hardwareProfile.transportRecommendation}</span>
                    </div>
                  </div>

                  {/* Real-time constraints instructions warning */}
                  <div className="p-2 border border-zinc-850 bg-black/10 rounded flex items-start gap-1.5 font-sans leading-snug text-zinc-400 text-[8.5px]">
                    <ShieldAlert className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5" />
                    <span>
                      Hardware constraints applied: If you encounter canvas UI lags on mobile, disable **High Throughput Pipes** or toggle Aimi into **Rest 💤 Mode** to save rendering memory.
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Interactive Resize handle on the bottom-right corner */}
          <div 
            onMouseDown={onConsoleResizeStart}
            onTouchStart={onConsoleResizeStart}
            className="absolute bottom-0 right-0 w-3.5 h-3.5 cursor-se-resize z-50 flex items-center justify-center select-none active:scale-125"
            title="Drag to resize console"
          >
            <svg viewBox="0 0 10 10" className="w-2.5 h-2.5 text-zinc-500 hover:text-cyan-400 transition" fill="currentColor">
              <path d="M 10 0 L 0 10 M 10 3 L 3 10 M 10 7 L 7 10" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </div>
        </div>
      )}

      {/* FLOATING DECORATIVE SIDE CABINET/DRAWER */}
      {isOpen && showSkillsDrawer && (
        <div 
          className="fixed bg-[#070b13]/97 border border-indigo-950 flex flex-col shadow-[0_16px_50px_rgba(0,0,0,0.95)] overflow-hidden font-mono text-[9px] text-zinc-300 select-none backdrop-blur-md transition-all duration-300 p-3 text-left gap-3 w-[260px] z-[9998]"
          style={{
            right: isOpen && showSkillsDrawer ? (consolePosition ? 'auto' : '380px') : '-300px',
            left: consolePosition ? (isConsoleOnLeft ? `${consolePosition.x + consoleWidth + 10}px` : `${consolePosition.x - 270}px`) : 'auto',
            top: consolePosition ? `${consolePosition.y}px` : '0px',
            bottom: consolePosition ? 'auto' : '0px',
            height: consolePosition ? `${consoleHeight}px` : '100vh',
            width: '260px',
            pointerEvents: 'auto',
            borderLeft: '1px solid #1e1b4b',
            transition: 'right 250ms cubic-bezier(0.16, 1, 0.3, 1)'
          }}
        >
          <div className="flex items-center justify-between border-b border-indigo-950/70 pb-2 shrink-0">
            <div className="flex items-center gap-1.5">
              <Award className="w-4 h-4 text-indigo-400" />
              <span className="text-[10px] font-bold text-zinc-200 uppercase tracking-wide">Aimi Ledger</span>
            </div>
            <button 
              onClick={() => setShowSkillsDrawer(false)}
              className="p-1 hover:bg-zinc-800 rounded text-zinc-550 hover:text-white cursor-pointer"
              title="Close side panel"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* STATS BREAKDOWN SUMMARY */}
          <div className="bg-[#0b101c]/80 border border-indigo-950/60 p-2.5 rounded-xl space-y-1 text-[8.5px] uppercase shrink-0">
            <div className="flex justify-between">
              <span className="text-zinc-500">Core Status:</span>
              <span className="text-[#39ff14] font-bold animate-pulse">OPTIMIZED</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">Evolution Type:</span>
              <span className="text-indigo-400 font-bold">{getEvolutionStageName(currentLevel)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">Academy Average:</span>
              <span className="text-zinc-300 font-bold">
                {(aimiSkills.reduce((acc, curr) => acc + curr.level, 0) / aimiSkills.length).toFixed(1)} Lvl avg
              </span>
            </div>
          </div>

          {/* COMPACT SKILL SLOTS */}
          <div className="flex-1 overflow-y-auto space-y-2 scrollbar-thin">
            <span className="text-[7.5px] font-bold text-zinc-500 uppercase tracking-widest block mb-1">Ecosystem Masteries:</span>
            
            {aimiSkills.map((skill) => {
              const miniProg = Math.min(100, Math.max(0, (skill.xp / skill.maxXp) * 100));
              return (
                <div key={skill.id} className="bg-black/45 border border-zinc-900 p-2 rounded-lg space-y-1">
                  <div className="flex justify-between font-bold">
                    <span className="text-zinc-200">{skill.name}</span>
                    <span className="text-indigo-400">Lvl {skill.level}</span>
                  </div>
                  <div className="flex justify-between text-[7.5px] text-zinc-500 font-sans">
                    <span>EXP: {skill.xp} / {skill.maxXp}</span>
                    <span>{miniProg.toFixed(0)}%</span>
                  </div>
                  <div className="w-full bg-zinc-950 h-1 rounded overflow-hidden">
                    <div className="h-full bg-indigo-500" style={{ width: `${miniProg}%` }} />
                  </div>
                </div>
              );
            })}
          </div>

          <div className="p-2 border border-indigo-950/40 bg-indigo-950/10 rounded font-sans text-zinc-500 text-[8px] leading-normal shrink-0">
            Aimi will automatically unlock new visual components (glows, halo rings, and micro-antennas) as you level her up! Keep practicing!
          </div>
        </div>
      )}

      {/* 2. LEVEL UP DIGI-EVOLUTION SCREEN OVERLAY (Digimon anime tribute) */}
      {levelUpEvent && (
        <div className="fixed inset-0 bg-black/90 pointer-events-auto z-[99] flex flex-col items-center justify-center font-mono p-4 animate-fade-in">
          {/* Circular flashing radar aura */}
          <div className="relative w-44 h-44 rounded-full flex items-center justify-center border-4 border-[#00f3ff] animate-ping" style={{ animationDuration: '2.5s' }} />
          
          <div className="absolute flex flex-col items-center space-y-4 text-center">
            <span className="text-[10px] text-[#ff2a85] font-extrabold tracking-widest uppercase animate-bounce">⚡ NETWORK BIOMAC TRIGGERED ⚡</span>
            
            <h1 className="text-2xl font-black text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 via-[#ff2a85] to-[#39ff14] uppercase tracking-tighter filter drop-shadow-[0_0_15px_rgba(255,42,133,0.5)]">
              Aimi Evolving!
            </h1>
            
            <div className="w-24 h-24 p-0.5 rounded-full bg-gradient-to-tr from-amber-500 to-cyan-400 flex items-center justify-center animate-spin" style={{ animationDuration: '4s' }} />

            <div className="bg-black/60 border border-zinc-800 p-3 rounded-lg max-w-sm space-y-2">
              <span className="text-[#39ff14] text-xs font-bold font-mono">
                STAGE {levelUpEvent.from} ➔ STAGE {levelUpEvent.to}
              </span>
              <p className="text-gray-200 text-sm font-semibold uppercase font-sans animate-pulse">
                {levelUpEvent.msg}
              </p>
              <p className="text-[9px] text-zinc-500 leading-normal">
                Aimi-chan has digested enough multi-threading pipeline allocations and microkernel directives! Her logical CPU cores have evolved.
              </p>
            </div>

            <button
              onClick={() => setLevelUpEvent(null)}
              className="px-6 py-2 bg-gradient-to-r from-[#ff2a85] to-cyan-500 text-xs text-white font-extrabold rounded-full shadow-lg hover:brightness-110 active:scale-95 transition cursor-pointer"
            >
              ENGAGE SYSTEMS DIRECTIVE
            </button>
          </div>
        </div>
      )}

      {/* Draggable Mascot Avatar Character Container */}
      <div 
        id="aimi-desktop-mascot-container" 
        className="fixed z-50 pointer-events-none"
        style={{ 
          left: `${position.x}px`, 
          top: `${position.y}px`,
          transform: 'translate(-50%, -50%)',
          transition: isDragging ? 'none' : 'transform 200ms ease-out'
        }}
      >
        {/* 3. CHAT BUBBLE PREVIEW OUT OF APPARATUS (On drag/state update) */}
        {speechBubble && !isOpen && (
          <div 
            onClick={() => setIsOpen(true)}
            className="absolute bg-black/95 border border-[#00f0ff]/50 text-gray-200 text-[10px] p-2.5 rounded-xl shadow-[0_6px_22px_rgba(0,0,0,0.85)] font-sans leading-normal animate-fade-in z-40 cursor-pointer hover:border-[#39ff14] transition-colors pointer-events-auto select-none w-[220px]"
            style={{
              left: isAimiOnLeft ? '75px' : '-230px',
              top: '-50px'
            }}
          >
            <div className="flex gap-1.5 items-center text-[7.5px] font-mono text-[#00f0ff] font-bold uppercase tracking-wider mb-1">
              <Sparkles className="w-2.5 h-2.5 text-[#00f0ff] animate-spin" />
              <span>Aimi: Coprocessor Core</span>
            </div>
            <div>{speechBubble}</div>
            {/* Custom responsive tails */}
            <div className={`absolute w-2.5 h-2.5 bg-[#050505] border-r border-b border-[#00f0ff]/50 transform rotate-45 z-10 ${
              isAimiOnLeft ? '-left-1.5 top-11 border-l border-b border-t-0 border-r-0' : '-right-1.5 top-11'
            }`} />
          </div>
        )}

        {/* 4. SHINY MASCOT COMPANION AVATAR */}
        <div 
          onMouseDown={onDragStart}
          onTouchStart={onDragStart}
          onClick={(e) => {
            // Prevent opening if the user was actually dragging her!
            if (draggedDistance.current > 6) {
              draggedDistance.current = 0;
              return;
            }
            setIsOpen(!isOpen);
            setSpeechBubble(null);
            if (activeExpression === 'sitting') {
              setActiveExpression('happy');
            }
          }}
          title="Aimi Cybernetic AI Mascot. Click me to toggle console! DRAG to relocate."
          className={`flex items-center justify-center cursor-grab active:cursor-grabbing hover:scale-105 transition-transform duration-300 pointer-events-auto ${
            isDragging ? 'scale-110 rotate-3 z-50' : 'z-40'
          }`}
        >
          {renderAimiAvatarSVG()}
        </div>
      </div>
    </>
  );
}
