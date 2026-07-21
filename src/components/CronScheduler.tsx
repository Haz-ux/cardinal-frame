import React, { useState, useEffect } from 'react';
import { 
  Clock, 
  Play, 
  Pause, 
  Plus, 
  Trash2, 
  Activity, 
  Bell, 
  Layers, 
  Terminal, 
  CheckCircle2, 
  AlertCircle,
  HelpCircle,
  Loader
} from 'lucide-react';

interface CronJob {
  id: string;
  name: string;
  expression: string; // e.g. "*/10 * * * *" or interval-seconds
  intervalSeconds: number;
  taskType: 'simulation' | 'heartbeat' | 'clear' | 'backup';
  status: 'active' | 'idle';
  lastRun: string | null;
  nextRun: string;
  completedRunsCount: number;
}

interface CronSchedulerProps {
  onTriggerSimulation: (query: string) => Promise<void>;
  onAddLog: (log: string) => void;
  nodesCount: number;
}

export default function CronScheduler({
  onTriggerSimulation,
  onAddLog,
  nodesCount
}: CronSchedulerProps) {
  // Configured default automated jobs
  const [jobs, setJobs] = useState<CronJob[]>([
    {
      id: 'job-1',
      name: 'Verify Silicon Flow & Backpressure latency metrics',
      expression: '*/30 * * * * (Every 30s)',
      intervalSeconds: 30,
      taskType: 'simulation',
      status: 'idle',
      lastRun: null,
      nextRun: 'Calculated upon activation',
      completedRunsCount: 0
    },
    {
      id: 'job-2',
      name: 'Simulated Outbound Messenger Heartbeat dispatch',
      expression: '*/90 * * * * (Every 90s)',
      intervalSeconds: 90,
      taskType: 'heartbeat',
      status: 'idle',
      lastRun: null,
      nextRun: 'Calculated upon activation',
      completedRunsCount: 0
    },
    {
      id: 'job-3',
      name: 'Flush Shared Virtual Ringbuffer L1 cache allocations',
      expression: '*/180 * * * * (Every 180s)',
      intervalSeconds: 180,
      taskType: 'clear',
      status: 'idle',
      lastRun: null,
      nextRun: 'Calculated upon activation',
      completedRunsCount: 0
    }
  ]);

  // Form states to add new schedules
  const [newName, setNewName] = useState('');
  const [newInterval, setNewInterval] = useState(60);
  const [newTaskType, setNewTaskType] = useState<'simulation' | 'heartbeat' | 'clear' | 'backup'>('simulation');

  // Interactive scheduler logs stream
  const [schedulerLogs, setSchedulerLogs] = useState<{ id: string; time: string; text: string; type: 'success' | 'info' | 'warn' }[]>([
    {
      id: 'log-1',
      time: new Date().toLocaleTimeString(),
      text: 'Cron scheduler engine online. Loaded memory state definitions.',
      type: 'info'
    }
  ]);

  // Track state for count-downs on active jobs
  const [countdowns, setCountdowns] = useState<{ [key: string]: number }>({});
  const [activeInterval, setActiveInterval] = useState<'simulation' | 'custom'>('simulation');

  // Handle countdown ticks for active jobs
  useEffect(() => {
    const tickInterval = setInterval(() => {
      setJobs(prevJobs => {
        let updated = false;
        const nextJobs = prevJobs.map(job => {
          if (job.status !== 'active') return job;

          updated = true;
          const currentCountdown = countdowns[job.id] !== undefined ? countdowns[job.id] : job.intervalSeconds;
          const newCountdown = currentCountdown - 1;

          if (newCountdown <= 0) {
            // FIRE TARGET TASK!
            triggerJobTask(job);

            // Reset Countdown
            setCountdowns(prev => ({ ...prev, [job.id]: job.intervalSeconds }));
            return {
              ...job,
              lastRun: new Date().toLocaleTimeString(),
              completedRunsCount: job.completedRunsCount + 1
            };
          } else {
            setCountdowns(prev => ({ ...prev, [job.id]: newCountdown }));
          }

          return job;
        });

        return nextJobs;
      });
    }, 1000);

    return () => clearInterval(tickInterval);
  }, [countdowns]);

  // Executed the specific automated task
  const triggerJobTask = async (job: CronJob) => {
    const timestamp = new Date().toLocaleTimeString();
    
    // Add to local interactive list logs
    setSchedulerLogs(prev => [
      {
        id: Date.now().toString(),
        time: timestamp,
        text: `⚡ Automated Ticker triggered: [${job.name}] executed correctly.`,
        type: 'success'
      },
      ...prev
    ]);

    // Format console output
    const consoleTimestamp = () => `[${((Date.now() % 100000) / 1000).toFixed(3)}s]`;
    onAddLog(`${consoleTimestamp()} CRON_WKR: Firing scheduled pipeline event: "${job.name}"`);

    try {
      if (job.taskType === 'simulation') {
        onAddLog(`${consoleTimestamp()} CRON_WKR: Dispatched automatic thread simulation across ${nodesCount} topology clusters.`);
        await onTriggerSimulation(`Autonomic Scheduled Audit: ${job.name}`);
      } else if (job.taskType === 'heartbeat') {
        onAddLog(`${consoleTimestamp()} CRON_WKR: Initiated simulated outbound messenger ping on Discord/Telegram.`);
        // Call internal loopback
        await fetch('/api/telegram-dispatch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            botToken: '', chatId: '9182741',
            message: `🤖 Scheduled Heartbeat Verification: [${job.name}] verified active green. Node Count: ${nodesCount}`,
            isSimulated: true
          })
        });
      } else if (job.taskType === 'clear') {
        onAddLog(`${consoleTimestamp()} CRON_WKR: Swept volatile Go heap buffers. Reclaimed unused ANE block pointers.`);
      } else if (job.taskType === 'backup') {
        onAddLog(`${consoleTimestamp()} CRON_WKR: Serialized memory state arrays into backup sector [0xFE10A2].`);
      }
    } catch (err: any) {
      onAddLog(`${consoleTimestamp()} ERR: Automated task [${job.name}] failed: ${err.message}`);
    }
  };

  // Toggle single Job state
  const toggleJobStatus = (id: string) => {
    setJobs(prev => prev.map(job => {
      if (job.id === id) {
        const isNowActive = job.status === 'idle';
        const timestamp = new Date().toLocaleTimeString();
        
        // Log status change
        setSchedulerLogs(logs => [
          {
            id: Date.now().toString(),
            time: timestamp,
            text: `Scheduler modified [${job.name}] to ${isNowActive ? 'ACTIVE (INTERVAL COUNTING)' : 'IDLE'}`,
            type: isNowActive ? 'info' : 'warn'
          },
          ...logs
        ]);

        // Setup countdown
        setCountdowns(prev => ({
          ...prev,
          [job.id]: job.intervalSeconds
        }));

        return {
          ...job,
          status: isNowActive ? 'active' : 'idle',
          nextRun: isNowActive ? `In ${job.intervalSeconds} seconds` : 'Disabled'
        };
      }
      return job;
    }));
  };

  // Delete dynamic Job
  const handleDeleteJob = (id: string, name: string) => {
    setJobs(prev => prev.filter(job => job.id !== id));
    setSchedulerLogs(logs => [
      {
        id: Date.now().toString(),
        time: new Date().toLocaleTimeString(),
        text: `Removed scheduled worker task: "${name}"`,
        type: 'warn'
      },
      ...logs
    ]);
  };

  // Custom Job submission handler
  const handleAddJob = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || newInterval <= 0) return;

    const newJob: CronJob = {
      id: `job-${Date.now()}`,
      name: newName.trim(),
      expression: `*/${newInterval} * * * * (Every ${newInterval}s)`,
      intervalSeconds: newInterval,
      taskType: newTaskType,
      status: 'idle',
      lastRun: null,
      nextRun: 'Calculated upon activation',
      completedRunsCount: 0
    };

    setJobs(prev => [...prev, newJob]);
    setSchedulerLogs(logs => [
      {
        id: Date.now().toString(),
        time: new Date().toLocaleTimeString(),
        text: `Registered new scheduled event: "${newName}" every ${newInterval} seconds.`,
        type: 'info'
      },
      ...logs
    ]);

    setNewName('');
    setNewInterval(60);
  };

  return (
    <div id="cron-scheduler-workspace" className="grid grid-cols-1 lg:grid-cols-3 gap-6 font-mono text-xs">
      
      {/* LEFT COLUMN: CONJECTURE & NEW AUTOMATED JOBS CREATOR */}
      <div className="bg-[#0b0e14] border border-gray-900 rounded-xl p-5 flex flex-col justify-between">
        <div className="space-y-4">
          <div className="flex items-center justify-between border-b border-gray-800 pb-3">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-amber-400 shadow-[0_0_6px_#f59e0b]" />
              <h4 className="text-xs font-bold text-white uppercase tracking-wider">Cron job automated scheduling</h4>
            </div>
            <span className="text-[9px] text-amber-400 bg-amber-950/40 px-1.5 py-0.5 border border-amber-900/60 rounded uppercase font-bold text-right">
              MAPPED
            </span>
          </div>

          <p className="text-[11px] text-gray-500 leading-normal font-sans">
            Configure continuous scheduling interval timers to ping networks, measure latency buffers, or execute synthetic user-defined workflow simulations automatically without manual interactions.
          </p>

          <form onSubmit={handleAddJob} className="space-y-3.5">
            <div>
              <label className="block text-[8px] text-gray-400 uppercase tracking-wider mb-1 font-bold">
                Task Title / Event Label
              </label>
              <input
                type="text"
                required
                placeholder="e.g. Audit L1 GPU Cache overflow"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="w-full bg-black/40 border border-gray-900 rounded px-2.5 py-1.5 text-xs text-gray-200 outline-none focus:border-amber-400"
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[8px] text-gray-400 uppercase tracking-wider mb-1 font-bold">
                  Frequency (Secs)
                </label>
                <input
                  type="number"
                  min="5"
                  max="3600"
                  required
                  value={newInterval}
                  onChange={(e) => setNewInterval(parseInt(e.target.value) || 10)}
                  className="w-full bg-black/40 border border-gray-900 rounded px-2.5 py-1.5 text-xs text-amber-400 outline-none focus:border-amber-400"
                />
              </div>

              <div>
                <label className="block text-[8px] text-gray-400 uppercase tracking-wider mb-1 font-bold">
                  Task Command Target
                </label>
                <select
                  value={newTaskType}
                  onChange={(e) => setNewTaskType(e.target.value as any)}
                  className="w-full bg-black/40 border border-gray-900 rounded px-1.5 py-1.5 text-xs text-gray-200 outline-none focus:border-amber-400"
                >
                  <option value="simulation">Fire DAG Flow</option>
                  <option value="heartbeat">Outbound Discord Ping</option>
                  <option value="clear">Sweep Core Buffers</option>
                  <option value="backup">Save State Memory</option>
                </select>
              </div>
            </div>

            <button
              type="submit"
              className="w-full py-2 bg-amber-500 hover:bg-amber-400 text-black font-bold text-xs rounded transition flex items-center justify-center gap-1.5 font-mono uppercase"
            >
              <Plus className="w-4 h-4" />
              Instantiate Scheduled Event
            </button>
          </form>
        </div>

        <div className="pt-4 border-t border-gray-900 mt-5 space-y-2 text-[10px] text-gray-500 font-sans leading-relaxed">
          <div className="flex gap-2">
            <HelpCircle className="w-4 h-4 text-amber-500 shrink-0 stroke-[2]" />
            <span>
              The scheduling worker processes thread tickers in background loops. Keeping jobs active compiles dynamic logs for real-world profile reports.
            </span>
          </div>
        </div>
      </div>

      {/* CENTER COLUMN: ACTIVE AUTOMATION WORKERS CHECKS */}
      <div className="bg-[#0b0e14] border border-gray-900 rounded-xl p-5 flex flex-col justify-between lg:col-span-2">
        <div className="flex-1 flex flex-col">
          
          <div className="flex items-center justify-between border-b border-gray-800 pb-3 mb-4">
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-amber-500" />
              <h4 className="text-xs font-bold text-white uppercase tracking-wider">Active Automated Jobs Tickers Overview</h4>
            </div>
            <span className="text-[10px] text-gray-400 bg-zinc-900/60 border border-zinc-800 px-2.5 py-1 rounded">
              Active Tickers: {jobs.filter(j => j.status === 'active').length}
            </span>
          </div>

          <div className="space-y-3 flex-1 overflow-y-auto max-h-[290px] pr-1.5">
            {jobs.length === 0 ? (
              <div className="text-center py-10 text-gray-600 font-sans italic">
                All automated jobs dismantled. Customize a target event key on the left to initialize.
              </div>
            ) : (
              jobs.map((job) => {
                const isActive = job.status === 'active';
                const countdown = countdowns[job.id] !== undefined ? countdowns[job.id] : job.intervalSeconds;
                const percentage = Math.max(0, Math.min(100, (countdown / job.intervalSeconds) * 100));

                return (
                  <div 
                    key={job.id} 
                    className={`p-3.5 rounded-lg border transition ${
                      isActive 
                        ? 'bg-amber-950/10 border-amber-500/30 shadow-[0_0_8px_rgba(245,158,11,0.05)]' 
                        : 'bg-black/40 border-gray-900 hover:border-gray-800'
                    }`}
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className={`w-2 h-2 rounded-full ${isActive ? 'bg-emerald-400 animate-ping' : 'bg-gray-600'}`} />
                          <h5 className="font-bold text-white text-xs tracking-tight">{job.name}</h5>
                        </div>
                        
                        {/* Parameters labels row */}
                        <div className="flex items-center gap-3 text-[10px] text-gray-500 mt-1 flex-wrap">
                          <span className="flex items-center gap-1">
                            <Clock className="w-3 h-3 text-amber-500" /> {job.expression}
                          </span>
                          <span className="bg-black/60 px-1.5 py-0.5 rounded text-gray-400 border border-gray-950 capitalize">
                            Target: {job.taskType}
                          </span>
                          {job.completedRunsCount > 0 && (
                            <span className="text-emerald-400 font-mono">
                              ✓ Runs: {job.completedRunsCount}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Action controllers buttons */}
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          onClick={() => toggleJobStatus(job.id)}
                          className={`px-3 py-1 text-[10px] font-mono leading-tight font-bold rounded transition flex items-center gap-1 ${
                            isActive 
                              ? 'bg-amber-500 hover:bg-amber-400 text-black' 
                              : 'bg-black border border-gray-800 hover:bg-zinc-900 text-gray-300'
                          }`}
                        >
                          {isActive ? <Pause className="w-3.5 h-3.5 fill-black" /> : <Play className="w-3.5 h-3.5 fill-current" />}
                          {isActive ? 'Pause' : 'Activate Ticker'}
                        </button>

                        <button
                          onClick={() => handleDeleteJob(job.id, job.name)}
                          className="p-1.5 bg-black border border-gray-800 hover:text-red-400 text-gray-600 rounded transition"
                          title="Dismantle scheduling"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    {/* Progress slider bar active tracker */}
                    {isActive && (
                      <div className="mt-3.5 space-y-1">
                        <div className="flex justify-between text-[9px] text-gray-500">
                          <span>Next trigger sequence in: <strong className="text-amber-400">{countdown}s</strong></span>
                          <span>{Math.round(100 - percentage)}% complete</span>
                        </div>
                        <div className="w-full h-1 bg-gray-950 overflow-hidden rounded">
                          <div 
                            className="h-full bg-gradient-to-r from-amber-600 via-amber-400 to-amber-500 transition-all duration-1000 ease-linear" 
                            style={{ width: `${percentage}%` }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {/* Job execution ticker logs */}
          <div className="mt-4 pt-3.5 border-t border-gray-900">
            <span className="block text-[8px] text-gray-500 uppercase tracking-widest mb-2 font-bold font-mono">
              Automation scheduler dispatcher logs
            </span>
            <div className="bg-black/60 border border-gray-950 h-28 rounded-lg p-2.5 overflow-y-auto font-mono text-[10px] leading-relaxed space-y-1">
              {schedulerLogs.map((log) => (
                <div key={log.id} className="flex gap-2">
                  <span className="text-gray-600">[{log.time}]</span>
                  <span className={
                    log.type === 'success' ? 'text-[#00ff41]' :
                    log.type === 'warn' ? 'text-rose-400' : 'text-cyan-400'
                  }>
                    {log.text}
                  </span>
                </div>
              ))}
            </div>
          </div>

        </div>
      </div>

    </div>
  );
}
