import React from 'react';
import { CronLedger, SkillRegistry } from './CronSkillPanels';
import { ProfileCard } from './ChatComponents';

const NEON = { cyan:'#00f0ff', green:'#22c55e', purple:'#a855f7' };

export default function Automation() {
 return (
 <div className="space-y-6 p-1">
  {/* Cron Ledger */}
  <CronLedger />

  {/* Skill Registry */}
  <SkillRegistry />

  {/* User Profile */}
  <div>
  <div className="flex items-center gap-2 mb-2">
  <span className="text-xs font-bold tracking-wider uppercase" style={{ color: '#888' }}>User Profile</span>
  </div>
  <ProfileCard />
  </div>
 </div>
 );
}
