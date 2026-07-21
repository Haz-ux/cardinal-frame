export type NodeProcessor = 'CPU' | 'GPU-TensorCore' | 'NPU-Local' | 'Remote-Cloud';

export type AgentNodeType = 
  | 'IngressRouter'
  | 'TaskPlanner'
  | 'LocalInference'
  | 'ToolExecutor'
  | 'ResponseAggregator';

export interface AgentNode {
  id: string;
  name: string;
  type: AgentNodeType;
  processor: NodeProcessor;
  modelName: string;
  batchSize: number;
  inputTokens: number;
  outputTokens: number;
  concurrencyLimit: number;
  status: 'idle' | 'processing' | 'completed' | 'error';
  // Position for visualization
  x: number;
  y: number;
}

export interface NodeEdge {
  id: string;
  source: string;
  target: string;
  transportType: 'Channel' | 'gRPC' | 'SharedMemory' | 'ZeroCopyRing';
  latencyNs: number; // Low latency representation (Go optimized)
}

export type NetworkTransportType = 'GoChannels' | 'gRPC-QUIC' | 'ZeroCopyRingBuffer' | 'SharedMemorySHM';

export interface OrchestratorConfig {
  networkTransport: NetworkTransportType;
  npuAllocatedVramGb: number;
  concurrencyWorkers: number;
  highThroughputMode: boolean;
  pinThreadsToGoRuntime: boolean;
}

export interface NPUTelemetry {
  id: string;
  name: string;
  type: string; // Apple NE, Qualcomm, Coreml, CUDA etc
  status: 'active' | 'throttle' | 'offline';
  temperatureC: number;
  clockMhz: number;
  sramUtilizationPercent: number;
  vramUsedGb: number;
  vramTotalGb: number;
  executionQueueLength: number;
  opThroughputTops: number; // TOPS
  activePowerWatts: number;
  tokensPerSec: number;
}

export interface SimulatedStepLog {
  id: string;
  timestamp: string;
  nodeId: string;
  nodeName: string;
  eventType: 'data_ingress' | 'npu_inference' | 'tool_exec' | 'routing_decision' | 'aggregation';
  durationUs: number; // execution duration in microseconds
  throughputTps: number;
  status: 'info' | 'success' | 'warn';
  message: string;
  payload?: string;
}

export interface SimulationResult {
  query: string;
  totalLatencyMs: number;
  bottleneckNodeId: string | null;
  avgNpuLoad: number;
  peakThroughputTps: number;
  steps: SimulatedStepLog[];
  assistantOutput: string;
}
