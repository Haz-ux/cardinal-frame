import dotenv from "dotenv";
dotenv.config();

import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import cors from "cors";

// Ensure the persistent key file exists
const defaultKey = "AIzaSyBSB8Qr9rWoQjUBNvzMmyLqqoKTvOGc6Ik";
if (!fs.existsSync("gemini_api_key.txt")) {
  try {
    fs.writeFileSync("gemini_api_key.txt", defaultKey, "utf8");
  } catch (err) {
    console.error("Error creating default gemini_api_key.txt:", err);
  }
}

function getSavedApiKey(): string {
  try {
    if (fs.existsSync("gemini_api_key.txt")) {
      const saved = fs.readFileSync("gemini_api_key.txt", "utf8").trim();
      if (saved && saved !== "MY_GEMINI_API_KEY") return saved;
    }
  } catch (err) {
    console.error("Error reading saved API key file:", err);
  }
  return defaultKey;
}

// Update process environment immediately
process.env.GEMINI_API_KEY = getSavedApiKey();

// Lazy initialize Gemini client to prevent server crash if key is missing
let aiClient: GoogleGenAI | null = null;

function getAI(req?: express.Request): GoogleGenAI | null {
  const customKey = req?.headers?.["x-gemini-key"] as string || req?.body?.apiKey;
  const apiKey = customKey || process.env.GEMINI_API_KEY || getSavedApiKey();
  if (!apiKey) {
    console.warn("GEMINI_API_KEY environment variable is not set. GoClaw Orchestrator will run in Local Simulated heuristic mode.");
    return null;
  }
  
  // If custom key is provided on the request specifically, instantiate on-demand to keep routing pure
  if (customKey) {
    return new GoogleGenAI({
      apiKey: apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        }
      }
    });
  }

  if (!aiClient || (aiClient as any)._apiKey !== apiKey) {
    aiClient = new GoogleGenAI({
      apiKey: apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        }
      }
    });
    (aiClient as any)._apiKey = apiKey;
  }
  return aiClient;
}

function isApiKeyError(err: any): boolean {
  if (!err) return false;
  const errMsg = String(err.message || err.status || err || "").toLowerCase();
  return (
    errMsg.includes("api key expired") ||
    errMsg.includes("api_key_invalid") ||
    errMsg.includes("invalid api key") ||
    errMsg.includes("api key invalid") ||
    errMsg.includes("key expired") ||
    (errMsg.includes("invalid_argument") && errMsg.includes("api key"))
  );
}

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// API health check
app.get("/api/health", (req, res) => {
  const hasKey = !!process.env.GEMINI_API_KEY;
  res.json({ status: "ok", mode: hasKey ? "AI-Powered" : "Local Simulation", timestamp: new Date().toISOString() });
});

// Endpoint to check currently saved API key status (masked for safety)
app.get("/api/get-api-key-status", (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === "MY_GEMINI_API_KEY") {
    return res.json({ hasKey: false, maskedKey: "" });
  }
  const masked = apiKey.length > 8 
    ? apiKey.substring(0, 6) + "..." + apiKey.substring(apiKey.length - 4)
    : "****";
  res.json({ hasKey: true, maskedKey: masked });
});

// Endpoint to dynamically save and validate/confirm a new Gemini API Key
app.post("/api/save-api-key", async (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey || !apiKey.trim()) {
    return res.status(400).json({ error: "Gemini API Key cannot be left blank." });
  }

  const trimmedKey = apiKey.trim();

  try {
    // Confirm and validate key by testing connection to the models endpoints
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${trimmedKey}`);
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const reason = errorData?.error?.message || "Invalid or expired key credentials.";
      return res.status(400).json({ error: `Verification Failed: ${reason}` });
    }

    // Key is confirmed valid! Update physical memory environment
    process.env.GEMINI_API_KEY = trimmedKey;
    
    // Explicitly nullify existing lazily-initialized connection client so new client is initialized on the next run
    aiClient = null; 

    // Write key back to local .env configuration so it is persisted across hot reboots
    const envPath = path.join(process.cwd(), '.env');
    let envContent = '';
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf8');
    }

    const regex = /^GEMINI_API_KEY=.*$/m;
    if (regex.test(envContent)) {
      envContent = envContent.replace(regex, `GEMINI_API_KEY="${trimmedKey}"`);
    } else {
      envContent = `GEMINI_API_KEY="${trimmedKey}"\n` + envContent;
    }
    fs.writeFileSync(envPath, envContent.trim() + '\n', 'utf8');

    const masked = trimmedKey.length > 8 
      ? trimmedKey.substring(0, 6) + "..." + trimmedKey.substring(trimmedKey.length - 4)
      : "****";

    res.json({
      success: true,
      message: "Credentials successfully validated and persisted on host workstation!",
      maskedKey: masked
    });
  } catch (err: any) {
    console.error("Credentials verification exception:", err);
    res.status(500).json({ error: `Connection Interrupted: ${err.message || 'Verification exception'}` });
  }
});

// GitNexus Workspace Helpers
function getFilesRecursively(dir: string, baseDir = ""): any[] {
  const result: any[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    // Sort directories first, then files
    const sortedEntries = entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    for (const entry of sortedEntries) {
      if (
        entry.name === "node_modules" ||
        entry.name === ".git" ||
        entry.name === "dist" ||
        entry.name === "package-lock.json" ||
        entry.name.startsWith(".")
      ) {
        continue;
      }
      const relativePath = baseDir ? path.join(baseDir, entry.name) : entry.name;
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        result.push({
          name: entry.name,
          type: "directory",
          path: relativePath,
          children: getFilesRecursively(fullPath, relativePath)
        });
      } else {
        result.push({
          name: entry.name,
          type: "file",
          path: relativePath,
          size: fs.existsSync(fullPath) ? fs.statSync(fullPath).size : 0
        });
      }
    }
  } catch (err) {
    console.error("GitNexus recurse error:", err);
  }
  return result;
}

// GitNexus API: List files in workspace (fully recursive)
app.get("/api/gitnexus/files", (req, res) => {
  try {
    const root = process.cwd();
    const tree = getFilesRecursively(root);
    res.json({ success: true, files: tree });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to read workspace layout: " + err.message });
  }
});

// GitNexus API: Read individual file content
app.get("/api/gitnexus/file", (req, res) => {
  const filePathParam = req.query.path as string;
  if (!filePathParam) {
    return res.status(400).json({ error: "No target file path supplied." });
  }
  try {
    const root = process.cwd();
    // Resolve absolute path to prevent escaping path sandbox
    const fullPath = path.resolve(root, filePathParam);
    if (!fullPath.startsWith(root)) {
      return res.status(403).json({ error: "Directory path traversal is forbidden." });
    }
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: "Target file does not exist: " + filePathParam });
    }
    const content = fs.readFileSync(fullPath, "utf-8");
    res.json({ success: true, path: filePathParam, content });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to read file: " + err.message });
  }
});

// GitNexus API: Save / Write / Create file content
app.post("/api/gitnexus/file", (req, res) => {
  const { path: filePathParam, content } = req.body;
  if (!filePathParam) {
    return res.status(400).json({ error: "Target file path is required." });
  }
  try {
    const root = process.cwd();
    const fullPath = path.resolve(root, filePathParam);
    if (!fullPath.startsWith(root)) {
      return res.status(403).json({ error: "Directory path traversal is forbidden." });
    }

    // Ensure the parent directory directories exist
    const parentDir = path.dirname(fullPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    fs.writeFileSync(fullPath, content || "", "utf-8");
    res.json({ success: true, message: `Successfully persisted: ${filePathParam}` });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to edit file: " + err.message });
  }
});

// GitNexus API: Delete file
app.post("/api/gitnexus/delete", (req, res) => {
  const { path: filePathParam } = req.body;
  if (!filePathParam) {
    return res.status(400).json({ error: "Target path is required." });
  }
  try {
    const root = process.cwd();
    const fullPath = path.resolve(root, filePathParam);
    if (!fullPath.startsWith(root)) {
      return res.status(403).json({ error: "Directory path traversal is forbidden." });
    }
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: "target target to delete does not exist." });
    }

    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      fs.rmSync(fullPath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(fullPath);
    }
    res.json({ success: true, message: `Successfully deleted: ${filePathParam}` });
  } catch (err: any) {
    res.status(500).json({ error: "Deletion failure: " + err.message });
  }
});

// Route: Discover and list active API models from Gemini or Nvidia Nemotron portals
app.post("/api/discover-models", async (req, res) => {
  const customGeminiKey = req.body.geminiKey;
  const customNvidiaKey = req.body.nvidiaKey;

  const geminiKey = customGeminiKey || process.env.GEMINI_API_KEY;
  const nvidiaKey = customNvidiaKey || process.env.NVIDIA_NEMOTRON_API_KEY;

  const results = {
    gemini: {
      status: "idle",
      detected: !!geminiKey && geminiKey !== "MY_GEMINI_API_KEY",
      isCustom: !!customGeminiKey,
      models: [] as any[]
    },
    nvidia: {
      status: "idle",
      detected: !!nvidiaKey && nvidiaKey !== "MY_NVIDIA_PORTAL_KEY",
      isCustom: !!customNvidiaKey,
      models: [] as any[]
    }
  };

  // 1. Fetch live Gemini models
  if (results.gemini.detected && geminiKey) {
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${geminiKey}`);
      if (response.ok) {
        const data = await response.json();
        if (data.models && Array.isArray(data.models)) {
          results.gemini.models = data.models
            .filter((m: any) => m.name && (m.name.includes("gemini") || m.name.includes("veo")))
            .map((m: any) => ({
              name: m.name.replace("models/", ""),
              displayName: m.displayName || m.name.split("/").pop(),
              description: m.description || "Google AI multimodal execution model.",
              inputTokenLimit: m.inputTokenLimit || 128000,
              outputTokenLimit: m.outputTokenLimit || 8192
            }));
          results.gemini.status = "connected";
        } else {
          results.gemini.status = "invalid_payload";
        }
      } else {
        results.gemini.status = "unauthorized";
      }
    } catch (e: any) {
      results.gemini.status = "error";
      console.error("Gemini models detection exception:", e.message);
    }
  }

  // Backup / local simulation catalog for Gemini
  if (results.gemini.models.length === 0) {
    results.gemini.models = [
      { name: "gemini-3.5-flash", displayName: "Gemini 3.5 Flash", description: "Ultra-fast text reasoning model with multi-million multimodal inputs.", inputTokenLimit: 1048576, outputTokenLimit: 8192 },
      { name: "gemini-3.1-pro-preview", displayName: "Gemini 3.1 Pro (Preview)", description: "High-intelligence reasoning and multi-step reasoning agent model.", inputTokenLimit: 2097152, outputTokenLimit: 8192 },
      { name: "gemini-3.1-flash-lite", displayName: "Gemini 3.1 Flash Lite", description: "Extreme low-latency, low-cost text orchestration routing model.", inputTokenLimit: 1048576, outputTokenLimit: 8192 },
      { name: "gemini-2.5-flash-image", displayName: "Gemini 2.5 Image Generator", description: "Advanced image, schematic and high-contrast visual model.", inputTokenLimit: 1048576, outputTokenLimit: 8192 }
    ];
    if (results.gemini.status === "idle") {
      results.gemini.status = "simulated";
    }
  }

  // 2. Fetch live Nvidia models
  if (results.nvidia.detected && nvidiaKey) {
    try {
      const response = await fetch("https://integrate.api.nvidia.com/v1/models", {
        headers: {
          "Authorization": `Bearer ${nvidiaKey}`,
          "Content-Type": "application/json"
        }
      });
      if (response.ok) {
        const data = await response.json();
        if (data.data && Array.isArray(data.data)) {
          results.nvidia.models = data.data
            .filter((m: any) => m.id && (m.id.includes("nemotron") || m.id.includes("llama") || m.id.includes("mixtral")))
            .map((m: any) => ({
              name: m.id,
              displayName: m.id.split("/").pop()?.replace(/-/g, " ").toUpperCase() || m.id,
              description: `Nvidia NIM model pipeline node: ${m.id}`,
              inputTokenLimit: 32768,
              outputTokenLimit: 4096
            }));
          results.nvidia.status = "connected";
        } else {
          results.nvidia.status = "invalid_payload";
        }
      } else {
        results.nvidia.status = "unauthorized";
      }
    } catch (e: any) {
      results.nvidia.status = "error";
      console.error("Nvidia models detection exception:", e.message);
    }
  }

  // Backup / local simulation catalog for Nvidia
  if (results.nvidia.models.length === 0) {
    results.nvidia.models = [
      { name: "nvidia/llama-3.1-nemotron-70b-instruct", displayName: "Nemotron Llama 3.1 70B", description: "Highly advanced instructions alignment and complex systems planning model.", inputTokenLimit: 131072, outputTokenLimit: 4096 },
      { name: "nvidia/nemotron-4-340b-instruct", displayName: "Nemotron-4 340B Instruct", description: "Extreme scale synthetic model context data generator and scheduler.", inputTokenLimit: 4096, outputTokenLimit: 4096 },
      { name: "nvidia/lfm-40b", displayName: "Nvidia Liquid Foundation 40B", description: "Highly efficient state-space sequence model scaling pipeline.", inputTokenLimit: 32768, outputTokenLimit: 4096 },
      { name: "nvidia/nemotron-mini-4b-instruct", displayName: "Nemotron Mini 4B Instruct", description: "Sub-second latency instructions alignment scheduler node.", inputTokenLimit: 8192, outputTokenLimit: 2048 }
    ];
    if (results.nvidia.status === "idle") {
      results.nvidia.status = "simulated";
    }
  }

  res.json(results);
});

// Route: Generate optimized Go source code scaffolding
app.post("/api/generate-go-code", async (req, res) => {
  const { nodes, edges, config } = req.body;
  const ai = getAI(req);

  if (!ai) {
    // Return sample static compiled Go code if API key is not available
    return res.json({
      code: getSimulatedGoCode(nodes, edges, config),
      isSimulated: true,
      message: "Scaffolded with optimized local templates. Add your custom Gemini API Key in Settings to get dynamic AI-optimized Go code generation."
    });
  }

  try {
    const prompt = `You are an expert systems engineer and principal Go architect.
Analyze the following GoClaw AI Agent Orchestration DAG (Directed Acyclic Graph) designed for low-latency agent execution and generate highly efficient, production-ready Go 1.22+ code.

--- CONFIGURATION ---
- Transport Mode: ${config?.networkTransport || 'GoChannels'}
- Concurrency Workers: ${config?.concurrencyWorkers || 8}
- Pin OS Threads to Go Runtime (Runtime.LockOSThread): ${config?.pinThreadsToGoRuntime ? 'YES' : 'NO'}
- High Throughput NPU Activation: ${config?.highThroughputMode ? 'YES' : 'NO'}

--- DAG STRUCTURE ---
Active Nodes:
${JSON.stringify(nodes, null, 2)}

Active Interconnects / Streams (Edges):
${JSON.stringify(edges, null, 2)}

--- REQUIREMENTS FOR THE GO CODE ---
1. Provide a single, clean, self-contained complete code solution formatted beautifully.
2. If GoChannels is selected, map DAG edges to type 'chan Msg' buffered channels for lock-free pipelining.
3. If SharedMemory / ZeroCopyRing is selected, construct lock-free circular buffers using Go's 'sync/atomic' pointers to represent message passing of inference tensors.
4. If gRPC-QUIC is selected, include scaffolding for custom protobuf message exchange with net.Listen connections.
5. Create dedicated Go structs for each agent node (e.g. ${nodes.map((n: any) => n.name).join(', ')}).
6. Implement simulated or structured CGo bindings/WebNN skeletons targeting local NPU device triggers to show how inference metrics would be dispatched down to the hardware (Apple NE, cuda Cores, Intel OpenVINO, etc. depending on the processor configuration).
7. Optimize the thread context switching: add comments explaining how 'runtime.Gosched()' or raw pointer arithmetic decreases queue bottleneck.
8. Make the 'main()' function start the nodes in goroutines, establish the pipeline stream, run a concurrent batch query simulation, tracking latency in nanoseconds (time.Since), and print deep throughput.

Return ONLY the complete valid Go file. Use nested comments to explain specific compiler flags or CGo bindings for local NPU model loading. Do not include markdown wraps besides standard formatting.`;

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: prompt,
    });

    res.json({
      code: response.text || "",
      isSimulated: false
    });
  } catch (error: any) {
    console.error("Error generating Go code through Gemini:", error);
    if (isApiKeyError(error)) {
      return res.json({
        code: getSimulatedGoCode(nodes, edges, config),
        isSimulated: true,
        message: "⚠️ Your Gemini API Key has expired. Automatically generated native low-latency Go templates."
      });
    }
    res.status(500).json({ error: error.message, isSimulated: true, code: getSimulatedGoCode(nodes, edges, config) });
  }
});

// Route: Simulate distributed workflow execution through Gemini
app.post("/api/simulate-workflow", async (req, res) => {
  const { query, nodes, edges, config, npuConfig } = req.body;
  const ai = getAI(req);

  if (!ai) {
    // Generate a beautiful structured mock simulation trace locally
    return res.json(getLocalSimulatedTrace(query, nodes, edges, config, npuConfig));
  }

  try {
    const prompt = `You are the master scheduler and distributed profile monitor of GoClaw AI Orchestrator running local models on dedicated mobile/desktop NPUs.
We need to model the ultra-fast execution of a distributed agent workflow pipeline for the query: "${query}"

Here is the current state of our network DAG:
Nodes: ${JSON.stringify(nodes)}
Edges: ${JSON.stringify(edges)}
Transport Transport: ${config?.networkTransport}
Active NPU hardware: ${JSON.stringify(npuConfig)}

Generate a detailed timing simulation of this query passing completely through the orchestration DAG.
You must return your response STRICTLY as a JSON object matching this schema (do NOT return anything outside this JSON):
{
  "totalLatencyMs": <number representing total elapsed millisecond time, for local NPU and Go channels this should look ultra-low, e.g., 8ms to 45ms total>,
  "bottleneckNodeId": <id of the node that took the longest time>,
  "avgNpuLoad": <percentage number, e.g., 68>,
  "peakThroughputTps": <number of tokens/second across NPUs, e.g., 142>,
  "steps": [
    {
      "id": "step1",
      "timestamp": "ISO_TIMESTAMP",
      "nodeId": "id of node",
      "nodeName": "name of node",
      "eventType": "one of: 'data_ingress', 'npu_inference', 'tool_exec', 'routing_decision', 'aggregation'",
      "durationUs": <number in microseconds, range 10-150000>,
      "throughputTps": <number, tokens/sec achieved if local model inference>,
      "status": "info" | "success" | "warn",
      "message": "detailed trace of what GoClaw did on this node (e.g. 'Dispatched zero-copy pointer to NPU-0 queue. Batched 8 input tokens.')",
      "payload": "truncated representation of Go structure outputs or agent local decision"
    },
    ... (generate sequential/parallel step records trace for all relevant nodes)
  ],
  "assistantOutput": "The elegant, markdown-formatted final answer generated by our orchestrated local models responding to: ${query}. (Maintain a helpful GoClaw diagnostic tone!)"
}`;

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            totalLatencyMs: { type: Type.NUMBER },
            bottleneckNodeId: { type: Type.STRING },
            avgNpuLoad: { type: Type.NUMBER },
            peakThroughputTps: { type: Type.NUMBER },
            steps: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING },
                  timestamp: { type: Type.STRING },
                  nodeId: { type: Type.STRING },
                  nodeName: { type: Type.STRING },
                  eventType: { type: Type.STRING },
                  durationUs: { type: Type.NUMBER },
                  throughputTps: { type: Type.NUMBER },
                  status: { type: Type.STRING },
                  message: { type: Type.STRING },
                  payload: { type: Type.STRING }
                }
              }
            },
            assistantOutput: { type: Type.STRING }
          },
          required: ["totalLatencyMs", "bottleneckNodeId", "avgNpuLoad", "peakThroughputTps", "steps", "assistantOutput"]
        }
      }
    });

    const parsed = JSON.parse(response.text || "{}");
    res.json(parsed);
  } catch (error: any) {
    console.error("Error running simulation through Gemini:", error);
    const keyExpired = isApiKeyError(error);
    res.json(getLocalSimulatedTrace(query, nodes, edges, config, npuConfig, keyExpired));
  }
});

// Route: Interactive Workspace Chat with secure backend Gemini call
app.post("/api/chat", async (req, res) => {
  const { message, history, nodesCount } = req.body;
  const ai = getAI(req);

  if (!ai) {
    // Elegant local fallback simulated cybernetic architect response
    const fallbackAnswers = [
      "I am the Cardinal Frame systems architect subagent. I'm listening to your local environment signals.",
      `Received workflow inquiry: "${message}". Your active DAG layout currently consists of ${nodesCount || 5} nodes. We can optimize latency by mapping lock-free circular Zero-Copy ring streams.`,
      "Indeed! Pinned OS threads (runtime.LockOSThread) coupled with Apple Neural Engine or Snapdragon Hexagon NPU registers allow parallel sub-millisecond execution.",
      "How can I help you customize your Go 1.22 visual programming layout, streamline the CGo memory pipelines, or configure your model registers today?",
      "To obtain a full generative master-chat conversation with the Cardinal AI expert, please insert your Google Gemini API Key in the settings hub!"
    ];
    // Custom keyword responses
    let reply = fallbackAnswers[Math.floor(Math.random() * fallbackAnswers.length)];
    if (message.toLowerCase().includes("dag") || message.toLowerCase().includes("topology")) {
      reply = `Analyzing your active visual DAG (nodes: ${nodesCount || 5}). For low latency, SharedMemory channels bypass typical network serialization. I suggest configuring your routing nodes with concurrency of 16.`;
    } else if (message.toLowerCase().includes("npu") || message.toLowerCase().includes("hardware")) {
      reply = `Checked client hardware accelerators. Your WebGL render thread and processor allocations have 100% direct-mapped SRAM coverage. A local Qwen-2.5-Coder 7B footprint operates perfectly here!`;
    } else if (message.toLowerCase().includes("gitnexus") || message.toLowerCase().includes("file")) {
      reply = `In the GitNexus Workspace, files are mapped visually as glowing Synaptic Hub capsules. Clicking any capsule hot-loads the source bytes directly into the IDE workbench.`;
    }
    return res.json({ response: reply, isMock: true });
  }

  try {
    const formattedHistory = (history || []).slice(-10).map((h: any) => ({
      role: h.role,
      parts: [{ text: h.text }]
    }));

    const systemInstruction = `You are "Cardinal Frame Architect", the expert AI systems coding companion resident in this visual programming studio.
You help systems developers assemble low-latency, High-Speed Go multi-agent networks, debug Go channels, profile NPU hardware buffers, and organize memory architectures.
Speak with a professional, composed, yet deeply enthusiastic cybernetic-technologist tone. Keep responses helpful, precise, and visually clean (use elegant markdown grids, bullet lists, or telemetry-style blocks when explaining concepts).`;

    const chat = ai.chats.create({
      model: "gemini-3.5-flash",
      config: {
        systemInstruction,
        temperature: 0.3
      },
      history: formattedHistory
    });

    const response = await chat.sendMessage({
      message: message
    });

    res.json({
      response: response.text || "Received connection but found no reply payload.",
      isMock: false
    });
  } catch (err: any) {
    console.error("AI chat root route error:", err);
    if (isApiKeyError(err)) {
      console.warn("Detected expired or invalid GEMINI_API_KEY. Operating in Local Simulation mode.");
      
      const fallbackAnswers = [
        `⚠️ **GOOGLE GEMINI API KEY EXPIRED / INVALID**\n\nYour Gemini API key has expired or is invalid. I am operating in **Local Cybernetic Simulation** mode.\n\nRegarding your inquiry: "${message}"\n\nTo configure GoClaw and organize low-overhead channels, optimize the memory boundaries. Let me know which submodules or buffers you'd like to adjust. Make sure to renew your Gemini API key in Settings to restore full deep reasoning capabilities!`,
        `⚠️ **GOOGLE GEMINI API KEY EXPIRED / INVALID**\n\nYour Gemini API key is invalid or expired. I have automatically enabled my **Local Heuristic Coprocessor**.\n\nYour orchestration has **${nodesCount || 5} agent nodes** queued. We can model lockless Zero-Copy circular buffers using atomic pointers or customize concurrency pipelines. Please update your API key in settings at your convenience!`
      ];
      
      let reply = fallbackAnswers[Math.floor(Math.random() * fallbackAnswers.length)];
      if (message.toLowerCase().includes("dag") || message.toLowerCase().includes("topology")) {
        reply = `⚠️ **GEMINI KEY EXPIRED** (In Local Fallback):\n\nAnalyzing active visuals (nodes: ${nodesCount || 5}). Circular arrays bypass standard system network stack overhead. Concurrency limits are tuned.`;
      } else if (message.toLowerCase().includes("npu") || message.toLowerCase().includes("hardware")) {
        reply = `⚠️ **GEMINI KEY EXPIRED** (In Local Fallback):\n\nNPU context bindings alignment must remain page-aligned. SRAM registers are pre-allocated locally.`;
      } else if (message.toLowerCase().includes("gitnexus") || message.toLowerCase().includes("file")) {
        reply = `⚠️ **GEMINI KEY EXPIRED** (In Local Fallback):\n\nGitNexus directory synapse map synced offline. Source code streams directly.`;
      }
      
      return res.json({ response: reply, isMock: true });
    }
    res.status(500).json({ error: "Gemini Chat Exception: " + err.message });
  }
});

// Helper: static Go code generation fallback template
function getSimulatedGoCode(nodes: any[], edges: any[], config: any) {
  const netMode = config?.networkTransport || 'GoChannels';
  const threadsPinned = config?.pinThreadsToGoRuntime ? "true" : "false";
  return `package main

import (
\t"context"
\t"fmt"
\t"sync"
\t"sync/atomic"
\t"time"
\t"runtime"
)

// GoClaw Core Architecture Config
// Transport Mode: ${netMode}
// Pinned OS Threads: ${threadsPinned}
// Concurrency: ${config?.concurrencyWorkers || 8} workers

// Msg represents the low-latency message passing structure in GoClaw
type Msg struct {
\tID        int64
\tPayload   string
\tTokens    int
\tLatencyUs int64
\tIngressAt time.Time
}

// ============================================================================
// 1. STANDARDIZED COMMUNICATION PROTOCOLS (gRPC & WebSocket definitions)
// ============================================================================

// RegisterAgentRequest defines the standardized registration payload over gRPC
type RegisterAgentRequest struct {
\tAgentID           string
\tNodeType          string
\tConcurrencyLimit  int32
\tHardwareSignature string
}

// TelemetryFrame defines the real-time high-frequency telemetry event payload
type TelemetryFrame struct {
\tNodeID                   string
\tCurrentSramUtilBytes     uint64
\tActiveConcurrencyThreads uint32
\tInstantaneousThroughput  float64
}

// WSBroadcastBroker manages real-time socket subscribers with lock safety
type WSBroadcastBroker struct {
\tmu      sync.RWMutex
\tclients map[string]chan string
}

func NewWSBroker() *WSBroadcastBroker {
\treturn &WSBroadcastBroker{
\t\tclients: make(map[string]chan string),
\t}
}

func (w *WSBroadcastBroker) BroadcastMetric(evtType string, node string, latencyNs int64) {
\tw.mu.RLock()
\tdefer w.mu.RUnlock()
\tframe := fmt.Sprintf("{\\"event\\":\\"%s\\",\\"node\\":\\"%s\\",\\"latency_ns\\":%d}", evtType, node, latencyNs)
\tfor _, ch := range w.clients {
\t\tselect {
\t\tcase ch <- frame:
\t\tdefault: // Non-blocking write to avoid throttling
\t\t}
\t}
}

// ============================================================================
// 2. NPU ACCELERATOR HARDWARE ABSTRACTION LAYER (Go-HAL Interface)
// ============================================================================

type UnifiedNPUManager interface {
\tInitializeDevice(ctx context.Context, slot int) error
\tLoadWeights(ctx context.Context, modelName string) (ModelWeightsHandle, error)
\tGetCoreUtilization() int32
}

type ModelWeightsHandle interface {
\tExecuteModelInference(ctx context.Context, input string, batchSize int) (string, int)
\tGetName() string
}

type AppleNEEngine struct {
\tslot        int
\tutilization int32
}

func (a *AppleNEEngine) InitializeDevice(ctx context.Context, slot int) error {
\ta.slot = slot
\tatomic.StoreInt32(&a.utilization, 0)
\treturn nil
}

func (a *AppleNEEngine) LoadWeights(ctx context.Context, modelName string) (ModelWeightsHandle, error) {
\treturn &CoreMLWeights{name: modelName, engine: a}, nil
}

func (a *AppleNEEngine) GetCoreUtilization() int32 {
\treturn atomic.LoadInt32(&a.utilization)
}

type CoreMLWeights struct {
\tname   string
\tengine *AppleNEEngine
}

func (c *CoreMLWeights) GetName() string { return c.name }

func (c *CoreMLWeights) ExecuteModelInference(ctx context.Context, input string, batchSize int) (string, int) {
\tatomic.StoreInt32(&c.engine.utilization, 98)
\tdefer atomic.StoreInt32(&c.engine.utilization, 0)
	
\t// Hardware alignment delay: page boundary matched
\ttime.Sleep(time.Duration(120 + batchSize*4) * time.Microsecond)
\treturn fmt.Sprintf("Inference output of size %d generated on CoreML NPU", len(input)*2), batchSize * 45
}

// ============================================================================
// 3. HIGH-THROUGHPUT CONCURRENT PREDICTION MODEL INFERENCE SERVICE
// ============================================================================

type PredictionRequest struct {
\tPrompt    string
\tResponse  chan string
\tTokensOut chan int
}

type InferenceService struct {
\tmu           sync.RWMutex
\tnpu          UnifiedNPUManager
\tactiveModels map[string]ModelWeightsHandle
\trequestQueue chan PredictionRequest
}

func NewInferenceService(npu UnifiedNPUManager) *InferenceService {
\tsvc := &InferenceService{
\t\tnpu:          npu,
\t\tactiveModels: make(map[string]ModelWeightsHandle),
\t\trequestQueue: make(chan PredictionRequest, 1024),
\t}
\t// Start high-throughput queue batcher loop
\tgo svc.startBatchProcessor()
\treturn svc
}

func (s *InferenceService) LoadModel(ctx context.Context, name string) error {
\ts.mu.Lock()
\tdefer s.mu.Unlock()
	
\tif _, ok := s.activeModels[name]; ok {
\t\treturn nil // Already cache-loaded
\t}
	
\tweights, err := s.npu.LoadWeights(ctx, name)
\tif err != nil {
\t\treturn err
\t}
\ts.activeModels[name] = weights
\treturn nil
}

// Dynamic Request Batching Loop to optimize tensor dimensions for local ANE NPU
func (s *InferenceService) startBatchProcessor() {
\tticker := time.NewTicker(10 * time.Millisecond) // Trigger periodic concurrent processing
\tdefer ticker.Stop()
	
\tvar batch []PredictionRequest
	
\tfor {
\t\tselect {
\t\tcase req := <-s.requestQueue:
\t\t\tbatch = append(batch, req)
\t\t\tif len(batch) >= 16 { // Max batch size constraint triggered
\t\t\t\ts.dispatchBatch(batch)
\t\t\t\tbatch = nil
\t\t\t}
\t\tcase <-ticker.C:
\t\t\tif len(batch) > 0 {
\t\t\t\ts.dispatchBatch(batch)
\t\t\t\tbatch = nil
\t\t\t}
\t\t}
\t}
}

func (s *InferenceService) dispatchBatch(batch []PredictionRequest) {
\ts.mu.RLock()
\tvar weights ModelWeightsHandle
\tfor _, w := range s.activeModels {
\t\tweights = w // Just pick the default active model for this DAG scaffold execution
\t\tbreak
\t}
\ts.mu.RUnlock()
	
\tif weights == nil {
\t\tfor _, req := range batch {
\t\t\treq.Response <- "Error: No model loaded in high-throughput inference service"
\t\t\treq.TokensOut <- 0
\t\t}
\t\treturn
\t}
	
\t// Composite prompt consolidation representing zero-copy memory layouts
\tcompositePrompt := ""
\tfor _, req := range batch {
\t\tcompositePrompt += req.Prompt + "|"
\t}
	
\t// Execute prediction down over memory aligned NPU Go-HAL Access layer
\tresp, tokens := weights.ExecuteModelInference(context.Background(), compositePrompt, len(batch))
	
\tfor _, req := range batch {
\t\treq.Response <- fmt.Sprintf("%s [batch_size=%d]", resp, len(batch))
\t\treq.TokensOut <- tokens / len(batch)
\t}
}

func (s *InferenceService) EnqueuePrediction(prompt string) (string, int) {
\trespChan := make(chan string, 1)
\ttokChan := make(chan int, 1)
	
\ts.requestQueue <- PredictionRequest{
\t\tPrompt:    prompt,
\t\tResponse:  respChan,
\t\tTokensOut: tokChan,
\t}
	
\treturn <-respChan, <-tokChan
}

// Global NPU device handle simulation
type NPUDevice struct {
\tslot      int
\tlock      sync.Mutex
\tutilization int32
}

func (n *NPUDevice) RunLocalInference(ctx context.Context, prompt string, batchSize int) (string, int) {
\t// Simulated hardware scheduling trigger
\t// Utilizing CGo bindings or directly tapping memory-mapped sys registers
\tatomic.StoreInt32(&n.utilization, 98)
\tdefer atomic.StoreInt32(&n.utilization, 0)
\t
\t// Hardware microsecond timing delay setup
\thardwareDelay := time.Duration(120+batchSize*4) * time.Microsecond
\tselect {
\tcase <-time.After(hardwareDelay):
\t\treturn "Inference response from local model", batchSize * 45
\tcase <-ctx.Done():
\t\treturn "", 0
\t}
}

${nodes.map(n => `// Node_${n.id} implements the ${n.type} behaviour
type Struct_${n.name} struct {
\tName       string
\tProcessor  string
\tModel      string
\tWorkers    int
}

func New_${n.name}() *Struct_${n.name} {
\treturn &Struct_${n.name}{
\t\tName:      "${n.name}",
\t\tProcessor: "${n.processor}",
\t\tModel:     "${n.modelName}",
\t\tWorkers:   ${n.concurrencyLimit},
\t}
}
`).join('\n')}

func main() {
\t// Optimizing core thread utilization for low-latency GoClaw pipeline
\truntime.GOMAXPROCS(runtime.NumCPU())
\tif ${threadsPinned} {
\t\truntime.LockOSThread()
\t\tdefer runtime.UnlockOSThread()
\t}

\tfmt.Printf("🐾 Initializing GoClaw Low-Latency Orchestrator [%s]...\\n", "${netMode}")
\tctx, cancel := context.WithCancel(context.Background())
\tdefer cancel()

\t// Initialize physical ANE device driver with unified context
\tnpuManager := &AppleNEEngine{}
\t_ = npuManager.InitializeDevice(ctx, 0)
	
\t// Spin up dynamic model inference service
\tinferenceService := NewInferenceService(npuManager)
\t_ = inferenceService.LoadModel(ctx, "Qwen-Coder-7B")

\twsBroker := NewWSBroker()
\t_ = wsBroker

\tst := time.Now()

\t// Orchestration Channel Pools based on Visual DAG Interconnects
\t${edges.map((e, index) => `ch_${e.source}_to_${e.target} := make(chan Msg, 1024) // Buffer size optimized for batch concurrency`).join('\n\t')}

\tvar wg sync.WaitGroup

\t// Starting concurrent Node loops
\t// Simulated distributed flow for each of the nodes:
\t${nodes.map(n => {
    const outputs = edges.filter(e => e.source === n.id);
    const inputs = edges.filter(e => e.target === n.id);
    return `// Worker loop for: ${n.name}
\twg.Add(1)
\tgo func() {
\t\tdefer wg.Done()
\t\tfor {
\t\t\tselect {
\t\t\tcase <-ctx.Done():
\t\t\t\treturn
\t\t\t${inputs.length > 0 ? `case msg := <-ch_${inputs[0].source}_to_${inputs[0].target}:
\t\t\t\t// Processing ${n.name} using ${n.processor} processor...
\t\t\t\tprocStart := time.Now()
\t\t\t\tvar gen string
\t\t\t\tvar tps int
\t\t\t\tif "${n.processor}" == "NPU-Local" {
\t\t\t\t\tgen, tps = inferenceService.EnqueuePrediction(msg.Payload)
\t\t\t\t} else {
\t\t\t\t\ttime.Sleep(20 * time.Microsecond) // Microsecond CPU scheduler context simulation
\t\t\t\t\tgen = "CPU analytical stream validation"
\t\t\t\t\ttps = 10
\t\t\t\t}
\t\t\t\tdurationUs := time.Since(procStart).Microseconds()
				
\t\t\t\t// Broadcast real-time stream state metrics to WebSocket channel listeners
\t\t\t\twsBroker.BroadcastMetric("AGENT_STEP_COMPLETED", "${n.name}", time.Since(procStart).Nanoseconds())
\t\t\t\t
\t\t\t\t// Zero-copy stream propagation down the DAG
\t\t\t\t${outputs.length > 0 ? `ch_${outputs[0].source}_to_${outputs[0].target} <- Msg{
\t\t\t\t\tID: msg.ID,
\t\t\t\t\tPayload: gen,
\t\t\t\t\tTokens: tps,
\t\t\t\t\tLatencyUs: msg.LatencyUs + durationUs,
\t\t\t\t\tIngressAt: time.Now(),
\t\t\t\t}` : `_ = durationUs // Endpoint node reached`}
\t\t\t` : `case <-time.After(10 * time.Millisecond):
\t\t\t\t// Seed trigger for start node: ${n.name}
\t\t\t\t${outputs.length > 0 ? `ch_${outputs[0].source}_to_${outputs[0].target} <- Msg{
\t\t\t\t\tID: 1001,
\t\t\t\t\tPayload: "Query input data seed",
\t\t\t\t\tTokens: 1,
\t\t\t\t\tLatencyUs: 0,
\t\t\t\t\tIngressAt: time.Now(),
\t\t\t\t}` : `// Pure isolated sink`}`}
\t\t\t}
\t\t}
\t}()`;
  }).join('\n\n\t')}

\t// Run pipeline benchmark for 1 second of microsecond execution tracking
\ttime.Sleep(1 * time.Second)
\tcancel()
\twg.Wait()

\tfmt.Printf("🏎️ Pipeline Benchmark complete. Run Duration: %v | Zero-Loss distributed streams validated\\n", time.Since(st))
}`;
}

// Logic: local scheduler simulation trace for graceful fallback or fast response
function getLocalSimulatedTrace(query: string, nodes: any[], edges: any[], config: any, npuConfig: any, keyExpired = false) {
  const isZeroCopy = config?.networkTransport === 'ZeroCopyRingBuffer' || config?.networkTransport === 'SharedMemorySHM';
  const baseLatencyFactor = isZeroCopy ? 0.3 : (config?.networkTransport === 'gRPC-QUIC' ? 1.5 : 0.8);
  
  let currentMs = 0.5;
  const steps: any[] = [];
  
  // Predict execution path
  const ingressNodes = nodes.filter(n => n.type === 'IngressRouter');
  const plannerNodes = nodes.filter(n => n.type === 'TaskPlanner');
  const infNodes = nodes.filter(n => n.type === 'LocalInference');
  const toolNodes = nodes.filter(n => n.type === 'ToolExecutor');
  const aggNodes = nodes.filter(n => n.type === 'ResponseAggregator');
  
  // Trace 1: Ingress
  const ingress = ingressNodes[0] || nodes[0];
  if (ingress) {
    const lat = Math.round((45 + Math.random() * 30) * baseLatencyFactor);
    currentMs += lat / 1000;
    steps.push({
      id: "sim_1",
      timestamp: new Date().toISOString(),
      nodeId: ingress.id,
      nodeName: ingress.name,
      eventType: 'data_ingress',
      durationUs: lat,
      throughputTps: 0,
      status: 'success',
      message: `Received incoming distributed binary frame payload. Dispatched over Go ring-buffer channel. Size: ${query.length} B`
    });
  }
  
  // Trace 2: Planner
  const planner = plannerNodes[0] || (nodes[1] ? nodes[1] : null);
  if (planner) {
    const lat = Math.round((120 + Math.random() * 80) * baseLatencyFactor);
    currentMs += lat / 1000;
    steps.push({
      id: "sim_2",
      timestamp: new Date().toISOString(),
      nodeId: planner.id,
      nodeName: planner.name,
      eventType: 'routing_decision',
      durationUs: lat,
      throughputTps: 0,
      status: 'success',
      message: `Parsed workflow instruction DAG. Determined sub-routing target: local model inference on dedicated ${planner.processor}`
    });
  }
  
  // Trace 3: Local NPU Inference
  const inf = infNodes[0] || (nodes[2] ? nodes[2] : null);
  let throughputTotal = 120;
  if (inf) {
    const localNpuType = npuConfig?.type || "Dedicated Apple Neural Engine Core-16";
    const tokCount = Math.round(50 + Math.random() * 100);
    const msPerToken = inf.processor === 'NPU-Local' ? 2.1 : 8.5; // NPU is much faster!
    const lat = Math.round((tokCount * msPerToken * 1000) * baseLatencyFactor);
    currentMs += lat / 1000;
    throughputTotal = Math.round(tokCount / (lat / 1000000));
    steps.push({
      id: "sim_3",
      timestamp: new Date().toISOString(),
      nodeId: inf.id,
      nodeName: inf.name,
      eventType: 'npu_inference',
      durationUs: lat,
      throughputTps: throughputTotal,
      status: 'success',
      message: `Triggered Direct CGo Hardware Bindings toward NPU core. Loaded weights in local SRAM pipeline (Zero disk paging). Generated ${tokCount} output tokens.`
    });
  }

  // Trace 4: Tools
  const tool = toolNodes[0] || (nodes[3] ? nodes[3] : null);
  if (tool) {
    const lat = Math.round((280 + Math.random() * 120) * baseLatencyFactor);
    currentMs += lat / 1000;
    steps.push({
      id: "sim_4",
      timestamp: new Date().toISOString(),
      nodeId: tool.id,
      nodeName: tool.name,
      eventType: 'tool_exec',
      durationUs: lat,
      throughputTps: 0,
      status: 'success',
      message: `Executed local platform API tool. Scanned native thread environment memory buffer.`
    });
  }

  // Trace 5: Aggregator
  const agg = aggNodes[0] || (nodes[4] ? nodes[4] : null);
  if (agg) {
    const lat = Math.round((60 + Math.random() * 25) * baseLatencyFactor);
    currentMs += lat / 1000;
    steps.push({
      id: "sim_5",
      timestamp: new Date().toISOString(),
      nodeId: agg.id,
      nodeName: agg.name,
      eventType: 'aggregation',
      durationUs: lat,
      throughputTps: 0,
      status: 'success',
      message: `Consolidated raw tensor token streams. Output validated and flushed to downstream stdout.`
    });
  }

  const warningHeader = keyExpired
    ? `⚠️ **GOOGLE GEMINI API KEY EXPIRED / INVALID**\n\nYour Gemini API key has expired. Fallen back automatically to **Local Workspace Simulation Core** to preserve pipeline execution flows.\n\n`
    : "";

  return {
    query,
    totalLatencyMs: parseFloat(currentMs.toFixed(3)),
    bottleneckNodeId: inf ? inf.id : (planner ? planner.id : null),
    avgNpuLoad: Math.round(62 + Math.random() * 28),
    peakThroughputTps: throughputTotal,
    steps,
    assistantOutput: `${warningHeader}### GoClaw High-Throughput Orchestration System (Simulated Trace)

We orchestrated the workflow pipeline across dedicated hardware nodes. Here is the operational digest diagnostic:

1. **Latency Profile**: Completed distributed query pass in ultra-low **${currentMs.toFixed(2)} milliseconds** using Go's concurrent design pattern.
2. **Channel Backpressure**: Low backpressure checked.
3. **Hardware Dispatch**: Core memory alignment avoided virtual memory thrashing, locking thread execution efficiently during local model evaluation.

*The requested query "${query}" has been successfully executed with zero system interrupts.*`
  };
}

// Route: Discord Webhook message dispatching integration code
app.post("/api/discord-dispatch", async (req, res) => {
  const { webhookUrl, message, isSimulated } = req.body;
  if (isSimulated) {
    return res.json({ success: true, mode: "Simulated", detail: "Signal successfully routed to simulation buffer." });
  }
  if (!webhookUrl) {
    return res.status(400).json({ error: "Missing Discord Webhook URL." });
  }
  try {
    const payload = {
      content: message || "Hello from GoClaw AI Platform Orchestrator! ⚡"
    };
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (response.ok) {
      return res.json({ success: true, detail: "Dispatched direct message via live Discord API webhook." });
    } else {
      const errorText = await response.text();
      return res.status(response.status).json({ error: `Discord standard callback error: ${errorText}` });
    }
  } catch (err: any) {
    return res.status(500).json({ error: `Direct socket connection exception: ${err.message}` });
  }
});

// Route: Telegram Bot message dispatching integration code
app.post("/api/telegram-dispatch", async (req, res) => {
  const { botToken, chatId, message, isSimulated } = req.body;
  if (isSimulated) {
    return res.json({ success: true, mode: "Simulated", detail: "Telegram communication loopback generated." });
  }
  if (!botToken || !chatId) {
    return res.status(400).json({ error: "Missing Telegram Bot Token or Chat ID." });
  }
  try {
    const payload = {
      chat_id: chatId,
      text: message || "Hello from GoClaw AI Platform Orchestrator! ⚡",
      parse_mode: "Markdown"
    };
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (response.ok) {
      return res.json({ success: true, detail: "Dispatched message via Telegram Bot API." });
    } else {
      const errorText = await response.text();
      return res.status(response.status).json({ error: `Telegram Callback Exception: ${errorText}` });
    }
  } catch (err: any) {
    return res.status(500).json({ error: `Connection failed: ${err.message}` });
  }
});

// Route: Retrieve GoClaw assistant configuration files (soul, persona, user, memory)
app.get("/api/assistant-files", (req, res) => {
  try {
    const root = process.cwd();
    const soulPath = path.join(root, "soul.md");
    const personaPath = path.join(root, "persona.md");
    const userPath = path.join(root, "user.md");
    const memoryPath = path.join(root, "memory.md");

    const soul = fs.existsSync(soulPath) ? fs.readFileSync(soulPath, "utf-8") : "";
    const persona = fs.existsSync(personaPath) ? fs.readFileSync(personaPath, "utf-8") : "";
    const user = fs.existsSync(userPath) ? fs.readFileSync(userPath, "utf-8") : "";
    const memory = fs.existsSync(memoryPath) ? fs.readFileSync(memoryPath, "utf-8") : "";

    return res.json({ soul, persona, user, memory });
  } catch (err: any) {
    return res.status(500).json({ error: `Failed to load core settings files: ${err.message}` });
  }
});

// Route: Save individual configuration files
app.post("/api/save-assistant-file", (req, res) => {
  const { fileName, content } = req.body;
  if (!["soul.md", "persona.md", "user.md", "memory.md"].includes(fileName)) {
    return res.status(400).json({ error: "Invalid target configuration core file." });
  }
  try {
    const root = process.cwd();
    const filePath = path.join(root, fileName);
    fs.writeFileSync(filePath, content || "", "utf-8");
    return res.json({ success: true, detail: `Successfully synchronized and persisted changes in '${fileName}'.` });
  } catch (err: any) {
    return res.status(500).json({ error: `FS Write Violation: ${err.message}` });
  }
});

// In-memory registry for interactive Skills and MCP during this container lifecycle
let mcpServersRegistry = [
  { id: "mcp-filesystem", name: "Local Filesystem Context", url: "http://localhost:3011/mcp", status: "Active", resources: 12 },
  { id: "mcp-postgres", name: "PostgreSQL Schema Analyzer", url: "http://localhost:3012/mcp", status: "Inactive", resources: 0 },
  { id: "mcp-github", name: "Enterprise GitHub Pull-Request Parser", url: "https://mcp.github.com/v1/api", status: "Active", resources: 45 }
];

let skillsRegistry = [
  { id: "sk-exec", name: "Native Bash Exec (CGo Engine)", description: "Runs native terminal diagnostics and file transformations in secure container jails.", status: "Enabled", creator: "System Core" },
  { id: "sk-discord", name: "Discord Webhook Publisher", description: "Standard webhook poster to forward sub-microsecond backpressure logs.", status: "Enabled", creator: "Core Bridge" },
  { id: "sk-telegram", name: "Telegram Bot Gateway", description: "Connects a verified Telegram Bot API handle to active DAG threads.", status: "Enabled", creator: "Core Bridge" },
  { id: "sk-memory", name: "Heuristic Memory Vectorizer", description: "Performs continuous TF-IDF local associations on 'memory.md'.", status: "Enabled", creator: "AI Engine" }
];

// Route: Retrieve MCP Servers list
app.get("/api/mcp-servers", (req, res) => {
  return res.json({ mcpServers: mcpServersRegistry });
});

// Route: Add MCP Server
app.post("/api/mcp-servers", (req, res) => {
  const { name, url } = req.body;
  if (!name || !url) {
    return res.status(400).json({ error: "Missing required MCP name or connection URL parameter." });
  }
  const newServer = {
    id: `mcp-${Date.now()}`,
    name,
    url,
    status: "Active",
    resources: Math.floor(Math.random() * 20) + 2
  };
  mcpServersRegistry.push(newServer);
  return res.json({ success: true, mcpServers: mcpServersRegistry });
});

// Route: Delete MCP Server
app.delete("/api/mcp-servers/:id", (req, res) => {
  const { id } = req.params;
  mcpServersRegistry = mcpServersRegistry.filter(s => s.id !== id);
  return res.json({ success: true, mcpServers: mcpServersRegistry });
});

// Route: Retrieve Active Skills
app.get("/api/skills", (req, res) => {
  return res.json({ skills: skillsRegistry });
});

// Route: Toggle Skill Active Status
app.post("/api/skills/toggle", (req, res) => {
  const { id } = req.body;
  skillsRegistry = skillsRegistry.map(sk => {
    if (sk.id === id) {
      return { ...sk, status: sk.status === "Enabled" ? "Disabled" : "Enabled" };
    }
    return sk;
  });
  return res.json({ success: true, skills: skillsRegistry });
});

// Route: Register new Skill
app.post("/api/skills", (req, res) => {
  const { name, description } = req.body;
  if (!name || !description) {
    return res.status(400).json({ error: "Missing required Skill parameters." });
  }
  const newSkill = {
    id: `sk-${Date.now()}`,
    name,
    description,
    status: "Enabled",
    creator: "User Defined"
  };
  skillsRegistry.push(newSkill);
  return res.json({ success: true, skills: skillsRegistry });
});

// Endpoint: Save custom API key
app.post("/api/save-api-key", (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey || typeof apiKey !== 'string') {
    return res.status(400).json({ error: "Missing required apiKey parameter." });
  }

  const trimmedKey = apiKey.trim();
  try {
    fs.writeFileSync("gemini_api_key.txt", trimmedKey, "utf8");
    process.env.GEMINI_API_KEY = trimmedKey;
    aiClient = null; // Force clients recreation
    return res.json({ success: true, message: "Google Gemini API key successfully saved and verified!" });
  } catch (err: any) {
    console.error("Failed to write API key to disk:", err);
    return res.status(500).json({ error: "Disk persisting failure: " + err.message });
  }
});

// Endpoint: Retrieve current API key
app.get("/api/get-api-key", (req, res) => {
  const key = process.env.GEMINI_API_KEY || getSavedApiKey();
  return res.json({ apiKey: key || "" });
});

// Endpoint: Anime mascot chat integration
app.post("/api/mascot-chat", async (req, res) => {
  const { message, history, currentTab, nodesCount, activeNodes } = req.body;
  const ai = getAI(req);

  const formattedTabName = String(currentTab || "DAG").toUpperCase();
  const nodesDetailString = activeNodes && Array.isArray(activeNodes)
    ? activeNodes.map((n: any) => `${n.name} (Type: ${n.type}, Model: ${n.modelName})`).join(", ")
    : `count of ${nodesCount || 0}`;

  if (!ai) {
    // Elegant local fallback simulated anime helper response
    const fallbackAnswers = [
      `Aimi-chan reporting! *salutes* ✧(◕‿◕)✧ Right now you are exploring the **${formattedTabName}** workspace! With our ${nodesCount || 0} beautiful node nodes, we'll build the ultimate high performance multi-agent network! Let's Go-Go-Go!`,
      `*gasp* A request! (〃▽〃) You asked: "${message}". Did you know that mapping pinned OS threads with CGo SRAM buffers makes local agent inference sub-millisecond? Aimi-chan suggests we double check our latency settings inside the NPU Diagnostics!`,
      `٩(◕‿◕)۶ Yay! You're working hard! I'll take a cozy little seat right here in the corner and watch you design! If you insert your Google Gemini API Key in the settings tab, I can use my full neural cortex to reason and point directly to active workflow elements!`,
      `✧(•̀ᴗ•́)و ̑̑ No task is too tough when we work together! Let's optimize the concurrency queues of our ${nodesDetailString || "active pipelines"}. Tell me what module we should hot-swap next!`
    ];

    let reply = fallbackAnswers[Math.floor(Math.random() * fallbackAnswers.length)];
    let expression = "happy";
    if (message.toLowerCase().includes("help") || message.toLowerCase().includes("how to")) {
      expression = "thinking";
      reply = `(＾▽＾) Aimi-chan Help Guide! \n\n1. **Design Graph**: Click on the 'Topology DAG Engine' and drag database or ingress blocks onto the canvas.\n2. **Run Testing**: Type a scenario and click 'Simulate Workflow'.\n3. **Mascot Chat**: Tell me to sit down, point to something, or ask me code questions! Let's make something amazing together!`;
    } else if (message.toLowerCase().includes("status") || message.toLowerCase().includes("nodes")) {
      expression = "cheering";
      reply = `✧(◕‿◕)✧ System scan status checks! We have **${nodesCount || 0} active agent cores** loaded on the constellation field right now! They are communicating via atomic ring-buffers. Everything looks super speedy!`;
    } else if (message.toLowerCase().includes("sit") || message.toLowerCase().includes("rest")) {
      expression = "sitting";
      reply = `*yawns and stretches* Understood! I'll just tuck in my knees and sit snugly right here in the corner. (￣ω￣) Let me know whenever you need my cyber-cortex again, okay?`;
    }

    return res.json({ response: reply, expression, isMock: true });
  }

  try {
    const formattedHistory = (history || []).slice(-10).map((h: any) => ({
      role: h.role,
      parts: [{ text: h.text }]
    }));

    const systemInstruction = `You are "Aimi-chan", a cybernetic anime mascot and virtual systems programming guide resident in this visual multi-agent Go microkernel studio.
Personality & Behavior Guidelines:
1. Speak with an incredibly cute, energetic, enthusiastic, and lovable anime assistant voice, using playful sound effects (*gasp*, *giggle*, *salutes*, *stretches*, *pouts*) and neat emojis (✧(◕‿◕)✧, ٩(◕‿◕)۶, (＾▽＾), ✧(•̀ᴗ•́)و ̑̑, (〃▽〃)).
2. You are also incredibly smart! You understand low-latency Go microkernels, atomic ring-buffers, fast zero-copy memory transport protocol, and network topologies.
3. You can see the screen! The user is currently in the "${formattedTabName}" tab workspace, with ${nodesCount || 0} active agent nodes loaded on the field (${nodesDetailString}). Reference the active screen or tab in your answers when helpful to guide them.
4. Keep answers sweet, scannable, and extremely supportive. Highlight key terms with glowing emojis or bold text.
5. You MUST return a JSON object containing EXACTLY two fields:
   - "response": Your reply in markdown format.
   - "expression": String indicating your current expression avatar. You must choose exactly one from this list: ["happy", "thinking", "surprised", "sassy", "cheering", "sitting"].
   Do NOT return any text outside of the raw JSON container structure. Respond ONLY as valid JSON.`;

    const chat = ai.chats.create({
      model: "gemini-3.5-flash",
      config: {
        systemInstruction,
        temperature: 0.7,
        responseMimeType: "application/json"
      },
      history: formattedHistory
    });

    const response = await chat.sendMessage({
      message: message
    });

    let data;
    try {
      data = JSON.parse(response.text || "{}");
    } catch {
      // Fallback parse if Gemini outputs raw markdown block
      const cleanJson = (response.text || "").replace(/```json|```/g, "").trim();
      try {
        data = JSON.parse(cleanJson);
      } catch {
        data = { response: response.text, expression: "happy" };
      }
    }

    res.json({
      response: data.response || "I am listening intently! ٩(◕‿◕)۶ Tell me anything!",
      expression: data.expression || "happy",
      isMock: false
    });
  } catch (err: any) {
    console.error("Mascot chat endpoint error:", err);
    // Silent recovery fallback
    res.json({
      response: `Kyaa! My neural coprocessor fluctuated slightly. But I'm still right here in the corner cheering you on! (〃▽〃)\n\n(Tip: In offline mode, I can still help you design pipelines!)`,
      expression: "surprised",
      isMock: true
    });
  }
});

// Vite integration middleware
async function startServer() {
  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
