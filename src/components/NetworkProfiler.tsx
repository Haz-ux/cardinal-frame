import React, { useState, useEffect } from 'react';
import { NetworkTransportType } from '../types';
import { 
  Activity, 
  Radio, 
  Clock, 
  ShieldCheck, 
  Zap, 
  FileCode, 
  FileJson, 
  Terminal, 
  Send, 
  Play, 
  Copy, 
  Check, 
  AlertTriangle, 
  Sliders, 
  Info,
  RefreshCw,
  Cpu
} from 'lucide-react';

interface NetworkProfilerProps {
  currentTransport: NetworkTransportType;
  onChangeTransport: (transport: NetworkTransportType) => void;
}

export default function NetworkProfiler({ currentTransport, onChangeTransport }: NetworkProfilerProps) {
  const [activeSubTab, setActiveSubTab] = useState<'benchmarks' | 'protocols'>('benchmarks');
  const [protocolType, setProtocolType] = useState<'grpc' | 'websockets'>('grpc');
  
  // Interactive console sandbox states
  const [copiedCodeId, setCopiedCodeId] = useState<string | null>(null);
  const [selectedRpc, setSelectedRpc] = useState<'RegisterAgent' | 'StreamTelemetry' | 'DispatchSubtask'>('RegisterAgent');
  const [rpcStatusMode, setRpcStatusMode] = useState<'healthy' | 'timeout' | 'auth_error'>('healthy');
  const [isConsoleProcessing, setIsConsoleProcessing] = useState(false);
  const [consoleLogs, setConsoleLogs] = useState<string[]>([
    "🤖 CORE PROTOCOL ENGINE INITIALIZED // COMPILATION STABLE",
    "📡 Ready for outbound RPC call dispatch or websocket multiplex subscriber triggers."
  ]);

  // WebSocket Live streams mockup
  const [isWsStreaming, setIsWsStreaming] = useState(false);
  const [wsFrameCount, setWsFrameCount] = useState(0);

  // Auto stream logs for WebSockets simulation
  useEffect(() => {
    if (!isWsStreaming) return;
    
    const interval = setInterval(() => {
      setWsFrameCount(prev => prev + 1);
      const events = [
        `{ "event_type": "METRICS_HEARTBEAT", "sequence_id": ${200 + wsFrameCount}, "timestamp_utc": "${new Date().toISOString()}", "sender_node_id": "ToolExecutor_01", "telemetry": { "execution_latency_ns": 2420, "sram_cache_miss_count": 0 } }`,
        `{ "event_type": "BACKPRESSURE_THROTTLE", "sequence_id": ${201 + wsFrameCount}, "timestamp_utc": "${new Date().toISOString()}", "sender_node_id": "LocalInference_TaskA", "telemetry": { "execution_latency_ns": 182900, "sram_cache_miss_count": 4 } }`,
        `{ "event_type": "CONTROL_ACK", "sequence_id": ${202 + wsFrameCount}, "timestamp_utc": "${new Date().toISOString()}", "sender_node_id": "Orchestrator_Core", "telemetry": { "execution_latency_ns": 450, "sram_cache_miss_count": 0 } }`
      ];
      
      const nextLog = events[Math.floor(Math.random() * events.length)];
      setConsoleLogs(prev => [
        `🌐 [WS FRAME INbound] Size: ${nextLog.length} bytes | MTU Sync | Status: OK`,
        nextLog,
        ...prev.slice(0, 16)
      ]);
    }, 1200);

    return () => clearInterval(interval);
  }, [isWsStreaming, wsFrameCount]);

  const handleCopyCode = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedCodeId(id);
    setTimeout(() => setCopiedCodeId(null), 2000);
  };

  const handleDispatchRpc = () => {
    if (isConsoleProcessing) return;
    setIsConsoleProcessing(true);
    
    // Setup logs
    setConsoleLogs(prev => [
      `⚡ [gRPC CALL OUTBOUND] Invoking RPC: /goclaw.protocol.v1.OrchestratorService/${selectedRpc}`,
      prev[0],
      ...prev.slice(1, 10)
    ]);

    setTimeout(() => {
      let resultText = "";
      if (rpcStatusMode === 'healthy') {
        if (selectedRpc === 'RegisterAgent') {
          resultText = `✅ [gRPC RESPONSE INBOUND] Code: 0 (OK) | Net Overhead: 120ns | Bytes: 78B\n{\n  "registration_status": "ACCEPTED",\n  "assigned_cluster_id": "goclaw-node-east-4a",\n  "allocated_vram_bytes": 4294967296\n}`;
        } else if (selectedRpc === 'StreamTelemetry') {
          resultText = `✅ [gRPC RESPONSE INBOUND] Code: 0 (OK) | Channel Pinned | Stream Created\n{\n  "acknowledged_frames": 1,\n  "next_telemetry_window_ns": 5000000\n}`;
        } else {
          resultText = `✅ [gRPC RESPONSE INBOUND] Code: 0 (OK) | Thread execution: Pinned\n{\n  "status": "COMPLETED",\n  "throughput_tokens_per_sec": 845,\n  "raw_hardware_ TOPS": 160\n}`;
        }
      } else if (rpcStatusMode === 'timeout') {
        resultText = `❌ [gRPC ERROR] Code: 4 (DEADLINE_EXCEEDED) | Timeout bounds exceeded (Threshold: 50us)\n{\n  "error_reason": "Context deadline reached while paging weights into NPU unified cache registers",\n  "recovery_action": "Retry with thread LockOSThread enabled to prevent core context swaps"\n}`;
      } else {
        resultText = `❌ [gRPC ERROR] Code: 16 (UNAUTHENTICATED) | Missing or Expired Security Handshake token\n{\n  "error_reason": "Invalid neural session handshake keys. Connection rejected.",\n  "recovery_action": "Check .env configuration and check signature bounds."\n}`;
      }

      setConsoleLogs(prev => [
        resultText,
        ...prev
      ]);
      setIsConsoleProcessing(false);
    }, 400);
  };

  const clearConsoleLogs = () => {
    setConsoleLogs([
      "🧹 Console logs buffer cleared.",
      "📡 Active listener waiting for protocol streams..."
    ]);
    setWsFrameCount(0);
  };

  const protoCode = `syntax = "proto3";

package goclaw.protocol.v1;

// OrchestratorService coordinates standardized agent network synchronization over gRPC-QUIC streams
service OrchestratorService {
  // Registers a newly queued agent node into the operational orchestrator topological matrix
  rpc RegisterAgent(RegisterAgentRequest) returns (RegisterAgentResponse);
  
  // High-frequency backpressure feedback. Establishes a server-side telemetry socket link
  rpc StreamInferenceTelemetry(stream TelemetryFrame) returns (TelemetryAck);
  
  // Issues dynamic work items safely to a dedicated tool executor node
  rpc DispatchSubtask(SubtaskPayload) returns (SubtaskResult);
}

message RegisterAgentRequest {
  string agent_id = 1;
  string node_type = 2; // e.g., TaskPlanner, ToolExecutor
  int32 concurrency_limit = 3;
  string hardware_signature = 4; // e.g., Apple_NE, Snapdragon_NPU, Cuda_X
}

message RegisterAgentResponse {
  enum Status {
    STATUS_UNSPECIFIED = 0;
    ACCEPTED = 1;
    THROTTLED = 2;
    REJECTED_MEMORY_PRESSURE = 3;
  }
  Status registration_status = 1;
  string assigned_cluster_id = 2;
  int64 allocated_vram_bytes = 3;
}

message TelemetryFrame {
  string node_id = 1;
  uint64 current_sram_util_bytes = 2;
  uint32 active_concurrency_threads = 3;
  double instantaneous_throughput_tps = 4;
}

message TelemetryAck {
  bool acknowledged = 1;
  uint64 adjust_concurrency_workers = 2;
}

message SubtaskPayload {
  string task_uuid = 1;
  string prompt = 2;
  int32 batch_size = 3;
  bytes weights_overrides = 4;
}

message SubtaskResult {
  string status = 1; // COMPLETED, FAILED, TIMEOUT
  string output_tokens = 2;
  int32 error_code = 3;
}`;

  const grpcGoServerCode = `package main

import (
	"context"
	"fmt"
	"net"
	"sync"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	pb "goclaw/protocol/v1"
)

// OrchestratorServer implements the standardized pb.OrchestratorServiceServer
type OrchestratorServer struct {
	pb.UnimplementedOrchestratorServiceServer
	mu          sync.RWMutex
	activeNodes map[string]*pb.RegisterAgentRequest
}

func NewOrchestratorServer() *OrchestratorServer {
	return &OrchestratorServer{
		activeNodes: make(map[string]*pb.RegisterAgentRequest),
	}
}

// RegisterAgent acts as a standardized low-latency registration interceptor 
func (s *OrchestratorServer) RegisterAgent(ctx context.Context, req *pb.RegisterAgentRequest) (*pb.RegisterAgentResponse, error) {
	if req.AgentId == "" {
		return nil, status.Errorf(codes.InvalidArgument, "invalid request: missing Agent ID")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	s.activeNodes[req.AgentId] = req
	fmt.Printf("🐾 gRPC Orchestrator: Registered node %s with processor bound to %s\\n", req.AgentId, req.HardwareSignature)

	return &pb.RegisterAgentResponse{
		RegistrationStatus: pb.RegisterAgentResponse_ACCEPTED,
		AssignedClusterId:  "goclaw-node-east-4a",
		AllocatedVramBytes: 1024 * 1024 * 1024 * 4, // 4GB Unified VRAM Allocation
	}, nil
}

// StreamInferenceTelemetry handles bi-directional performance stream boundaries in real-time
func (s *OrchestratorServer) StreamInferenceTelemetry(stream pb.OrchestratorService_StreamInferenceTelemetryServer) error {
	for {
		frame, err := stream.Recv()
		if err != nil {
			return err
		}
		// Dynamic backpressure throttling logic simulated
		if frame.InstantaneousThroughputTps > 650 {
			errStream := stream.SendAndClose(&pb.TelemetryAck{
				Acknowledged:             true,
				AdjustConcurrencyWorkers: 8, // Force downscale to prevent throttle thermal cascades
			})
			return errStream
		}
	}
}
`;

  const websocketJsonSchema = `{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "AgentEventFrame",
  "description": "Standardized real-time event packet layout transmitted over WebSockets broker channels",
  "type": "object",
  "required": ["event_type", "sequence_id", "timestamp_utc", "sender_node_id", "telemetry"],
  "properties": {
    "event_type": {
      "type": "string",
      "enum": ["METRICS_HEARTBEAT", "BACKPRESSURE_THROTTLE", "ERROR_CRITICAL", "CONTROL_ACK"]
    },
    "sequence_id": {
      "type": "integer",
      "minimum": 0
    },
    "timestamp_utc": {
      "type": "string",
      "format": "date-time"
    },
    "sender_node_id": {
      "type": "string"
    },
    "telemetry": {
      "type": "object",
      "required": ["execution_latency_ns", "sram_cache_miss_count"],
      "properties": {
        "execution_latency_ns": {
          "type": "integer",
          "description": "Transit time in nanoseconds"
        },
        "sram_cache_miss_count": {
          "type": "integer",
          "description": "Cache-line misses inside on-disk accelerator local registers"
        }
      }
    }
  }
}`;

  const websocketBrokerCode = `package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
	"github.com/gorilla/websocket"
)

// EventFrame defines the system structure of real-time server multiplex events
type EventFrame struct {
	EventType    string    \`json:"event_type"\`
	SequenceID   int64     \`json:"sequence_id"\`
	TimestampUTC time.Time \`json:"timestamp_utc"\`
	SenderNodeID string    \`json:"sender_node_id"\`
	Telemetry    Telemetry \`json:"telemetry"\`
}

type Telemetry struct {
	ExecutionLatencyNS int64 \`json:"execution_latency_ns"\`
	SRAMCacheMissCount int   \`json:"sram_cache_miss_count"\`
}

// WebsocketBroker handles active WebSocket connection clusters beautifully
type WebsocketBroker struct {
	upgrader websocket.Upgrader
	mu       sync.RWMutex
	conns    map[*websocket.Conn]bool
}

func NewWebsocketBroker() *WebsocketBroker {
	return &WebsocketBroker{
		upgrader: websocket.Upgrader{
			ReadBufferSize:  2048,
			WriteBufferSize: 2048,
			CheckOrigin: func(r *http.Request) bool { return true },
		},
		conns: make(map[*websocket.Conn]bool),
	}
}

// ServeHTTP multiplexes new incoming subscriber links safely
func (b *WebsocketBroker) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	conn, err := b.upgrader.Upgrade(w, r, nil)
	if err != nil {
		http.Error(w, "Broker upgrade failed", http.StatusInternalServerError)
		return
	}
	defer conn.Close()

	b.mu.Lock()
	b.conns[conn] = true
	b.mu.Unlock()

	defer func() {
		b.mu.Lock()
		delete(b.conns, conn)
		b.mu.Unlock()
	}()

	// Event loop listening for local pipeline metrics broadcasts
	for {
		_, _, err := conn.ReadMessage()
		if err != nil {
			break // Connection closed or socket timeout
		}
	}
}

func (b *WebsocketBroker) BroadcastEvent(event EventFrame) {
	b.mu.RLock()
	defer b.mu.RUnlock()

	payload, _ := json.Marshal(event)
	for conn := range b.conns {
		_ = conn.WriteMessage(websocket.TextMessage, payload)
	}
}
`;

  // Custom benchmark metrics for display
  const benchmarkMatrix = [
    {
      type: 'ZeroCopyRingBuffer' as NetworkTransportType,
      label: 'Zero-Copy Ring Buffer',
      meanLatency: '180 ns',
      throughput: '12.4M msg/s',
      description: 'Pre-allocated concurrent circular queue utilizing sync/atomic pointers. Zero GC overhead, direct NPU paging.',
      efficiency: 99,
      barWidth: '15%'
    },
    {
      type: 'SharedMemorySHM' as NetworkTransportType,
      label: 'Direct SharedMemory (SHM)',
      meanLatency: '850 ns',
      throughput: '4.8M msg/s',
      description: 'Host-to-NPU page alignment bypassing Linux CFS scheduler. Ideal for heavy tensor allocations.',
      efficiency: 91,
      barWidth: '35%'
    },
    {
      type: 'GoChannels' as NetworkTransportType,
      label: 'Go Buffered Channels',
      meanLatency: '2.4 μs',
      throughput: '1.2M msg/s',
      description: 'Native lock-free Go channels with configurable buffers. Safe concurrency model with minimal scheduling.',
      efficiency: 78,
      barWidth: '55%'
    },
    {
      type: 'gRPC-QUIC' as NetworkTransportType,
      label: 'gRPC stream over QUIC',
      meanLatency: '42.0 μs',
      throughput: '85K msg/s',
      description: 'HTTP/3 QUIC connection clusters for distributed multi-machine node graphs. Encrypted but higher frame latency.',
      efficiency: 42,
      barWidth: '95%'
    }
  ];

  const activeMatrix = benchmarkMatrix.find(b => b.type === currentTransport) || benchmarkMatrix[2];

  return (
    <div id="network-profiler-root" className="space-y-6">
      
      {/* Top Tab Bar Switching between benchmarking and documentation protocols */}
      <div className="flex items-center justify-between bg-[#0d1117] border border-gray-800 rounded-xl p-3">
        <div className="flex items-center gap-2">
          <Radio className="w-4 h-4 text-cyan-400 animate-pulse" />
          <span className="font-mono text-xs font-bold text-gray-200 uppercase tracking-widest">
            OPERATIONAL TRANSPORT INTERACTION CONSOLE
          </span>
        </div>
        
        <div className="flex items-center gap-2 font-mono text-xs">
          <button
            onClick={() => setActiveSubTab('benchmarks')}
            className={`px-3 py-1.5 rounded transition ${
              activeSubTab === 'benchmarks' 
                ? 'bg-cyan-950/40 text-cyan-400 border border-cyan-850 font-bold' 
                : 'text-gray-400 hover:text-white hover:bg-[#10141d]'
            }`}
          >
            📊 Performance Benchmarks
          </button>
          <button
            onClick={() => setActiveSubTab('protocols')}
            className={`px-3 py-1.5 rounded transition ${
              activeSubTab === 'protocols' 
                ? 'bg-[#00ff41]/10 text-[#00ff41] border border-[#00ff41]/20 font-bold' 
                : 'text-gray-400 hover:text-white hover:bg-[#10141d]'
            }`}
          >
            🥽 Standardized Protocols Spec
          </button>
        </div>
      </div>

      {activeSubTab === 'benchmarks' ? (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          
          {/* Comparative chart card (Spans 2 cols) */}
          <div id="transport-latency-charts" className="lg:col-span-2 bg-[#0d1117] rounded-xl border border-gray-800 p-5 font-mono text-xs">
            <div className="flex items-center justify-between border-b border-gray-800/80 pb-3 mb-5">
              <div className="flex items-center gap-2">
                <Clock className="w-4 h-4 text-cyan-400" />
                <h3 className="font-semibold text-gray-300 uppercase tracking-widest text-[11px]">
                  Microsecond transport benchmarking
                </h3>
              </div>
              <span className="text-[10px] text-gray-400">Mean Frame Transit Time (Shorter is Better)</span>
            </div>

            {/* Latency diagram bars */}
            <div className="space-y-4">
              {benchmarkMatrix.map((item) => {
                const isActive = item.type === currentTransport;
                return (
                  <div
                    key={item.type}
                    onClick={() => onChangeTransport(item.type)}
                    className={`p-3 rounded-lg border cursor-pointer transition duration-150 ${
                      isActive 
                        ? 'bg-[#101520] border-cyan-500/70 shadow-lg' 
                        : 'bg-black/35 border-gray-900 hover:border-gray-800'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="flex items-center gap-2">
                        <span className={`w-1.5 h-1.5 rounded-full ${isActive ? 'bg-cyan-400 animate-pulse' : 'bg-gray-600'}`} />
                        <span className={`font-bold ${isActive ? 'text-cyan-400' : 'text-gray-300'}`}>{item.label}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-gray-400">Throughput: <strong className="text-gray-200">{item.throughput}</strong></span>
                        <span className="font-mono text-xs font-bold text-gray-100 bg-gray-900 border border-gray-850 px-2 py-0.5 rounded">
                          {item.meanLatency}
                        </span>
                      </div>
                    </div>

                    {/* Sizing comparative bar */}
                    <div className="relative w-full bg-gray-900 h-2.5 rounded-full overflow-hidden mt-2">
                      <div
                        className={`h-full transition-all duration-300 ${isActive ? 'bg-gradient-to-r from-cyan-500 to-emerald-400' : 'bg-gray-700'}`}
                        style={{ width: item.barWidth }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Profile Metrics Summary Card */}
          <div id="transport-active-summary" className="bg-[#0d1117] rounded-xl border border-gray-800 p-5 flex flex-col justify-between">
            <div>
              <div className="flex items-center gap-2 border-b border-gray-800/80 pb-3 mb-4">
                <Radio className="w-4 h-4 text-cyan-400" />
                <h3 className="font-mono text-xs font-semibold text-gray-300 uppercase tracking-widest">
                  Active Stream Engine
                </h3>
              </div>

              <div className="space-y-4 font-mono text-xs">
                <div className="bg-[#10141d] border border-gray-800 p-3.5 rounded-lg">
                  <span className="block text-[9px] text-gray-500 uppercase font-semibold">SELECTED TRANSPORT PROTOCOL</span>
                  <span className="block text-sm font-bold text-cyan-400 mt-1 uppercase font-indigo-600">{activeMatrix.label}</span>
                  <p className="text-[10px] text-gray-400 mt-2.5 leading-relaxed">
                    {activeMatrix.description}
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-3 pt-1">
                  <div className="bg-[#161b22] border border-gray-850 p-2.5 rounded">
                    <span className="block text-[8px] text-gray-500 uppercase">Latency Overhead</span>
                    <span className="block text-xs font-bold text-gray-200 mt-0.5">{activeMatrix.meanLatency}</span>
                  </div>
                  <div className="bg-[#161b22] border border-gray-850 p-2.5 rounded">
                    <span className="block text-[8px] text-gray-500 uppercase">Transfer efficiency</span>
                    <span className="block text-xs font-bold text-emerald-400 mt-0.5">{activeMatrix.efficiency}%</span>
                  </div>
                </div>
              </div>
            </div>

            {/* System architecture brief */}
            <div className="mt-5 bg-[#161b22] border border-gray-800 p-3 rounded text-[10px] font-mono text-gray-500/90 leading-relaxed">
              <div className="flex items-center gap-1.5 font-bold text-gray-400 mb-1">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" /> Security Check Clear
              </div>
              System memory pointers are verified alignment-ready over boundaries. Bypasses kernel frame copying completely, maintaining zero backpressure pipeline blocks!
            </div>
          </div>

        </div>
      ) : (
        /* Standardized protocol documentation and sandbox interactive environment */
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
          
          {/* LEFT 7-COL: Specification Explorer & Code Viewer */}
          <div className="xl:col-span-7 bg-[#0d1117] rounded-xl border border-gray-800 flex flex-col h-[580px] overflow-hidden">
            
            {/* Spec subheader toggles */}
            <div className="bg-[#161b22] px-4 py-3 border-b border-gray-800 flex items-center justify-between select-none">
              <div className="flex items-center gap-4">
                <button
                  onClick={() => setProtocolType('grpc')}
                  className={`flex items-center gap-1.5 font-mono text-xs uppercase tracking-tight transition ${
                    protocolType === 'grpc' ? 'text-[#00ff41] font-bold' : 'text-gray-400 hover:text-white'
                  }`}
                >
                  <Cpu className="w-3.5 h-3.5" /> gRPC Service Contract
                </button>
                <span className="text-gray-700">|</span>
                <button
                  onClick={() => setProtocolType('websockets')}
                  className={`flex items-center gap-1.5 font-mono text-xs uppercase tracking-tight transition ${
                    protocolType === 'websockets' ? 'text-amber-400 font-bold' : 'text-gray-400 hover:text-white'
                  }`}
                >
                  <FileJson className="w-3.5 h-3.5" /> WebSockets JSON Schema
                </button>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-[9px] bg-black/45 text-cyan-400 px-2 py-0.5 border border-zinc-850 rounded font-mono font-bold uppercase">
                  Protocols IDL v1.2
                </span>
              </div>
            </div>

            {/* Spec dual-pane files navigator */}
            <div className="flex-1 overflow-hidden flex flex-col bg-[#07090e]">
              {protocolType === 'grpc' ? (
                /* gRPC Spec Viewer */
                <div className="flex-1 flex flex-col overflow-hidden">
                  <div className="bg-black/40 px-4 py-2 border-b border-zinc-950 flex items-center justify-between text-[10px] font-mono text-gray-500">
                    <span>📚 SCHEMA DEFINITIONS FILE: <strong className="text-zinc-300">gClawService.proto</strong></span>
                    <button 
                      onClick={() => handleCopyCode(protoCode, 'proto')}
                      className="text-cyan-400 hover:text-white flex items-center gap-1 cursor-pointer"
                    >
                      {copiedCodeId === 'proto' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                      {copiedCodeId === 'proto' ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  
                  <div className="flex-1 p-4 overflow-y-auto font-mono text-[11px] leading-relaxed select-text text-gray-350 scrollbar-thin">
                    <pre className="whitespace-pre select-text text-teal-400 font-medium">
                      {protoCode}
                    </pre>
                  </div>

                  <div className="bg-black/60 px-4 py-2 border-t border-zinc-950/80 flex items-center justify-between text-[10px] font-mono text-gray-500">
                    <span>⚙️ IMPLEMENTATION SPEC: <strong className="text-zinc-300">server_grpc.go</strong></span>
                    <button 
                      onClick={() => handleCopyCode(grpcGoServerCode, 'go_server')}
                      className="text-cyan-400 hover:text-white flex items-center gap-1 cursor-pointer"
                    >
                      {copiedCodeId === 'go_server' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                      {copiedCodeId === 'go_server' ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  
                  <div className="h-[150px] bg-[#0c0f16] border-t border-zinc-950 p-4 overflow-y-auto font-mono text-[10.5px] leading-relaxed select-text text-gray-350 scrollbar-thin">
                    <pre className="whitespace-pre select-text text-amber-500 font-medium">
                      {grpcGoServerCode}
                    </pre>
                  </div>
                </div>
              ) : (
                /* WebSockets Spec Viewer */
                <div className="flex-1 flex flex-col overflow-hidden">
                  <div className="bg-black/40 px-4 py-2 border-b border-zinc-950 flex items-center justify-between text-[10px] font-mono text-gray-500">
                    <span>📚 JSON EVENT FRAME SCHEMA: <strong className="text-zinc-300">agent_events.schema.json</strong></span>
                    <button 
                      onClick={() => handleCopyCode(websocketJsonSchema, 'ws_schema')}
                      className="text-cyan-400 hover:text-white flex items-center gap-1 cursor-pointer"
                    >
                      {copiedCodeId === 'ws_schema' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                      {copiedCodeId === 'ws_schema' ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  
                  <div className="flex-1 p-4 overflow-y-auto font-mono text-[11px] leading-relaxed select-text text-gray-350 scrollbar-thin">
                    <pre className="whitespace-pre select-text text-cyan-400 font-medium">
                      {websocketJsonSchema}
                    </pre>
                  </div>

                  <div className="bg-black/60 px-4 py-2 border-t border-zinc-950/80 flex items-center justify-between text-[10px] font-mono text-gray-500">
                    <span>⚙️ WS EVENT ROUTER SKELETON: <strong className="text-zinc-300">broker_ws.go</strong></span>
                    <button 
                      onClick={() => handleCopyCode(websocketBrokerCode, 'ws_broker')}
                      className="text-cyan-400 hover:text-white flex items-center gap-1 cursor-pointer"
                    >
                      {copiedCodeId === 'ws_broker' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                      {copiedCodeId === 'ws_broker' ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  
                  <div className="h-[150px] bg-[#0c0f16] border-t border-zinc-950 p-4 overflow-y-auto font-mono text-[10.5px] leading-relaxed select-text text-gray-350 scrollbar-thin">
                    <pre className="whitespace-pre select-text text-emerald-400 font-medium">
                      {websocketBrokerCode}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* RIGHT 5-COL: Interactive Playground Console */}
          <div className="xl:col-span-5 bg-[#0d1117] rounded-xl border border-gray-800 p-5 flex flex-col justify-between h-[580px]">
            
            {/* Top Interactive Configuration Controls */}
            <div className="space-y-4 shrink-0">
              <div className="flex items-center gap-2 border-b border-gray-800 pb-3">
                <Terminal className="w-4 h-4 text-[#00ff41]" />
                <h4 className="font-mono text-xs font-bold text-gray-200 uppercase tracking-widest">
                  Live Testing Console Sandbox
                </h4>
              </div>

              <div className="bg-[#121622] rounded-lg p-3 border border-gray-800 font-mono text-[11px] leading-relaxed text-gray-400">
                <div className="flex items-center gap-1.5 font-bold text-gray-300 mb-2 uppercase text-[10px]">
                  <Sliders className="w-3.5 h-3.5 text-[#00e5ff]" /> Config Request Headers
                </div>
                
                {protocolType === 'grpc' ? (
                  /* gRPC Controls */
                  <div className="space-y-3">
                    <div>
                      <label className="block text-[8px] text-gray-500 mb-1 uppercase font-bold">TARGET RPC INTERFACE</label>
                      <select 
                        value={selectedRpc}
                        onChange={(e: any) => setSelectedRpc(e.target.value)}
                        className="w-full bg-black border border-zinc-800 rounded px-2 py-1 text-xs text-white outline-none"
                      >
                        <option value="RegisterAgent">rpc RegisterAgent(RegisterAgentRequest)</option>
                        <option value="StreamTelemetry">rpc StreamInferenceTelemetry(stream TelemetryFrame)</option>
                        <option value="DispatchSubtask">rpc DispatchSubtask(SubtaskPayload)</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-[8px] text-gray-500 mb-1 uppercase font-bold">SIMULATED EXCEPTION RESPONSE</label>
                      <div className="grid grid-cols-3 gap-1.5">
                        <button
                          onClick={() => setRpcStatusMode('healthy')}
                          className={`py-1 text-[9px] border rounded ${
                            rpcStatusMode === 'healthy' 
                              ? 'bg-emerald-950/40 text-[#00ff41] border-[#00ff41]/40 font-bold' 
                              : 'bg-black border-zinc-800 hover:border-zinc-700 text-gray-400'
                          }`}
                        >
                          Healthy (OK)
                        </button>
                        <button
                          onClick={() => setRpcStatusMode('timeout')}
                          className={`py-1 text-[9px] border rounded ${
                            rpcStatusMode === 'timeout' 
                              ? 'bg-amber-950/40 text-amber-500 border-amber-800/40 font-bold' 
                              : 'bg-black border-zinc-800 hover:border-zinc-700 text-gray-400'
                          }`}
                        >
                          Timeout (Code 4)
                        </button>
                        <button
                          onClick={() => setRpcStatusMode('auth_error')}
                          className={`py-1 text-[9px] border rounded ${
                            rpcStatusMode === 'auth_error' 
                              ? 'bg-rose-950/40 text-rose-500 border-rose-800/40 font-bold' 
                              : 'bg-black border-zinc-800 hover:border-zinc-700 text-gray-400'
                          }`}
                        >
                          Auth (Code 16)
                        </button>
                      </div>
                    </div>

                    <button
                      onClick={handleDispatchRpc}
                      disabled={isConsoleProcessing}
                      className="w-full py-2 bg-[#00ff41] hover:bg-[#00dd3a] text-black font-bold uppercase text-[10px] rounded transition duration-150 flex items-center justify-center gap-1.5 cursor-pointer shadow-md"
                    >
                      {isConsoleProcessing ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                      Dispatch Standard RPC call
                    </button>
                  </div>
                ) : (
                  /* WebSockets Controls */
                  <div className="space-y-4">
                    <p className="text-[10px] leading-relaxed text-gray-400">
                      WebSocket multiplex listeners stream decentralized runtime events recursively from each active NPU thread context.
                    </p>

                    <div className="flex items-center justify-between bg-black/40 border border-zinc-850 p-2.5 rounded">
                      <div>
                        <span className="block text-[9px] font-bold text-gray-200 font-mono">BROADCAST LISTENER</span>
                        <span className="text-[8px] text-gray-500 font-mono">ws://localhost:3000/api/v1/broadcast</span>
                      </div>
                      
                      <button
                        onClick={() => setIsWsStreaming(!isWsStreaming)}
                        className={`px-3 py-1.5 rounded font-mono text-[9px] uppercase font-bold tracking-wider transition ${
                          isWsStreaming 
                            ? 'bg-rose-950/40 text-rose-500 border border-rose-900/60' 
                            : 'bg-emerald-950/40 text-emerald-400 border border-emerald-900/60'
                        }`}
                      >
                        {isWsStreaming ? "⏹️ Close ws Stream" : "▶️ Connect Stream"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Simulated Live Logging Frame Monitor */}
            <div className="flex-1 flex flex-col overflow-hidden my-4 min-h-[220px]">
              <div className="flex items-center justify-between pb-1.5 px-1 font-mono text-[9px] text-gray-500 uppercase select-none">
                <span>Console Logs Frame Output</span>
                <button 
                  onClick={clearConsoleLogs}
                  className="hover:text-white transition cursor-pointer"
                >
                  [Flush console]
                </button>
              </div>

              <div className="flex-1 bg-black/80 rounded border border-gray-850 p-3 font-mono text-[10px] overflow-y-auto space-y-1.5 leading-relaxed text-gray-300 scrollbar-thin">
                {consoleLogs.map((log, index) => {
                  let isError = log.includes('❌') || log.includes('[gRPC ERROR]');
                  let isSuccess = log.includes('✅') || log.includes('OK');
                  let isHeader = log.includes('🔊') || log.includes('[WS FRAME') || log.includes('[gRPC CALL');
                  let isSecondary = log.startsWith('{') || log.startsWith('  "');

                  return (
                    <div 
                      key={index}
                      className={`break-all whitespace-pre-wrap ${
                        isError ? 'text-rose-400 font-bold border-l-2 border-rose-500 pl-1 py-0.5 bg-rose-950/10' :
                        isSuccess ? 'text-emerald-400 font-semibold border-l-2 border-emerald-500 pl-1 py-0.5 bg-emerald-950/10' :
                        isHeader ? 'text-cyan-400 font-bold' :
                        isSecondary ? 'text-gray-500 font-semibold pl-2' : 'text-gray-400'
                      }`}
                    >
                      {log}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Information bottom alert */}
            <div className="bg-[#121622] rounded border border-zinc-850 p-2.5 font-mono text-[9px] text-gray-500 leading-normal flex items-start gap-1.5 shrink-0 select-none">
              <Info className="w-4 h-4 text-[#00ff41] shrink-0 mt-0.5" />
              <span>
                Standardizing schemas guarantees low alignment loss over high-volume agent clusters. gRPC cuts wire overhead on multiplex networks, while WebSockets broadcast frames in sub-millisecond ranges.
              </span>
            </div>

          </div>

        </div>
      )}

    </div>
  );
}
