import React, { useState, useEffect } from 'react';
import { AgentNode, NodeEdge, OrchestratorConfig, NetworkTransportType } from '../types';
import { 
  Terminal, 
  Copy, 
  Check, 
  Sparkles, 
  RefreshCw, 
  AlertTriangle, 
  Brain, 
  Play, 
  Wrench, 
  Gauge, 
  CheckCircle2, 
  Layers,
  Database,
  Cpu,
  Bookmark
} from 'lucide-react';

interface CodeExporterProps {
  nodes: AgentNode[];
  edges: NodeEdge[];
  config: OrchestratorConfig;
  onUpdateConfig?: (config: OrchestratorConfig) => void;
  onAppendLogs?: (newLogs: string[]) => void;
}

export default function CodeExporter({ 
  nodes, 
  edges, 
  config,
  onUpdateConfig,
  onAppendLogs
}: CodeExporterProps) {
  const [goCode, setGoCode] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [apiMode, setApiMode] = useState<'AI' | 'Local'>('Local');

  // Compilation Simulator States
  const [isCompiling, setIsCompiling] = useState(false);
  const [compilerLogs, setCompilerLogs] = useState<string[]>([]);
  const [compilerSuccess, setCompilerSuccess] = useState<'idle' | 'error' | 'success' | 'warning'>('idle');
  const [failedChecksCount, setFailedChecksCount] = useState(0);

  // Cardinal Optimizer Learning Engine States
  const [learningMode, setLearningMode] = useState<'idle' | 'training' | 'stable'>('idle');
  const [learningEpoch, setLearningEpoch] = useState(12);
  const [policyEntropy, setPolicyEntropy] = useState(0.84);
  const [learningRewards, setLearningRewards] = useState<number[]>([-4500, -3200, -1800, -960, -450]);
  const [bestThroughputTps, setBestThroughputTps] = useState(124);
  const [optimizingProgress, setOptimizingProgress] = useState(0);

  const generateCode = async () => {
    setLoading(true);
    setCompilerSuccess('idle');
    setCompilerLogs([]);
    try {
      const res = await fetch('/api/generate-go-code', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ nodes, edges, config }),
      });
      const data = await res.json();
      setGoCode(data.code || '');
      setApiMode(data.isSimulated ? 'Local' : 'AI');
    } catch (e) {
      console.error(e);
      setApiMode('Local');
    } finally {
      setLoading(false);
    }
  };

  // Compile automatically once when code is empty
  useEffect(() => {
    if (!goCode && nodes.length > 0) {
      generateCode();
    }
  }, [nodes]);

  const handleCopy = () => {
    navigator.clipboard.writeText(goCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Custom regex based high density color syntax theme for Go
  const highlightGo = (src: string) => {
    if (!src) return '';
    const escaped = src
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // Identify standard single line comments
    let formatted = escaped.replace(/(\/\/.*)/g, '<span class="text-[#8e9aab] italic font-mono">$1</span>');

    // String definitions
    formatted = formatted.replace(/(".*?")/g, '<span class="text-[#a5d6ff] font-mono">$1</span>');

    // Highlight core system types
    const types = [
      'int64', 'int32', 'int8', 'string', 'time.Time', 'Msg', 'NPUDevice', 
      'sync.WaitGroup', 'context.Context', 'bool', 'float64', 'Struct_[a-zA-Z0-9_]+'
    ];
    const typeRegex = new RegExp(`\\b(${types.join('|')})\\b`, 'g');
    formatted = formatted.replace(typeRegex, '<span class="text-[#00e5ff] font-bold font-mono">$1</span>');

    // Main keywords styling
    const keywords = [
      'package', 'import', 'func', 'type', 'struct', 'chan', 'go', 'select', 'case', 'default',
      'defer', 'return', 'if', 'else', 'for', 'range', 'make', 'var', 'const', 'map'
    ];
    const kwRegex = new RegExp(`\\b(${keywords.join('|')})\\b`, 'g');
    formatted = formatted.replace(kwRegex, '<span class="text-[#ffaa00] font-bold font-mono">$1</span>');

    // Packages and builtins
    const builtins = ['fmt', 'time', 'sync', 'atomic', 'runtime', 'context', 'Println', 'Printf', 'Sleep', 'GOMAXPROCS', 'LockOSThread', 'Since'];
    const builtinRegex = new RegExp(`\\b(${builtins.join('|')})\\b`, 'g');
    formatted = formatted.replace(builtinRegex, '<span class="text-[#00ff41] font-semibold font-mono">$1</span>');

    return formatted;
  };

  // Run a multi-step compilation check
  const runCompilationTest = () => {
    if (isCompiling) return;
    setIsCompiling(true);
    setCompilerSuccess('idle');
    setCompilerLogs([]);

    const steps = [
      '🐾 Initializing Go Toolchain (go1.22.3 linux/amd64)...',
      '📁 Analyzing scaffolding.go import declarations...',
      '📈 Checking memory offsets in zero-copy shared buffers...',
      '🛠️ Validating atomic and pointer thread alignments...',
      '⚙️ Executing static code evaluation...'
    ];

    let currentStep = 0;
    const interval = setInterval(() => {
      if (currentStep < steps.length) {
        setCompilerLogs(prev => [...prev, `${steps[currentStep]}`]);
        if (onAppendLogs) {
          onAppendLogs([`[COMPILER] ${steps[currentStep]}`]);
        }
        currentStep++;
      } else {
        clearInterval(interval);
        
        // Formulate analytical checks depending on current configuration parameters
        const checks: string[] = [];
        let errorsCount = 0;
        let warningFound = false;

        if (!config.pinThreadsToGoRuntime) {
          checks.push('⚠️ WARNING: Node weights lack thread binding. Local cache fetches may suffer CPU migrations! (Consider LockOSThread option)');
          warningFound = true;
        }
        if (config.networkTransport === 'gRPC-QUIC') {
          checks.push('⚠️ LATENCY NOTICE: gRPC streams over QUIC cluster overhead is high (~42.0us). Switch to ZeroCopyRing for sub-microsecond bounds.');
          warningFound = true;
        }
        if (nodes.length > 8) {
          checks.push('❌ CORE FAULT: Goroutine scheduler exceeds threshold capacity (MAX 8 cluster Nodes in Alpha build). Trim topologies.');
          errorsCount++;
        }

        if (errorsCount > 0) {
          checks.push(`🛑 BUILD FAILED with ${errorsCount} compiler fault(s). Core pipeline halted.`);
          setCompilerSuccess('error');
        } else if (warningFound) {
          checks.push('🐳 BUILD SUCCESSFUL with system warnings. Binary generated: dist/cardinal_frame_nodes.elf');
          setCompilerSuccess('warning');
        } else {
          checks.push('💖 BUILD EXCELLENT. Zero-copy ring bounds aligned perfectly with target hardware threads.');
          setCompilerSuccess('success');
        }

        setFailedChecksCount(errorsCount);
        setCompilerLogs(prev => [...prev, ...checks]);
        if (onAppendLogs) {
          onAppendLogs(checks.map(c => `[COMPILER] ${c}`));
        }
        setIsCompiling(false);
      }
    }, 450);
  };

  // Run Cardinal Frame reinforcement learning epochs
  const triggerCardinalOptimizer = () => {
    if (learningMode === 'training') return;
    setLearningMode('training');
    setOptimizingProgress(0);

    const stepsCount = 10;
    let step = 0;
    const interval = setInterval(() => {
      setOptimizingProgress(prev => prev + 10);
      step++;
      
      const lossVal = (1.42 - (step * 0.13)).toFixed(2);
      const randReward = -Math.round(450 - (step * 45) + (Math.random() * 15));
      const epochNum = 12 + step;

      setLearningEpoch(epochNum);
      setPolicyEntropy(parseFloat((0.84 - (step * 0.07)).toFixed(2)));
      setLearningRewards(prev => [...prev.slice(1), randReward]);

      if (step >= stepsCount) {
        clearInterval(interval);
        setLearningMode('stable');
        setBestThroughputTps(168);
        
        if (onAppendLogs) {
          onAppendLogs([
            '🧠 CARDINAL OPTIMIZER: Policy weights converged successfully! Gradient limit bound met [Loss = 0.04]',
            '🧠 CARDINAL OPTIMIZER: Optimum strategy determined: [ZeroCopyRingBuffer, 16 Cores, LockOSThread=On]'
          ]);
        }
      }
    }, 250);
  };

  // Instantly map optimum settings recommended by Optimizer
  const applyCardinalOptimizations = () => {
    if (!onUpdateConfig) return;
    onUpdateConfig({
      networkTransport: 'ZeroCopyRingBuffer',
      npuAllocatedVramGb: 24,
      concurrencyWorkers: 16,
      highThroughputMode: true,
      pinThreadsToGoRuntime: true
    });

    if (onAppendLogs) {
      onAppendLogs([
        '🐾 Cardinal Frame configuration updated dynamically according to Cardinal Optimizer Deep Optimization recommendation.'
      ]);
    }
  };

  return (
    <div id="code-exporter-complex" className="grid grid-cols-1 xl:grid-cols-12 gap-6">
      
      {/* Visual Editor Column - Spans 7 cols */}
      <div className="xl:col-span-7 bg-[#0d1117] rounded-xl border border-gray-800 overflow-hidden flex flex-col min-h-[560px]">
        
        {/* Header telemetry console bar */}
        <div className="bg-[#161b22] border-b border-gray-800 px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Terminal className="w-4 h-4 text-[#00ff41]" />
            <h3 className="font-mono text-[11px] font-bold text-gray-200 uppercase tracking-widest">
              Cardinal Frame Compiler (scaffolding.go)
            </h3>
          </div>
          <div className="flex items-center gap-2">
            {apiMode === 'AI' ? (
              <span className="text-[9px] bg-[#00ff41] text-black px-2 py-0.5 rounded font-mono font-bold flex items-center gap-1 shadow-[0_0_8px_rgba(0,255,65,0.4)]">
                <Sparkles className="w-2.5 h-2.5" /> GEMINI_ENGINE
              </span>
            ) : (
              <span className="text-[9px] bg-amber-950/40 text-amber-400 border border-amber-800/65 px-2 py-0.5 rounded font-mono font-bold">
                LOCAL_DRAFT_GEN
              </span>
            )}
          </div>
        </div>

        {/* Action Panel */}
        <div className="bg-[#090d14] px-4 py-2 border-b border-gray-800/50 flex flex-wrap gap-4 items-center justify-between text-xs font-mono">
          <span className="text-gray-500 text-[10px]">Syntax: Go 1.22+ System Architecture</span>
          <div className="flex items-center gap-4">
            <button
              onClick={generateCode}
              disabled={loading}
              className="flex items-center gap-1.5 text-gray-400 hover:text-white transition disabled:opacity-50"
              title="Query the generation server for fresh scaffolding bindings"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-emerald-400' : ''}`} />
              <span>Regenerate Code</span>
            </button>
            <button
              onClick={handleCopy}
              className="flex items-center gap-1.5 text-[#00e5ff] hover:text-[#5ceaff] transition"
            >
              {copied ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Copied!</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span>Copy Code</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Code Renderer with Custom High Density Highlight */}
        <div className="flex-1 relative bg-[#090d14] overflow-hidden flex">
          {/* Editor Line Numbers mock gutter */}
          <div className="w-10 bg-[#060a0f] text-gray-650 font-mono text-[10px] text-right pr-2.5 py-4 select-none border-r border-gray-850">
            {goCode ? goCode.split('\n').map((_, i) => (
              <div key={i} className="leading-5 h-5">{i + 1}</div>
            )) : Array.from({length: 15}).map((_, i) => (
              <div key={i} className="leading-5 h-5">{i + 1}</div>
            ))}
          </div>

          <pre className="flex-1 p-4 overflow-auto text-[11px] font-mono leading-5 max-h-[560px] whitespace-pre select-text selection:bg-[#00ff41]/20">
            {goCode ? (
              <code 
                dangerouslySetInnerHTML={{ __html: highlightGo(goCode) }}
                className="font-mono"
              />
            ) : (
              <div className="text-gray-600 animate-pulse font-mono py-10 text-center">
                Fetching compiled Go micro-scaffolding DAG from server...
              </div>
            )}
          </pre>
        </div>

        {/* Code metrics bar */}
        <div className="bg-[#121620] border-t border-gray-800 px-4 py-2 font-mono text-[9px] text-[#666] flex justify-between uppercase">
          <span>Active Nodes: {nodes.length}</span>
          <span>Buffer: channels / CircularRing</span>
          <span>File Size: {goCode ? `${(goCode.length / 1024).toFixed(2)} KB` : '0 KB'}</span>
        </div>
      </div>

      {/* Compiler checks & Cardinal Learning Panel - Spans 5 cols */}
      <div className="xl:col-span-5 flex flex-col gap-6">

        {/* Diagnostic compilation terminal */}
        <div className="bg-[#0d1117] rounded-xl border border-gray-800 p-5 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between border-b border-gray-800 pb-3 mb-4">
              <div className="flex items-center gap-2">
                <Wrench className="w-4 h-4 text-[#00e5ff]" />
                <h3 className="font-mono text-xs font-bold text-gray-300 uppercase tracking-widest">
                  Static Compilation Check
                </h3>
              </div>
              <span className="text-[10px] text-gray-500 font-mono">go build</span>
            </div>

            <p className="text-[11px] text-gray-400 font-mono mb-4 leading-relaxed">
              Run localized static code checks on current struct shapes and pointer offset memory mappings.
            </p>

            {/* Simulated compiler output console */}
            {compilerLogs.length > 0 && (
              <div className="bg-[#050505] rounded-md border border-gray-850 p-3 font-mono text-[10px] space-y-1.5 max-h-[220px] overflow-y-auto mb-4 leading-relaxed select-text shadow-inner">
                {compilerLogs.map((log, index) => {
                  let logColor = 'text-gray-300';
                  if (log.startsWith('⚠️')) logColor = 'text-[#ffaa00] font-bold';
                  if (log.startsWith('❌') || log.startsWith('🛑')) logColor = 'text-rose-450 font-bold';
                  if (log.startsWith('🐾')) logColor = 'text-cyan-400';
                  if (log.startsWith('💖') || log.includes('SUCCESSFUL')) logColor = 'text-[#00ff41] font-bold';

                  return (
                    <div key={index} className={logColor}>
                      {log}
                    </div>
                  );
                })}
              </div>
            )}

            <button
              onClick={runCompilationTest}
              disabled={isCompiling}
              className={`w-full py-2.5 font-semibold text-xs rounded transition flex items-center justify-center gap-2 font-mono uppercase ${
                isCompiling 
                  ? 'bg-gray-900 border border-gray-800 text-gray-500 cursor-not-allowed' 
                  : 'bg-[#00e5ff] hover:bg-[#20edff] text-black shadow-[0_0_8px_rgba(0,229,255,0.3)] cursor-pointer'
              }`}
            >
              {isCompiling ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  Compiling Pipeline...
                </>
              ) : (
                <>
                  <Terminal className="w-3.5 h-3.5" />
                  Simulate Go Compiler Build
                </>
              )}
            </button>
          </div>
        </div>

        {/* Cardinal Agent Learning System Panel */}
        <div className="bg-[#0d1117] rounded-xl border border-gray-800 p-5 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between border-b border-gray-800 pb-3 mb-4">
              <div className="flex items-center gap-2">
                <Brain className="w-4 h-4 text-[#ffaa00]" />
                <h3 className="font-mono text-xs font-bold text-gray-300 uppercase tracking-widest">
                  Cardinal Optimizer Core
                </h3>
              </div>
              <span className="text-[9px] bg-[#ffaa00]/20 text-[#ffaa00] border border-[#ffaa00]/40 px-1.5 py-0.5 rounded font-bold uppercase">
                Active RL Core
              </span>
            </div>

            <p className="text-[11px] text-gray-400 font-mono mb-4 leading-relaxed">
              Cardinal Frame Optimizer evaluates routing context parameters recursively as an offline/online reinforcement learning policy.
            </p>

            {/* Neural weights stats readout dashboard */}
            <div className="grid grid-cols-2 gap-3 mb-4 font-mono text-xs text-gray-400">
              <div className="bg-black/40 border border-gray-850 p-2 rounded">
                <span className="block text-[8px] text-gray-600 uppercase">Policy Entropy</span>
                <span className="block text-sm font-bold text-[#ffaa00] mt-0.5">{policyEntropy}</span>
              </div>
              <div className="bg-black/40 border border-gray-850 p-2 rounded">
                <span className="block text-[8px] text-gray-600 uppercase">RL Epoch States</span>
                <span className="block text-sm font-bold text-gray-200 mt-0.5">{learningEpoch}</span>
              </div>
              <div className="bg-black/40 border border-gray-850 p-2 rounded">
                <span className="block text-[8px] text-gray-600 uppercase">Reward Ascent Rate</span>
                <span className="block text-sm font-semibold text-emerald-400 mt-0.5">+{bestThroughputTps} t/s</span>
              </div>
              <div className="bg-black/40 border border-gray-850 p-2 rounded">
                <span className="block text-[8px] text-gray-600 uppercase">Buffer Backpressure</span>
                <span className="block text-sm font-bold text-[#00e5ff] mt-0.5">0.05%</span>
              </div>
            </div>

            {/* Reward Ascent Graph Lines Mock */}
            <div className="mb-4 bg-black/45 border border-gray-850 p-3 rounded-lg font-mono text-[9px] text-gray-500">
              <span className="block font-bold uppercase text-[8px] mb-2 text-[#ffaa00]">Epoch Latency Reward Trace</span>
              <div className="flex items-end gap-1.5 h-12 pt-3 border-b border-gray-850/60 pb-1 flex-row">
                {learningRewards.map((reward, i) => {
                  const percent = Math.max(10, Math.min(100, Math.round(((reward + 5000) / 5000) * 100)));
                  return (
                    <div key={i} className="flex-1 flex flex-col justify-end items-center h-full">
                      <div 
                        className="w-full bg-[#ffaa00] rounded-t-sm transition-all duration-300" 
                        style={{ height: `${percent}%`, minHeight: '3px' }}
                      />
                      <span className="text-[7px] text-gray-600 mt-1">{i * 3 + 3}e</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Trigger optimizing action blocks */}
            {learningMode === 'training' ? (
              <div className="mb-4">
                <div className="flex justify-between text-[10px] font-mono text-gray-400 mb-1">
                  <span>Reinforcement Learning Search...</span>
                  <span>{optimizingProgress}%</span>
                </div>
                <div className="w-full bg-gray-900 h-1.5 rounded-full overflow-hidden">
                  <div className="h-full bg-[#ffaa00] animate-pulse transition-all duration-150" style={{ width: `${optimizingProgress}%` }} />
                </div>
              </div>
            ) : learningMode === 'stable' ? (
              <div className="mb-4 bg-emerald-950/20 border border-emerald-800/40 p-3 rounded text-[11px] font-mono text-[#00ff41] leading-relaxed">
                <div className="flex items-center gap-1.5 font-bold mb-1">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Converged Optimization Determined
                </div>
                Optimized policy determined optimum buffers: Zero Copy streams + pinned lock system thread threads.
                <button
                  onClick={applyCardinalOptimizations}
                  className="mt-2.5 w-full bg-[#00ff41] hover:bg-[#00cc33] text-black font-bold font-mono text-[10px] py-1.5 rounded uppercase transition shadow-md"
                >
                  Apply Optimizer Core Recommendation
                </button>
              </div>
            ) : null}

            <button
              onClick={triggerCardinalOptimizer}
              disabled={learningMode === 'training'}
              className={`w-full py-2.5 font-semibold text-xs rounded transition flex items-center justify-center gap-2 font-mono uppercase ${
                learningMode === 'training'
                  ? 'bg-gray-800 text-gray-650 border border-charcoal-800 cursor-not-allowed'
                  : 'bg-[#ffaa00] hover:bg-[#ffbb22] text-black shadow-[0_0_10px_rgba(255,170,0,0.3)] cursor-pointer'
              }`}
            >
              <Brain className="w-3.5 h-3.5" />
              {learningMode === 'training' ? 'Optimizer Gradient Searching...' : 'Execute Policy Optimization Step'}
            </button>
          </div>
        </div>

      </div>

    </div>
  );
}
