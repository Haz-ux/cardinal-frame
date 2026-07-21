import React, { useState, useEffect, useRef } from 'react';
import { 
  MessageSquare, 
  Send, 
  Sparkles, 
  RefreshCw, 
  Zap, 
  Cpu, 
  CornerDownLeft, 
  Terminal,
  FileText,
  Copy,
  Check
} from 'lucide-react';

interface Message {
  role: 'user' | 'model';
  text: string;
  isMock?: boolean;
  timestamp: string;
}

interface WorkspaceAiChatProps {
  nodesCount: number;
  onAddLog: (log: string) => void;
}

const quickChips = [
  { label: "Optimize DAG Latency", query: "How do I optimize the latency of my multi-agent DAG pipeline? Give me concrete struct suggestions." },
  { label: "NPU SRAM Allocation", query: "Explain how memory-mapped SRAM registers are allocated using CGo bindings on Apple NE or Snapdragon accelerators." },
  { label: "GitNexus Synapse Map", query: "How does the GitNexus visual Synapse Workspace sync source code with local emulated Docker contexts?" },
  { label: "Go LockOSThread Spec", query: "Why does pinning execution threads (runtime.LockOSThread) benefit low-overhead inference loops in Go systems?" }
];

export default function WorkspaceAiChat({ nodesCount, onAddLog }: WorkspaceAiChatProps) {
  const [messages, setMessages] = useState<Message[]>([
    {
      role: 'model',
      text: `Greetings, Operator. I am the **Cardinal Frame Systems Architect AI**. \n\nI have scanned your local workspace environments and established an active link to your direct model registry directory.\n\nYour orchestration has **${nodesCount} agent nodes** queued in active context. Talk directly to me to write high-throughput CGo logic, configure low-latency ring buffers, or adjust NPU clock speeds. How shall we calibrate today?`,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }
  ]);
  
  const [inputText, setInputText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Auto scroll logic
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isSending]);

  const handleSendMessage = async (textToSend: string) => {
    if (!textToSend.trim() || isSending) return;

    const userMsg: Message = {
      role: 'user',
      text: textToSend,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    setMessages(prev => [...prev, userMsg]);
    setInputText('');
    setIsSending(true);
    
    // Add terminal log trace
    onAddLog(`[${((Date.now() % 100000) / 1000).toFixed(3)}s] CHAT: Transmitted direct query to AI systems architect: "${textToSend.substring(0, 45)}..."`);

    try {
      const chatHistory = messages.map(m => ({
        role: m.role === 'user' ? 'user' : 'model',
        text: m.text
      }));

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          message: textToSend,
          history: chatHistory,
          nodesCount: nodesCount
        })
      });

      if (res.ok) {
        const data = await res.json();
        const modelMsg: Message = {
          role: 'model',
          text: data.response || "No reply byte received from master socket.",
          isMock: !!data.isMock,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };
        setMessages(prev => [...prev, modelMsg]);
        onAddLog(`[${((Date.now() % 100000) / 1000).toFixed(3)}s] CHAT: Received dynamic frame response from AI.`);
      } else {
        throw new Error(`API returned error code ${res.status}`);
      }
    } catch (err: any) {
      const errorMsg: Message = {
        role: 'model',
        text: `⚠️ **API LINK EXCEPTION**\n\nFailed to establish stable channel with core reasoning node.\nReason: **${err.message || 'Unknown network interrupt'}**.\n\n*Ensure your microservice express server is running and your Gemini API Credentials are configured properly.*`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };
      setMessages(prev => [...prev, errorMsg]);
    } finally {
      setIsSending(false);
    }
  };

  const handleCopyText = (text: string, index: number) => {
    navigator.clipboard.writeText(text);
    setCopiedId(index);
    setTimeout(() => setCopiedId(null), 2000);
  };

  // Simple formatter to helper style code snippets and markdown text blocks in UI cleanly
  const formatText = (raw: string) => {
    return raw.split('\n').map((line, idx) => {
      // Check for headings
      if (line.startsWith('### ')) {
        return <h4 key={idx} className="text-white font-bold text-xs mt-3 mb-1.5 uppercase tracking-wider text-cyan-400">{line.replace('### ', '')}</h4>;
      }
      if (line.startsWith('## ')) {
        return <h3 key={idx} className="text-white font-black text-xs mt-4 mb-2 uppercase tracking-wide border-b border-zinc-900 pb-1 text-emerald-400">{line.replace('## ', '')}</h3>;
      }
      if (line.startsWith('# ')) {
        return <h2 key={idx} className="text-white font-black text-sm mt-5 mb-2 uppercase tracking-widest text-[#00ff41]">{line.replace('# ', '')}</h2>;
      }
      
      // Check for code block wrappers
      if (line.trim().startsWith('```')) {
        return null; // Handle separately or skip block tags in simplified parser
      }

      // Format bold elements
      let renderedLine: React.ReactNode = line;
      if (line.includes('**')) {
        const parts = line.split('**');
        renderedLine = parts.map((part, pidx) => pidx % 2 === 1 ? <strong key={pidx} className="text-[#00ff41] font-bold">{part}</strong> : part);
      }

      return (
        <p key={idx} className="min-h-[1.2em] mb-1 font-sans text-gray-350 text-[11px] leading-relaxed">
          {renderedLine}
        </p>
      );
    });
  };

  return (
    <div id="workspace-ai-chat-interface" className="flex flex-col h-[520px] bg-[#0a0d14]/80 border border-gray-950 rounded-2xl overflow-hidden shadow-2xl relative">
      
      {/* Top Telemetry Header Bar */}
      <div className="px-4 py-3 bg-[#0d0f14]/90 border-b border-zinc-950 flex items-center justify-between shrink-0 select-none">
        <div className="flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-[#00ff41] animate-pulse" />
          <div>
            <span className="text-[9px] text-[#00ff41] font-extrabold uppercase tracking-widest block font-mono">NEURAL_ORACLE_CHAT</span>
            <span className="text-[8px] text-gray-500 block">CARDINAL COMPILER REASONING ENGINE // LATENCY: SUB-5MS</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 text-[8px] bg-emerald-950/60 text-emerald-400 px-2 py-0.5 rounded border border-emerald-900/40">
            <span className="w-1 h-1 rounded-full bg-[#00ff41] animate-ping" />
            DIRECT LINK
          </div>
          <button 
            onClick={() => {
              setMessages([
                {
                  role: 'model',
                  text: "System pipeline flushed successfully. AI Architect sequence rebooted. How can I assist you in Go systems development?",
                  timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                }
              ]);
            }}
            className="p-1 hover:text-white text-gray-500 transition cursor-pointer"
            title="Flush chat history"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Primary Conversation Stream */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-black/45 scrollbar-thin">
        {messages.map((m, index) => {
          const isModel = m.role === 'model';
          return (
            <div 
              key={index}
              className={`flex items-start gap-3 max-w-[85%] md:max-w-[75%] transition duration-150 ${
                isModel ? 'self-start' : 'ml-auto flex-row-reverse'
              }`}
            >
              {/* Avatar block */}
              <div className={`p-1.5 rounded-lg border shrink-0 text-center select-none ${
                isModel 
                  ? 'bg-emerald-950/25 border-[#00ff41]/20 text-[#00ff41]' 
                  : 'bg-zinc-950 border-zinc-800 text-cyan-400'
              }`}>
                {isModel ? <Cpu className="w-3.5 h-3.5 animate-pulse" /> : <Terminal className="w-3.5 h-3.5" />}
              </div>

              {/* Text Bubble Card */}
              <div className="space-y-1 group relative">
                <div className={`p-3 rounded-2xl text-[11px] leading-relaxed relative ${
                  isModel 
                    ? 'bg-[#0f121a] border border-zinc-900 text-gray-300 rounded-tl-none' 
                    : 'bg-[#181d2a] border border-cyan-950/50 text-white rounded-tr-none'
                }`}>
                  {formatText(m.text)}

                  {/* Mock status indicator */}
                  {isModel && m.isMock && (
                    <div className="mt-2 pt-1 border-t border-zinc-900/60 flex items-center justify-between text-[7.5px] text-amber-500 font-mono select-none">
                      <span>● Running in Local Heuristics Fallback</span>
                      <span className="text-gray-600">Sync Gemini Key to activate Deep Reasoning</span>
                    </div>
                  )}
                </div>

                {/* Metadata details line */}
                <div className={`flex items-center gap-2 text-[8px] text-gray-500 px-1 font-mono select-none ${
                  isModel ? 'justify-start' : 'justify-end'
                }`}>
                  <span>{isModel ? "Cardinal_v1.0" : "Operator"}</span>
                  <span>•</span>
                  <span>{m.timestamp}</span>

                  {isModel && (
                    <button 
                      onClick={() => handleCopyText(m.text, index)}
                      className="opacity-0 group-hover:opacity-100 p-0.5 hover:text-white transition duration-150 cursor-pointer ml-1"
                      title="Copy message bytes to clipboard"
                    >
                      {copiedId === index ? <Check className="w-2.5 h-2.5 text-emerald-400" /> : <Copy className="w-2.5 h-2.5" />}
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}

        {isSending && (
          <div className="flex items-start gap-3 max-w-[70%] text-left">
            <div className="p-1.5 rounded-lg bg-emerald-950/20 border border-[#00ff41]/20 text-[#00ff41] shrink-0">
              <Sparkles className="w-3.5 h-3.5 animate-spin" />
            </div>
            <div className="bg-[#0f121a] border border-zinc-900 p-3 rounded-2xl rounded-tl-none text-[10px] text-gray-500 font-mono animate-pulse">
              <span>Transmitting neural impulses down network fiber...</span>
            </div>
          </div>
        )}

        <div ref={chatEndRef} />
      </div>

      {/* Cybernetic Presets Triggers Bar */}
      <div className="px-4 py-2 bg-[#090b10] border-t border-zinc-950 select-none overflow-x-auto whitespace-nowrap scrollbar-none flex gap-1.5 shrink-0">
        {quickChips.map((chip, idx) => (
          <button
            key={idx}
            onClick={() => handleSendMessage(chip.query)}
            disabled={isSending}
            className="px-2.5 py-1.5 bg-black hover:bg-zinc-900 border border-zinc-900 text-[#00ff41] hover:text-[#00ff41]/80 rounded-md text-[9px] font-mono transition duration-150 uppercase tracking-tight cursor-pointer inline-flex items-center gap-1 shadow-sm disabled:opacity-50"
          >
            <Zap className="w-2.5 h-2.5 fill-current shrink-0" />
            {chip.label}
          </button>
        ))}
      </div>

      {/* Low-Latency Send Form Drawer */}
      <div className="p-3 bg-[#0d0f14] border-t border-zinc-950 shrink-0">
        <form 
          onSubmit={(e) => {
            e.preventDefault();
            handleSendMessage(inputText);
          }}
          className="flex gap-2 bg-black border border-zinc-900 focus-within:border-[#00ff41] rounded-xl p-1.5 transition duration-150"
        >
          <input
            type="text"
            placeholder="Address the Cardinal Architect subagents directly..."
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            disabled={isSending}
            className="flex-1 bg-transparent px-2 text-xs text-gray-200 outline-none font-mono"
          />
          <button
            type="submit"
            disabled={!inputText.trim() || isSending}
            className="p-2 bg-[#00ff41] disabled:bg-zinc-900 shadow-lg text-black disabled:text-gray-500 rounded-lg transition duration-200 flex items-center justify-center cursor-pointer shrink-0"
            title="Transmit parameters"
          >
            <Send className="w-3.5 h-3.5" />
          </button>
        </form>
      </div>
      
    </div>
  );
}
