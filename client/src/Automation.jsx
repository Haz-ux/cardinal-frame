import React from 'react';
import { CronLedger, SkillRegistry } from './CronSkillPanels';
import { StateViewer, ProfileCard } from './ChatComponents';

const NEON = { cyan:'#00f0ff', green:'#22c55e', purple:'#a855f7' };

export default function Automation() {
 return (
 <div className="space-y-6 p-1">
  {/* Cron Ledger */}
  <CronLedger />

  {/* Skill Registry */}
  <SkillRegistry />

  {/* State Viewer + Profile side by side */}
  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
  <div>
  <div className="flex items-center gap-2 mb-2">
  <span className="text-xs font-bold tracking-wider uppercase" style={{ color: '#888' }}>Active State</span>
  </div>
  <StateViewer />
  </div>
  <div>
  <div className="flex items-center gap-2 mb-2">
  <span className="text-xs font-bold tracking-wider uppercase" style={{ color: '#888' }}>User Profile</span>
  </div>
  <ProfileCard />
  </div>
  </div>
 </div>
 );
}
