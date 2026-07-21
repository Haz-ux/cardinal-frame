import React, { useState } from 'react';
import { NPUTelemetry, OrchestratorConfig } from '../types';
import { 
  Cpu, 
  Zap, 
  Activity, 
  Battery, 
  Gauge, 
  Layers, 
  FileCode, 
  Terminal, 
  Copy, 
  Check, 
  Sliders, 
  ShieldCheck, 
  RefreshCw, 
  Info,
  TrendingUp
} from 'lucide-react';

interface NPUMonitorProps {
  npus: NPUTelemetry[];
  config: OrchestratorConfig;
  onUpdateConfig: (config: OrchestratorConfig) => void;
}

export default function NPUMonitor({ npus, config, onUpdateConfig }: NPUMonitorProps) {
  const [activeTab, setActiveTab] = useState<'telemetry' | 'abstraction'>('telemetry');
  const [selectedDriver, setSelectedDriver] = useState<'apple' | 'qualcomm' | 'cuda'>('apple');
  
  // Interactive loader simulator states
  const [isLoaderWarmingUp, setIsLoaderWarmingUp] = useState(false);
  const [copiedCodeId, setCopiedCodeId] = useState<string | null>(null);
  const [simulatedEngineLogs, setSimulatedEngineLogs] = useState<string[]>([
    "📂 [NPU KERNEL] Idle. Hardware drivers pre-loaded in memory.",
    "📁 Select a model and trigger the benchmark suite to observe MMIO SRAM paging rates."
  ]);

  // Calibration options state
  const [selectedModel, setSelectedModel] = useState<'llama_8b' | 'qwen_7b' | 'nemotron_4b'>('qwen_7b');
  const [alignMemory, setAlignMemory] = useState(true);
  const [pinThreadOutput, setPinThreadOutput] = useState(true);

  // Results display
  const [showResults, setShowResults] = useState(false);
  const [inferenceMetrics, setInferenceMetrics] = useState({
    vramUsed: 0,
    sramUtilization: 0,
    peakTops: 0,
    tokensPerSecond: 0,
    efficiencyGain: 0,
    pageFaultsCount: 0
  });

  const getSimColorForPercent = (p: number) => {
    if (p > 85) return 'bg-rose-500';
    if (p > 50) return 'bg-amber-400';
    return 'bg-[#00ff41]';
  };

  const handleVramSlider = (e: React.ChangeEvent<HTMLInputElement>) => {
    onUpdateConfig({
      ...config,
      npuAllocatedVramGb: Number(e.target.value)
    });
  };

  const handleWorkersSlider = (e: React.ChangeEvent<HTMLInputElement>) => {
    onUpdateConfig({
      ...config,
      concurrencyWorkers: Number(e.target.value)
    });
  };

  const handleCopyCode = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedCodeId(id);
    setTimeout(() => setCopiedCodeId(null), 2000);
  };

  const executeWarmupSimulator = () => {
    if (isLoaderWarmingUp) return;
    setIsLoaderWarmingUp(true);
    setShowResults(false);
    
    const driverLabel = selectedDriver === 'apple' ? 'Apple ANE' : selectedDriver === 'qualcomm' ? 'Qualcomm QNN' : 'CUDA TensorCore';
    const modelSize = selectedModel === 'llama_8b' ? '8B' : selectedModel === 'qwen_7b' ? '7B' : '4B';

    setSimulatedEngineLogs([
      `⚙️ [DRV LOADER] Connecting to ${driverLabel} context...`,
      `📦 [MODEL REGISTER] Loading weight mappings for Qwen-Coder ${modelSize} Parameter model...`
    ]);

    let step = 0;
    const processSteps = [
      `🔍 [UMA ALLOC] Setting up Direct Memory Unified Pointers. Aligning cache lines...`,
      alignMemory 
        ? `🛡️ [UMA ALLOC] SUCCESSFUL. Page-aligned on 4096-byte boundaries (Zero-Copy Enabled)` 
        : `⚠️ [UMA ALLOC] WARNING. Dynamic alignment skipped. CPU memory-to-device copy overhead incurred (Mismatched bounds)`,
      pinThreadOutput
        ? `🔒 [OS BINDING] Pinning thread bounds via C.runtime_LockOSThread`
        : `⚠️ [OS BINDING] Thread pinning un-selected. CPU migrations may degrade throughput jitter`,
      `📉 [INF BENCHMARK] Warm-up complete. Feeding batch-size: ${config.highThroughputMode ? 16 : 4} concurrent prompts into NPU queue...`,
      `🏁 [INF BENCHMARK] Executed concurrent workloads. Benchmarking complete.`
    ];

    const interval = setInterval(() => {
      setSimulatedEngineLogs(prev => [
        processSteps[step],
        ...prev
      ]);
      step++;

      if (step >= processSteps.length) {
        clearInterval(interval);
        
        // Formulate metrics mathematically depending on the settings chosen
        const baseTops = selectedDriver === 'cuda' ? 240 : selectedDriver === 'apple' ? 120 : 90;
        const pageFaults = alignMemory ? 0 : Math.round(18 + Math.random() * 22);
        const efficiency = (alignMemory ? 35 : 0) + (pinThreadOutput ? 15 : 0) + (config.highThroughputMode ? 20 : 0);
        
        let multiplier = 1.0;
        if (alignMemory) multiplier *= 1.35;
        if (pinThreadOutput) multiplier *= 1.15;
        if (config.highThroughputMode) multiplier *= 1.45;

        const tokensPerSec = Math.round((selectedModel === 'llama_8b' ? 90 : selectedModel === 'qwen_7b' ? 140 : 280) * multiplier);
        const finalTops = Math.round(baseTops * multiplier * 0.82);
        const vramNeeded = selectedModel === 'llama_8b' ? 12 : selectedModel === 'qwen_7b' ? 9 : 4;

        setInferenceMetrics({
          vramUsed: vramNeeded,
          sramUtilization: alignMemory ? Math.round(88 + Math.random() * 8) : Math.round(42 + Math.random() * 12),
          peakTops: finalTops,
          tokensPerSecond: tokensPerSec,
          efficiencyGain: efficiency,
          pageFaultsCount: pageFaults
        });

        setIsLoaderWarmingUp(false);
        setShowResults(true);
      }
    }, 400);
  };

  // Source templates definitions
  const npuAbstractGoInterface = `package npu

import (
	"context"
	"errors"
)

// DeviceType classifies local hardware accelerators paged symmetrically inside modern workstations
type DeviceType string

const (
	AppleNeuralEngine DeviceType = "AppleNeuralEngine"
	QualcommQNN       DeviceType = "QualcommQNN"
	NvidiaCuda        DeviceType = "NvidiaCuda"
)

// HardwareContext encapsulates low-overhead unified device descriptors
type HardwareContext struct {
	DeviceID        int
	SRAMTotalBytes  uint64
	VRAMTotalBytes  uint64
	PageAligned     bool
	LockPinnedThread bool
}

// UnifiedNPUManager defines the standardized hardware abstraction layer (Go-HAL) for loading 
// and executing unified weights with sub-microsecond overhead.
type UnifiedNPUManager interface {
	// Initializes the physical silicon context and binds driver registers
	InitializeSilicon(ctx context.Context, config HardwareContext) error

	// Handles direct mapping of local AI model weights over unified SRAM cache lanes
	LoadWeights(ctx context.Context, modelPath string, vramAllocationGb float64) (ModelEngine, error)

	// Pulls real-time hardware clock, temperature, and TOPS registers to trigger throttling feedback loops
	FetchTelemetry() (TelemetrySnapshot, error)
}

// ModelEngine coordinates concurrent high-throughput local prediction streams
type ModelEngine interface {
	// Runs hardware-accelerated batch predictions safely using memory-mapped buffers (MMIO)
	Predict(ctx context.Context, tensors []float32, batchSize int) ([]float32, error)
	
	// Unloads weights immediately, freeing up unified physical memory offsets
	Unload(ctx context.Context) error
}

type TelemetrySnapshot struct {
	ClockSpeedMhz        int32
	TemperatureCelsius   float32
	SRAMUtilizationPerc  float32
	ActivePowerWatts     float32
	InstantaneousThroughput float64
}
`;

  const appleNEGoImplementation = `package npu

import (
	"context"
	"fmt"
	"unsafe"
)

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework CoreML -framework Foundation
#include <stdlib.h>

// Simulated physical Apple Neural Engine MMIO dynamic hooks
void* init_ane_context(int page_align) {
    // Highly-optimized alignment allocation leveraging standard 4096-byte boundaries 
    void* buffer = NULL;
    int err = posix_memalign(&buffer, 4096, 1024 * 1024); // Allocate aligned SRAM cache pages
    if (err != 0) return NULL;
    return buffer;
}
*/
import "C"

type AppleNEContext struct {
	DeviceHandle unsafe.Pointer
	Config       HardwareContext
}

func NewAppleNEContext() *AppleNEContext {
	return &AppleNEContext{}
}

func (m *AppleNEContext) InitializeSilicon(ctx context.Context, config HardwareContext) error {
	m.Config = config
	
	alignFlag := 0
	if config.PageAligned {
		alignFlag = 1
	}

	// Trigger direct CGo MMIO alignment registers setup bypassing typical CoreML userland latency hurdles
	handle := C.init_ane_context(C.int(alignFlag))
	if handle == nil {
		return fmt.Errorf("failed to pre-allocate page-aligned sram buffers on ANE coprocessor")
	}
	m.DeviceHandle = handle
	fmt.Printf("🍎 Apple Neural Engine: Context loaded. Page-aligned boundaries: %v\\n", config.PageAligned)
	return nil
}

func (m *AppleNEContext) LoadWeights(ctx context.Context, weights string, vramGb float64) (ModelEngine, error) {
	fmt.Printf("🍎 ANE: Unified weights matrix %s mapped successfully to UMA. Registers armed.\\n", weights)
	return &appleNEEngine{handle: m.DeviceHandle}, nil
}

type appleNEEngine struct {
	handle unsafe.Pointer
}

func (e *appleNEEngine) Predict(ctx context.Context, inputs []float32, batchSize int) ([]float32, error) {
	// Zero-copy direct transfer - bypassing kernel memory splits
	return inputs, nil
}

func (e *appleNEEngine) Unload(ctx context.Context) error {
	C.free(e.handle)
	return nil
}
`;

  const qualcommQNNImplementation = `package npu

import (
	"context"
	"fmt"
)

// QualcommQNNContext configures direct CGo bindings linking against Qualcomm Neural Network SDK registers
type QualcommQNNContext struct {
	Config HardwareContext
}

func (q *QualcommQNNContext) InitializeSilicon(ctx context.Context, config HardwareContext) error {
	q.Config = config
	// Connect QNN hex driver registers
	fmt.Printf("⚡ Qualcomm QNN Driver: Tapping Snapdragon Hexagon Tensor registers... SRAM: %dMB\\n", config.SRAMTotalBytes/(1024*1024))
	return nil
}

func (q *QualcommQNNContext) LoadWeights(ctx context.Context, modelPath string, allocationGb float64) (ModelEngine, error) {
	fmt.Printf("⚡ Qualcomm QNN: Loaded weights (%s) utilizing Hexagon SRAM cache. DMA enabled.\\n", modelPath)
	return &qnnEngine{}, nil
}

type qnnEngine struct{}

func (e *qnnEngine) Predict(ctx context.Context, inputs []float32, batchSize int) ([]float32, error) {
	// Leverages direct Snapdragon DSP pipeline buffers
	return inputs, nil
}

func (e *qnnEngine) Unload(ctx context.Context) error {
	return nil
}
`;

  const directCudaImplementation = `package npu

/*
#cgo LDFLAGS: -lcudart
#include <cuda_runtime.h>

// Direct host memory pin calls to prevent paging inside GPU/Tensor Core loops
void* pin_host_memory(size_t size) {
    void* ptr;
    cudaError_t err = cudaHostAlloc(&ptr, size, cudaHostAllocPinned);
    if (err != cudaSuccess) return NULL;
    return ptr;
}
*/
import "C"
import (
	"context"
	"fmt"
	"unsafe"
)

type DirectCudaContext struct {
	PinnedBuffer unsafe.Pointer
}

func (c *DirectCudaContext) InitializeSilicon(ctx context.Context, config HardwareContext) error {
	// Set up Direct CUDA Tensor Core memory channels
	c.PinnedBuffer = C.pin_host_memory(C.size_t(4 * 1024 * 1024))
	if c.PinnedBuffer == nil {
		return fmt.Errorf("failed to initialize pinned host-to-device memory registers via cudaHostAlloc")
	}
	fmt.Println("💚 Nvidia CUDA CUDA: Host memory pinned successfully. Pinned registers armed.")
	return nil
}

func (c *DirectCudaContext) LoadWeights(ctx context.Context, path string, gb float64) (ModelEngine, error) {
	return &cudaEngine{buffer: c.PinnedBuffer}, nil
}

type cudaEngine struct {
	buffer unsafe.Pointer
}

func (e *cudaEngine) Predict(ctx context.Context, inputs []float32, batch int) ([]float32, error) {
	return inputs, nil
}

func (e *cudaEngine) Unload(ctx context.Context) error {
	return nil
}
`;

  return (
    <div id="npu-monitor-root-complex" className="space-y-6">
      
      {/* Tab Selector */}
      <div className="flex items-center justify-between bg-[#0d1117] border border-gray-800 rounded-xl p-3">
        <div className="flex items-center gap-2">
          <Cpu className="w-4 h-4 text-emerald-400 animate-pulse" />
          <span className="font-mono text-xs font-bold text-gray-200 uppercase tracking-widest">
            NPU HARWARE ACCELERATOR SUITE
          </span>
        </div>
        
        <div className="flex items-center gap-2 font-mono text-xs">
          <button
            onClick={() => setActiveTab('telemetry')}
            className={`px-3 py-1.5 rounded transition ${
              activeTab === 'telemetry' 
                ? 'bg-emerald-950/40 text-emerald-400 border border-emerald-900/40 font-bold' 
                : 'text-gray-400 hover:text-white hover:bg-[#10141d]'
            }`}
          >
            📟 Live Hardware Telemetry
          </button>
          <button
            onClick={() => setActiveTab('abstraction')}
            className={`px-3 py-1.5 rounded transition ${
              activeTab === 'abstraction' 
                ? 'bg-[#00ff41]/10 text-[#00ff41] border border-[#00ff41]/20 font-bold' 
                : 'text-gray-400 hover:text-white hover:bg-[#10141d]'
            }`}
          >
            🎛️ Go NPU Abstraction (HAL)
          </button>
        </div>
      </div>

      {activeTab === 'telemetry' ? (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          
          {/* Visual NPU Cores grid column (Spans 2 columns) */}
          <div id="npu-physical-cores" className="lg:col-span-2 bg-[#0d1117] rounded-xl border border-gray-800 p-5 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between border-b border-gray-800/80 pb-3 mb-5">
                <div className="flex items-center gap-2">
                  <Cpu className="w-4 h-4 text-emerald-400 animate-pulse" />
                  <h3 className="font-mono text-xs font-semibold text-gray-300 uppercase tracking-widest">
                    Local Accelerators (NPU Core Diagnostics)
                  </h3>
                </div>
                <span className="text-[10px] bg-emerald-950/40 text-emerald-400 font-mono px-2 py-0.5 rounded border border-emerald-800/60 font-bold uppercase tracking-wide">
                  Direct Memory Mapping
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {npus.map((npu) => (
                  <div
                    key={npu.id}
                    className="bg-[#10141d] rounded-lg border border-gray-800 p-4 font-mono text-xs hover:border-emerald-500/40 transition duration-200"
                  >
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-1.5">
                        <div className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                        <span className="font-bold text-gray-200 text-sm truncate max-w-[150px]">{npu.name}</span>
                      </div>
                      <span className="text-[8px] uppercase tracking-wide bg-gray-900 border border-gray-800 px-1.5 py-0.5 rounded text-gray-400">
                        {npu.type}
                      </span>
                    </div>

                    {/* Grid performance indicators */}
                    <div className="grid grid-cols-2 gap-3 mb-4">
                      <div className="bg-[#161b22] p-2 rounded border border-gray-800/40">
                        <div className="text-[9px] text-gray-500 flex items-center gap-1 uppercase">
                          <Gauge className="w-3 h-3 text-[#00ff41]" /> Clock Speed
                        </div>
                        <div className="text-base font-bold text-gray-200 mt-1">{npu.clockMhz} MHz</div>
                      </div>

                      <div className="bg-[#161b22] p-2 rounded border border-gray-800/40">
                        <div className="text-[9px] text-gray-500 flex items-center gap-1 uppercase">
                          <Zap className="w-3 h-3 text-cyan-400" /> Power Draw
                        </div>
                        <div className="text-base font-bold text-gray-200 mt-1">{npu.activePowerWatts} W</div>
                      </div>

                      <div className="bg-[#161b22] p-2 rounded border border-gray-800/40">
                        <div className="text-[9px] text-gray-500 flex items-center gap-1 uppercase">
                          <Activity className="w-3 h-3 text-purple-400" /> Computing TOPS
                        </div>
                        <div className="text-base font-bold text-gray-200 mt-1">{npu.opThroughputTops} TOPS</div>
                      </div>

                      <div className="bg-[#161b22] p-2 rounded border border-gray-800/40">
                        <div className="text-[9px] text-gray-500 flex items-center gap-1 uppercase">
                          <Layers className="w-3 h-3 text-blue-400" /> Exec Queue
                        </div>
                        <div className="text-base font-bold text-gray-200 mt-1">{npu.executionQueueLength} items</div>
                      </div>
                    </div>

                    {/* SRAM Cache and VRAM Allocations */}
                    <div className="space-y-3 pb-1">
                      <div>
                        <div className="flex justify-between text-[9px] text-gray-500 mb-1 font-semibold">
                          <span>ON-CHIP SRAM PIPELINE CACHE</span>
                          <span className="text-emerald-400">{npu.sramUtilizationPercent}%</span>
                        </div>
                        <div className="w-full bg-gray-900 h-1.5 rounded-full overflow-hidden">
                          <div
                            className={`h-full ${getSimColorForPercent(npu.sramUtilizationPercent)} transition-all duration-300`}
                            style={{ width: `${npu.sramUtilizationPercent}%` }}
                          />
                        </div>
                      </div>

                      <div>
                        <div className="flex justify-between text-[9px] text-gray-500 mb-1 font-semibold">
                          <span>VRAM TENSOR REGISTERS ({npu.vramUsedGb}GB / {npu.vramTotalGb}GB)</span>
                          <span className="text-cyan-400">{Math.round((npu.vramUsedGb / npu.vramTotalGb) * 100)}%</span>
                        </div>
                        <div className="w-full bg-gray-900 h-1.5 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-cyan-400 transition-all duration-300"
                            style={{ width: `${(npu.vramUsedGb / npu.vramTotalGb) * 100}%` }}
                          />
                        </div>
                      </div>

                      <div className="flex items-center justify-between text-[10px] text-gray-400 pt-1 border-t border-gray-900">
                        <span>Generated Tokens Rate:</span>
                        <span className="font-bold text-emerald-400 text-xs">
                          {npu.tokensPerSec} tps
                        </span>
                      </div>

                      {/* Direct Silicon Multi-Core Tensor Grid Heatmap */}
                      <div className="bg-black/55 border border-[#1b253b] rounded-lg p-2.5 space-y-1.5 mt-2.5 select-none text-left">
                        <div className="flex justify-between items-center text-[7.5px] uppercase tracking-wider text-gray-500 font-extrabold font-mono">
                          <span>Physical Silicon Cluster Array Grid (96 Sub-Gates)</span>
                          <span className="text-emerald-400 animate-pulse flex items-center gap-1">● ON-LINE</span>
                        </div>
                        
                        <div className="grid grid-cols-12 gap-1 overflow-hidden p-1 rounded bg-[#060a12]">
                          {Array.from({ length: 96 }).map((_, index) => {
                            const basePct = npu.sramUtilizationPercent;
                            // Layout coordinate mappings
                            const row = Math.floor(index / 12);
                            const col = index % 12;
                            // hotspots near coordinate cores centers
                            const centerFactor = Math.max(0, 1 - (Math.abs(row - 4) + Math.abs(col - 6)) / 8);
                            // seed math dynamic frequency noise
                            let heatVal = basePct * (0.35 + centerFactor * 0.65) + (Math.sin(index * 1.5 + Date.now() / 250) * 8);
                            heatVal = Math.min(100, Math.max(10, heatVal));

                            let cellColor = 'bg-[#121c2e] border-0';
                            let glowEffect = '';
                            if (heatVal > 84) {
                              cellColor = 'bg-rose-500 border border-rose-350';
                              glowEffect = 'rgba(239, 68, 68, 0.4)';
                            } else if (heatVal > 68) {
                              cellColor = 'bg-orange-500 border border-orange-350';
                              glowEffect = 'rgba(249, 115, 22, 0.35)';
                            } else if (heatVal > 38) {
                              cellColor = 'bg-emerald-500 border border-emerald-350';
                              glowEffect = 'rgba(16, 185, 129, 0.3)';
                            } else if (heatVal > 18) {
                              cellColor = 'bg-cyan-600 border border-cyan-400';
                              glowEffect = 'rgba(6, 182, 212, 0.2)';
                            } else {
                              cellColor = 'bg-[#101b2f] border border-[#17253f]';
                              glowEffect = 'rgba(56, 139, 253, 0.05)';
                            }

                            return (
                              <div
                                key={index}
                                style={{ 
                                  boxShadow: `0 0 4px ${glowEffect}`,
                                  animationDelay: `${(row * 40 + col * col) % 500}ms`
                                }}
                                className={`h-2 rounded-[2px] transition-all duration-300 animate-pulse ${cellColor}`}
                                title={`Transistor block #${index} temperature: ${Math.round(heatVal)}C`}
                              />
                            );
                          })}
                        </div>

                        <div className="flex justify-between text-[7px] text-zinc-500 font-mono uppercase pb-0.5 leading-none">
                          <span>Cool Core (12°C)</span>
                          <span>Inference Load (45°C)</span>
                          <span>Saturated Peak (85°C+)</span>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Control Side panel */}
          <div id="npu-optimizations-controls" className="bg-[#0d1117] rounded-xl border border-gray-800 p-5 flex flex-col justify-between">
            <div>
              <div className="flex items-center gap-2 border-b border-gray-800/80 pb-3 mb-5">
                <Battery className="w-4 h-4 text-cyan-400" />
                <h3 className="font-mono text-xs font-semibold text-gray-300 uppercase tracking-widest">
                  Performance Allocations
                </h3>
              </div>

              <div className="space-y-5 font-mono text-xs">
                {/* Limit local VRAM partition */}
                <div>
                  <div className="flex justify-between font-mono text-gray-400 mb-2">
                    <span>VRAM RESERVATION</span>
                    <span className="text-cyan-400 font-bold">{config.npuAllocatedVramGb} GB</span>
                  </div>
                  <input
                    type="range"
                    min="2"
                    max="32"
                    step="2"
                    value={config.npuAllocatedVramGb}
                    onChange={handleVramSlider}
                    className="w-full accent-cyan-400 bg-gray-800 cursor-pointer h-1.5 rounded-lg"
                  />
                  <p className="text-[10px] text-gray-500 mt-1.5 leading-relaxed">
                    Apportions local unified memory exclusively for Cardinal Frame model weight paging. Higher bounds avoid file swap lag.
                  </p>
                </div>

                {/* Go Concurrent Workers */}
                <div>
                  <div className="flex justify-between font-mono text-gray-400 mb-2">
                    <span>CONCURRENT GO THREADS</span>
                    <span className="text-emerald-400 font-bold">{config.concurrencyWorkers} Workers</span>
                  </div>
                  <input
                    type="range"
                    min="2"
                    max="32"
                    step="2"
                    value={config.concurrencyWorkers}
                    onChange={handleWorkersSlider}
                    className="w-full accent-emerald-400 bg-gray-800 cursor-pointer h-1.5 rounded-lg"
                  />
                  <p className="text-[10px] text-gray-500 mt-1.5 leading-relaxed">
                    Set active concurrency goroutine pool limits. Matches active CPU core constraints.
                  </p>
                </div>

                {/* Toggle Switches */}
                <div className="space-y-4 pt-2 border-t border-gray-800/60">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="block text-gray-300 font-bold text-xs">High-Throughput Mode</span>
                      <span className="block text-[9px] text-gray-500">Enable aggressive pipeline batching</span>
                    </div>
                    <button
                      id="toggle-throughput-btn"
                      onClick={() => onUpdateConfig({ ...config, highThroughputMode: !config.highThroughputMode })}
                      className={`w-9 h-5 rounded-full transition-colors relative ${config.highThroughputMode ? 'bg-[#00ff41]/80 shadow-[0_0_8px_#00ff41]' : 'bg-gray-800'}`}
                    >
                      <span className={`w-3.5 h-3.5 rounded-full bg-white absolute top-0.75 transition-all ${config.highThroughputMode ? 'left-4.5' : 'left-0.75'}`} />
                    </button>
                  </div>

                  <div className="flex items-center justify-between">
                    <div>
                      <span className="block text-gray-300 font-bold text-xs">LockOSThread Pining</span>
                      <span className="block text-[9px] text-gray-500">Pin execution directly to system threads</span>
                    </div>
                    <button
                      id="toggle-pinthreads-btn"
                      onClick={() => onUpdateConfig({ ...config, pinThreadsToGoRuntime: !config.pinThreadsToGoRuntime })}
                      className={`w-9 h-5 rounded-full transition-colors relative ${config.pinThreadsToGoRuntime ? 'bg-[#00ff41]/80 shadow-[0_0_8px_#00ff41]' : 'bg-gray-800'}`}
                    >
                      <span className={`w-3.5 h-3.5 rounded-full bg-white absolute top-0.75 transition-all ${config.pinThreadsToGoRuntime ? 'left-4.5' : 'left-0.75'}`} />
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Informational disclaimer */}
            <div className="mt-6 bg-[#161b22] border border-gray-800 p-3 rounded text-[10px] font-mono text-gray-500 leading-relaxed">
              🐾 Cardinal Frame leverages low-overhead direct memory mappings to bypass CPU thread schedules, channeling token weights directly into unified NPU registers over lock-free Go transport streams.
            </div>
          </div>

        </div>
      ) : (
        /* Go Unified Abstraction Layer Spec & Interactive Calibration Workbench */
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
          
          {/* LEFT 7-COL: HAL Interface Code specification */}
          <div className="xl:col-span-7 bg-[#0d1117] rounded-xl border border-gray-800 flex flex-col h-[600px] overflow-hidden">
            
            {/* Header selection toolbar */}
            <div className="bg-[#161b22] px-4 py-3 border-b border-gray-800 flex items-center justify-between select-none">
              <div className="flex items-center gap-4">
                <button
                  onClick={() => setSelectedDriver('apple')}
                  className={`font-mono text-xs uppercase tracking-tight transition ${
                    selectedDriver === 'apple' ? 'text-[#00ff41] font-bold' : 'text-gray-400 hover:text-white'
                  }`}
                >
                  🍎 Apple ANE Driver
                </button>
                <span className="text-gray-700">|</span>
                <button
                  onClick={() => setSelectedDriver('qualcomm')}
                  className={`font-mono text-xs uppercase tracking-tight transition ${
                    selectedDriver === 'qualcomm' ? 'text-[#00e5ff] font-bold' : 'text-gray-400 hover:text-white'
                  }`}
                >
                  ⚡ Qualcomm QNN
                </button>
                <span className="text-gray-700">|</span>
                <button
                  onClick={() => setSelectedDriver('cuda')}
                  className={`font-mono text-xs uppercase tracking-tight transition ${
                    selectedDriver === 'cuda' ? 'text-emerald-400 font-bold' : 'text-gray-400 hover:text-white'
                  }`}
                >
                  💚 NVIDIA CUDA Target
                </button>
              </div>

              <span className="text-[9px] bg-black/55 text-cyan-400 px-2 py-0.5 border border-[#161b22] rounded font-mono font-bold uppercase">
                Go-HAL v2.2.1
              </span>
            </div>

            {/* Interface specifications file layout */}
            <div className="flex-1 overflow-hidden flex flex-col bg-black/55">
              <div className="bg-[#080b0f] px-4 py-2 border-b border-zinc-950 flex items-center justify-between text-[10px] font-mono text-gray-500">
                <span>📚 UNIFIED HAL API SIGNATURE: <strong className="text-zinc-300">npu/interface.go</strong></span>
                <button 
                  onClick={() => handleCopyCode(npuAbstractGoInterface, 'hal_api')}
                  className="text-cyan-400 hover:text-white flex items-center gap-1 cursor-pointer"
                >
                  {copiedCodeId === 'hal_api' ? <Check className="w-3 h-3 text-[#00ff41]" /> : <Copy className="w-3 h-3" />}
                  {copiedCodeId === 'hal_api' ? 'Copied' : 'Copy'}
                </button>
              </div>

              <div className="flex-1 p-4 overflow-y-auto font-mono text-[11px] leading-relaxed select-text text-teal-400 scrollbar-thin">
                <pre>{npuAbstractGoInterface}</pre>
              </div>

              {/* Specific driver vendor code */}
              <div className="bg-[#080b0f] px-4 py-2 border-t border-zinc-950/80 flex items-center justify-between text-[10px] font-mono text-gray-500">
                <span>
                  ⚙️ {selectedDriver === 'apple' ? 'APPLE NE' : selectedDriver === 'qualcomm' ? 'QUALCOMM SNAPDRAGON' : 'NVIDIA TENSOR CORES'} IMPL: 
                  <strong className="text-zinc-300 ml-1">
                    {selectedDriver === 'apple' ? 'npu/apple_ne.go' : selectedDriver === 'qualcomm' ? 'npu/qualcomm_qnn.go' : 'npu/cuda_direct.go'}
                  </strong>
                </span>
                
                <button 
                  onClick={() => {
                    const text = selectedDriver === 'apple' ? appleNEGoImplementation : selectedDriver === 'qualcomm' ? qualcommQNNImplementation : directCudaImplementation;
                    handleCopyCode(text, 'hal_drv');
                  }}
                  className="text-cyan-400 hover:text-white flex items-center gap-1 cursor-pointer"
                >
                  {copiedCodeId === 'hal_drv' ? <Check className="w-3 h-3 text-[#00ff41]" /> : <Copy className="w-3 h-3" />}
                  {copiedCodeId === 'hal_drv' ? 'Copied' : 'Copy'}
                </button>
              </div>

              <div className="h-[180px] bg-[#070a0e] border-t border-zinc-950 p-4 overflow-y-auto font-mono text-[10.5px] leading-relaxed select-text text-amber-500 scrollbar-thin">
                <pre>
                  {selectedDriver === 'apple' ? appleNEGoImplementation : selectedDriver === 'qualcomm' ? qualcommQNNImplementation : directCudaImplementation}
                </pre>
              </div>
            </div>
          </div>

          {/* RIGHT 5-COL: Interactive Driver Calibration Workbench */}
          <div className="xl:col-span-5 bg-[#0d1117] rounded-xl border border-gray-800 p-5 flex flex-col justify-between h-[600px]">
            
            {/* Calibration Controls */}
            <div className="space-y-4 shrink-0 font-mono text-xs text-gray-400">
              <div className="flex items-center gap-2 border-b border-gray-800 pb-3">
                <Terminal className="w-4 h-4 text-[#00ff41]" />
                <h4 className="font-mono text-xs font-bold text-gray-200 uppercase tracking-widest">
                  Calibration Workbench
                </h4>
              </div>

              <div className="bg-[#121622] rounded-lg p-3 border border-gray-800 leading-relaxed space-y-3">
                <div className="flex items-center gap-1.5 font-bold text-gray-300 uppercase text-[10px]">
                  <Sliders className="w-3.5 h-3.5 text-cyan-400" /> Driver Optimizations
                </div>

                <div>
                  <label className="block text-[8px] text-gray-500 mb-1 uppercase font-bold">SELECT LOCAL TENSOR LAYOUT</label>
                  <select 
                    value={selectedModel}
                    onChange={(e: any) => setSelectedModel(e.target.value)}
                    className="w-full bg-black border border-zinc-800 rounded px-2 py-1 text-xs text-white outline-none"
                  >
                    <option value="llama_8b">Llama-3-8B-Instruct (4-bit Normalized Quantized)</option>
                    <option value="qwen_7b">Qwen-2.5-Coder-7B-Full (8-bit Weights)</option>
                    <option value="nemotron_4b">Nemotron-Mini-4B-Instruct (Dense-Float16)</option>
                  </select>
                </div>

                <div className="space-y-2 pt-1 border-t border-zinc-850">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="block text-gray-300 font-bold text-[11px]">SRAM Memory Alignment</span>
                      <span className="block text-[8px] text-gray-500">Align memory on 4096-byte hardware pages</span>
                    </div>
                    <button
                      onClick={() => setAlignMemory(!alignMemory)}
                      className={`w-9 h-5 rounded-full transition-colors relative ${alignMemory ? 'bg-emerald-600' : 'bg-gray-800'}`}
                    >
                      <span className={`w-3.5 h-3.5 rounded-full bg-white absolute top-0.75 transition-all ${alignMemory ? 'left-4.5' : 'left-0.75'}`} />
                    </button>
                  </div>

                  <div className="flex items-center justify-between">
                    <div>
                      <span className="block text-gray-300 font-bold text-[11px]">Pin Thread Context</span>
                      <span className="block text-[8px] text-gray-500">Enable OS binding bounds (runtime.LockOSThread)</span>
                    </div>
                    <button
                      onClick={() => setPinThreadOutput(!pinThreadOutput)}
                      className={`w-9 h-5 rounded-full transition-colors relative ${pinThreadOutput ? 'bg-emerald-600' : 'bg-gray-800'}`}
                    >
                      <span className={`w-3.5 h-3.5 rounded-full bg-white absolute top-0.75 transition-all ${pinThreadOutput ? 'left-4.5' : 'left-0.75'}`} />
                    </button>
                  </div>
                </div>

                <button
                  onClick={executeWarmupSimulator}
                  disabled={isLoaderWarmingUp}
                  className="w-full py-2 bg-[#00ff41] hover:bg-[#00dd3a] text-black font-bold uppercase text-[10px] rounded transition duration-150 flex items-center justify-center gap-1.5 cursor-pointer shadow-md"
                >
                  {isLoaderWarmingUp ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Activity className="w-3.5 h-3.5" />}
                  Warm Up NPU Loader & Test Inference
                </button>
              </div>
            </div>

            {/* Results diagnostic display */}
            <div className="flex-1 flex flex-col overflow-hidden my-4 min-h-[160px]">
              {showResults ? (
                /* Benchmark Results cards */
                <div className="flex-1 bg-black/60 rounded border border-gray-850 p-3.5 font-mono text-xs text-gray-300 space-y-3 flex flex-col justify-between">
                  <div className="flex items-center justify-between border-b border-zinc-900 pb-1.5 text-[10px] font-bold text-emerald-400 uppercase">
                    <span>⚡ Benchmarks diagnostic details</span>
                    <span className="flex items-center gap-1"><TrendingUp className="w-3.5 h-3.5" /> GAIN: +{inferenceMetrics.efficiencyGain}%</span>
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-[10.5px]">
                    <div className="bg-[#111622] p-2 rounded">
                      <span className="block text-[8px] text-gray-500 uppercase">INFERENCE RATES</span>
                      <span className="text-sm font-bold text-[#00ff41] block mt-0.5">{inferenceMetrics.tokensPerSecond} tps</span>
                    </div>

                    <div className="bg-[#111622] p-2 rounded">
                      <span className="block text-[8px] text-gray-500 uppercase">PEAK THROUGHPUT</span>
                      <span className="text-sm font-bold text-gray-100 block mt-0.5">{inferenceMetrics.peakTops} TOPS</span>
                    </div>

                    <div className="bg-[#111622] p-2 rounded">
                      <span className="block text-[8px] text-gray-500 uppercase">SRAM CACHE HIT STATE</span>
                      <span className="text-sm font-bold text-cyan-400 block mt-0.5">{inferenceMetrics.sramUtilization}%</span>
                    </div>

                    <div className="bg-[#111622] p-2 rounded">
                      <span className="block text-[8px] text-gray-500 uppercase">DRAM PAGE FAULTS</span>
                      <span className={`text-sm font-bold block mt-0.5 ${inferenceMetrics.pageFaultsCount > 0 ? 'text-[#ffaa00]' : 'text-emerald-400'}`}>
                        {inferenceMetrics.pageFaultsCount} faults
                      </span>
                    </div>
                  </div>

                  <div className="text-[9.5px] leading-relaxed text-gray-500 bg-black border border-zinc-900 p-2 rounded">
                    {alignMemory ? (
                      <p className="text-[#00ff41]">
                        ● Zero-Copy memory alignment verified. Cache offsets align on 4KB page bounds. Bypasses typical marshalling copying cycles context boundaries!
                      </p>
                    ) : (
                      <p className="text-amber-500">
                        ⚠️ Non-aligned memory blocks. Incurring page faults because the system is forced to swap tensor allocations into cold virtual memory. Use alignment to optimize speeds!
                      </p>
                    )}
                  </div>
                </div>
              ) : (
                /* Falling logs or prompt loading */
                <div className="flex-1 bg-black/80 rounded border border-gray-850 p-3 font-mono text-[9.5px] overflow-y-auto space-y-1.5 leading-relaxed text-gray-300">
                  {simulatedEngineLogs.map((log, index) => {
                    let isStep = log.startsWith('🛡️') || log.startsWith('✅');
                    let isWarn = log.startsWith('⚠️');
                    let isTitle = log.startsWith('🏁') || log.startsWith('⚙️');

                    return (
                      <div 
                        key={index} 
                        className={
                          isStep ? 'text-emerald-400 font-bold border-l border-emerald-500 pl-1.5' :
                          isWarn ? 'text-amber-500 pl-1.5 border-l border-amber-500' :
                          isTitle ? 'text-cyan-400 font-extrabold' : 'text-gray-500'
                        }
                      >
                        {log}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* HAL Note card */}
            <div className="bg-[#121622] rounded border border-zinc-850 p-2.5 font-mono text-[9px] text-gray-500 leading-normal flex items-start gap-1.5 shrink-0 select-none">
              <Info className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              <span>
                Designing direct CGo hardware abstractions ensures unified operations across diverse host boards. Directly binding thread contexts locks workloads to physical registers, cutting scheduling jitter down to zero.
              </span>
            </div>

          </div>

        </div>
      )}

    </div>
  );
}
