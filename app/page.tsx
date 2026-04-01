"use client";

import { useState, useMemo, useEffect, useCallback } from "react";
import farmData from "@/data/farm.json";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Player = Record<string, any>;
type Overview = {
  level: string;
  hitters: number;
  pitchers: number;
  avgPotBat: number | null;
  avgPotPit: number | null;
  bestBat: string | null;
  bestPit: string | null;
};

const data = farmData as {
  levels: string[];
  hitters: Player[];
  pitchers: Player[];
  overview: Overview[];
};

function playerKey(p: Player): string {
  return `${p.Name}|${p.Level}|${p.POS}|${p.Age}`;
}

function useCutSet() {
  const [cuts, setCuts] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("ootp-cuts");
      if (saved) setCuts(new Set(JSON.parse(saved)));
    } catch { /* noop */ }
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (loaded) {
      localStorage.setItem("ootp-cuts", JSON.stringify(Array.from(cuts)));
    }
  }, [cuts, loaded]);

  const toggle = useCallback((key: string) => {
    setCuts((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const clearAll = useCallback(() => setCuts(new Set()), []);

  return { cuts, toggle, clearAll, count: cuts.size };
}

// ════════════════════════════════════════════════════════════
// ALGO ENGINE — optimal roster construction benchmarks
// ════════════════════════════════════════════════════════════

// Target roster sizes per level
const ROSTER_TARGETS: Record<string, { min: number; max: number; ideal: number }> = {
  "AAA":         { min: 25, max: 30, ideal: 28 },
  "AA":          { min: 25, max: 30, ideal: 28 },
  "High-A":      { min: 25, max: 30, ideal: 28 },
  "Low-A":       { min: 25, max: 32, ideal: 30 },
  "Rookie-ACL":  { min: 28, max: 38, ideal: 35 },
  "Rookie-DSL":  { min: 28, max: 40, ideal: 35 },
  "Rookie-DSL1": { min: 28, max: 40, ideal: 35 },
  "Rookie-DSL2": { min: 28, max: 40, ideal: 35 },
};

// Ideal position counts per level: [min, ideal, max]
const POS_TARGETS: Record<string, [number, number, number]> = {
  "C":  [2, 2, 3],
  "1B": [1, 1, 2],
  "2B": [1, 1, 2],
  "SS": [1, 1, 2],
  "3B": [1, 1, 2],
  "LF": [1, 1, 2],
  "CF": [1, 1, 2],
  "RF": [1, 1, 2],
  "SP": [4, 5, 6],
  "RP": [4, 6, 8],
  "CL": [0, 1, 2],
};

// Max age before player is "too old" for a level
const AGE_CAPS: Record<string, number> = {
  "Rookie-DSL":  21, "Rookie-DSL1": 21, "Rookie-DSL2": 21,
  "Rookie-ACL":  22,
  "Low-A":       23,
  "High-A":      25,
  "AA":          27,
  "AAA":         99,
};

// Ideal age ranges per level [young, old] — within this = on-track
const AGE_IDEAL: Record<string, [number, number]> = {
  "Rookie-DSL":  [17, 19], "Rookie-DSL1": [17, 19], "Rookie-DSL2": [17, 19],
  "Rookie-ACL":  [18, 21],
  "Low-A":       [19, 22],
  "High-A":      [20, 23],
  "AA":          [21, 25],
  "AAA":         [23, 28],
};

// Minimum POT worth keeping at each level
const POT_FLOOR: Record<string, number> = {
  "Rookie-DSL": 25, "Rookie-DSL1": 25, "Rookie-DSL2": 25,
  "Rookie-ACL": 30,
  "Low-A":      30,
  "High-A":     35,
  "AA":         35,
  "AAA":        40,
};

type Flag = {
  type: "critical" | "warning" | "info" | "good";
  tag: string;
  msg: string;
};

type PlayerWithFlags = Player & { flags: Flag[] };

type PosCount = { pos: string; count: number; target: [number, number, number]; names: string[] };

type LevelAnalysis = {
  level: string;
  grade: string;
  gradeColor: string;
  totalPlayers: number;
  rosterTarget: { min: number; max: number; ideal: number };
  hitters: PlayerWithFlags[];
  pitchers: PlayerWithFlags[];
  positionCounts: PosCount[];
  flags: Flag[];
  cutList: PlayerWithFlags[];
  promoteCandidates: PlayerWithFlags[];
};

function analyzeOrg(hitters: Player[], pitchers: Player[]): {
  levels: LevelAnalysis[];
  orgGrade: string;
  orgGradeColor: string;
  orgFlags: Flag[];
  cutList: PlayerWithFlags[];
  promoteCandidates: PlayerWithFlags[];
  gaps: { level: string; pos: string }[];
} {
  const allLevels = ["Rookie-DSL1", "Rookie-DSL2", "Rookie-DSL", "Rookie-ACL", "Low-A", "High-A", "AA", "AAA"];
  const activeLevels = allLevels.filter(
    (l) => hitters.some((p) => p.Level === l) || pitchers.some((p) => p.Level === l)
  );

  const levels: LevelAnalysis[] = [];
  const allCuts: PlayerWithFlags[] = [];
  const allPromotes: PlayerWithFlags[] = [];
  const allGaps: { level: string; pos: string }[] = [];

  for (const level of activeLevels) {
    const lvlHitters = hitters.filter((p) => p.Level === level);
    const lvlPitchers = pitchers.filter((p) => p.Level === level);
    const allPlayers = [...lvlHitters, ...lvlPitchers];
    const total = allPlayers.length;
    const target = ROSTER_TARGETS[level] || { min: 25, max: 35, ideal: 30 };
    const flags: Flag[] = [];

    // — Roster size check —
    if (total > target.max) {
      flags.push({
        type: "critical",
        tag: "BLOATED",
        msg: `${total} players (target ${target.min}-${target.max}) — playing time will suffer, development stalls`,
      });
    } else if (total < target.min) {
      flags.push({
        type: "warning",
        tag: "THIN",
        msg: `Only ${total} players (target ${target.min}-${target.max}) — not enough depth for injuries/callups`,
      });
    } else {
      flags.push({
        type: "good",
        tag: "ROSTER OK",
        msg: `${total} players (target ${target.min}-${target.max})`,
      });
    }

    // — Position depth —
    const positionCounts: PosCount[] = [];
    const allPositions = ["C", "1B", "2B", "SS", "3B", "LF", "CF", "RF", "SP", "RP", "CL"];

    for (const pos of allPositions) {
      const playersAtPos = allPlayers.filter((p) => p.POS === pos);
      const tgt = POS_TARGETS[pos] || [1, 1, 2];
      positionCounts.push({
        pos,
        count: playersAtPos.length,
        target: tgt,
        names: playersAtPos.map((p) => p.Name as string),
      });

      if (playersAtPos.length === 0 && tgt[0] > 0) {
        flags.push({ type: "critical", tag: `NO ${pos}`, msg: `No ${pos} on roster — need ${tgt[1]}` });
        allGaps.push({ level, pos });
      } else if (playersAtPos.length < tgt[0]) {
        flags.push({ type: "warning", tag: `LOW ${pos}`, msg: `Only ${playersAtPos.length} ${pos} (need ${tgt[0]}-${tgt[1]})` });
        allGaps.push({ level, pos });
      } else if (playersAtPos.length > tgt[2]) {
        const logjam = playersAtPos.length - tgt[2];
        flags.push({
          type: "warning",
          tag: `${pos} LOGJAM`,
          msg: `${playersAtPos.length} ${pos} (max ${tgt[2]}) — ${logjam} player${logjam > 1 ? "s" : ""} blocked from playing time`,
        });
      }
    }

    // — Per-player flags —
    const flaggedHitters: PlayerWithFlags[] = lvlHitters.map((p) => ({ ...p, flags: flagPlayer(p, level) }));
    const flaggedPitchers: PlayerWithFlags[] = lvlPitchers.map((p) => ({ ...p, flags: flagPlayer(p, level) }));

    // — Cut list —
    const cutList = [...flaggedHitters, ...flaggedPitchers].filter(
      (p) => p.flags.some((f) => f.tag === "CUT" || f.tag === "STRONG CUT")
    );
    allCuts.push(...cutList);

    // — Promote candidates —
    const promotes = [...flaggedHitters, ...flaggedPitchers].filter(
      (p) => p.flags.some((f) => f.tag === "PROMOTE")
    );
    allPromotes.push(...promotes);

    // — Pitching ratio check —
    const spCount = lvlPitchers.filter((p) => p.POS === "SP").length;
    const rpCount = lvlPitchers.filter((p) => p.POS === "RP" || p.POS === "CL").length;
    if (spCount > 0 && rpCount > 0) {
      const ratio = spCount / (spCount + rpCount);
      if (ratio < 0.3) {
        flags.push({ type: "warning", tag: "SP SHORTAGE", msg: `Only ${spCount} SP vs ${rpCount} RP — need more starters` });
      } else if (ratio > 0.6) {
        flags.push({ type: "info", tag: "SP HEAVY", msg: `${spCount} SP vs ${rpCount} RP — consider converting some to relief` });
      }
    }

    // — Grade the level —
    const { grade, gradeColor } = gradeLevel(flags, total, target, cutList.length, lvlHitters.length, lvlPitchers.length);

    levels.push({
      level,
      grade,
      gradeColor,
      totalPlayers: total,
      rosterTarget: target,
      hitters: flaggedHitters,
      pitchers: flaggedPitchers,
      positionCounts,
      flags,
      cutList,
      promoteCandidates: promotes,
    });
  }

  // — Org-wide flags —
  const orgFlags: Flag[] = [];

  if (allCuts.length > 15) {
    orgFlags.push({
      type: "critical",
      tag: "ROSTER BLOAT",
      msg: `${allCuts.length} players flagged for release — org is carrying too much dead weight, stealing ABs/IP from real prospects`,
    });
  } else if (allCuts.length > 5) {
    orgFlags.push({
      type: "warning",
      tag: "TRIM NEEDED",
      msg: `${allCuts.length} players should be released to free up playing time`,
    });
  }

  if (allGaps.length > 5) {
    orgFlags.push({
      type: "warning",
      tag: "POSITION GAPS",
      msg: `${allGaps.length} position gaps across the system — target these in draft/IFA`,
    });
  }

  // Check for org-wide position deserts
  const batPositions = ["C", "1B", "2B", "SS", "3B", "LF", "CF", "RF"];
  for (const pos of batPositions) {
    const highPotAtPos = hitters.filter((p) => p.POS === pos && (p.POT as number) >= 50);
    if (highPotAtPos.length === 0) {
      orgFlags.push({
        type: "warning",
        tag: `NO ${pos} PROSPECT`,
        msg: `No 50+ POT ${pos} in the entire org — priority draft need`,
      });
    }
  }

  const highPotSP = pitchers.filter((p) => p.POS === "SP" && (p.POT as number) >= 50);
  if (highPotSP.length < 2) {
    orgFlags.push({
      type: highPotSP.length === 0 ? "critical" : "warning",
      tag: "SP PIPELINE",
      msg: `Only ${highPotSP.length} starting pitcher(s) with 50+ POT — need to restock rotation pipeline`,
    });
  }

  // Org grade
  const levelGrades = levels.map((l) => gradeToNum(l.grade));
  const avgGrade = levelGrades.reduce((a, b) => a + b, 0) / levelGrades.length;
  const { grade: orgGrade, color: orgGradeColor } = numToGrade(avgGrade);

  return { levels, orgGrade, orgGradeColor, orgFlags, cutList: allCuts, promoteCandidates: allPromotes, gaps: allGaps };
}

function flagPlayer(p: Player, level: string): Flag[] {
  const flags: Flag[] = [];
  const age = p.Age as number;
  const pot = p.POT as number;
  const ageCap = AGE_CAPS[level] ?? 99;
  const ageIdeal = AGE_IDEAL[level] ?? [17, 30];
  const potFloor = POT_FLOOR[level] ?? 30;

  // Age checks
  if (age > ageCap) {
    flags.push({ type: "critical", tag: "TOO OLD", msg: `Age ${age} — max ${ageCap} for ${level}` });
  } else if (age > ageIdeal[1]) {
    flags.push({ type: "warning", tag: "OLD", msg: `Age ${age} — ideally ${ageIdeal[0]}-${ageIdeal[1]} for ${level}` });
  } else if (age < ageIdeal[0]) {
    flags.push({ type: "info", tag: "YOUNG", msg: `Age ${age} — aggressive assignment for ${level}` });
  }

  // POT checks
  if (pot < potFloor) {
    flags.push({ type: "critical", tag: "LOW POT", msg: `POT ${pot} — below ${potFloor} floor for ${level}` });
  } else if (pot >= 55) {
    flags.push({ type: "good", tag: "ELITE", msg: `POT ${pot} — strong develop priority` });
  } else if (pot >= 50) {
    flags.push({ type: "good", tag: "SOLID", msg: `POT ${pot} — worth developing` });
  }

  // Composite cut / promote logic
  const isTooOld = age > ageCap;
  const isOld = age > ageIdeal[1];
  const isLowPot = pot < potFloor;
  const isVeryLowPot = pot <= 30;

  if (isTooOld && isLowPot) {
    flags.push({ type: "critical", tag: "STRONG CUT", msg: "Too old + low POT — release immediately" });
  } else if (isTooOld || (isOld && isLowPot)) {
    flags.push({ type: "critical", tag: "CUT", msg: "Release candidate — not developing into anything" });
  } else if (isVeryLowPot && !["Rookie-DSL", "Rookie-DSL1", "Rookie-DSL2"].includes(level)) {
    flags.push({ type: "critical", tag: "CUT", msg: `POT ${pot} — not worth a roster spot` });
  }

  // Promote check: high POT + older than ideal = should be moving up
  if (pot >= 45 && age > ageIdeal[1] && !isTooOld && !isLowPot && level !== "AAA") {
    flags.push({ type: "info", tag: "PROMOTE", msg: `POT ${pot}, age ${age} — ready for next level` });
  }

  return flags;
}

function gradeLevel(
  flags: Flag[],
  total: number,
  target: { min: number; max: number },
  cuts: number,
  hitters: number,
  pitchers: number,
): { grade: string; gradeColor: string } {
  let score = 100;

  // Roster size penalties
  if (total > target.max) score -= Math.min(30, (total - target.max) * 5);
  if (total < target.min) score -= Math.min(20, (target.min - total) * 5);

  // Position gap penalties
  const criticals = flags.filter((f) => f.type === "critical").length;
  const warnings = flags.filter((f) => f.type === "warning").length;
  score -= criticals * 8;
  score -= warnings * 3;

  // Cut list penalty
  score -= cuts * 4;

  // Balance penalty
  if (hitters + pitchers > 0) {
    const ratio = hitters / (hitters + pitchers);
    if (ratio < 0.35 || ratio > 0.65) score -= 10;
  }

  const { grade, color } = numToGrade(Math.max(0, Math.min(100, score)));
  return { grade, gradeColor: color };
}

function gradeToNum(g: string): number {
  const map: Record<string, number> = { "A+": 97, "A": 93, "A-": 90, "B+": 87, "B": 83, "B-": 80, "C+": 77, "C": 73, "C-": 70, "D+": 67, "D": 63, "D-": 60, "F": 50 };
  return map[g] ?? 50;
}

function numToGrade(n: number): { grade: string; color: string } {
  if (n >= 95) return { grade: "A+", color: "text-emerald-400" };
  if (n >= 90) return { grade: "A", color: "text-emerald-400" };
  if (n >= 85) return { grade: "A-", color: "text-emerald-400" };
  if (n >= 80) return { grade: "B+", color: "text-accent" };
  if (n >= 75) return { grade: "B", color: "text-accent" };
  if (n >= 70) return { grade: "B-", color: "text-accent" };
  if (n >= 65) return { grade: "C+", color: "text-yellow-400" };
  if (n >= 60) return { grade: "C", color: "text-yellow-400" };
  if (n >= 55) return { grade: "C-", color: "text-yellow-400" };
  if (n >= 50) return { grade: "D+", color: "text-orange-400" };
  if (n >= 45) return { grade: "D", color: "text-orange-400" };
  if (n >= 40) return { grade: "D-", color: "text-orange-400" };
  return { grade: "F", color: "text-red-400" };
}

// ════════════════════════════════════════════════════════════
// UI
// ════════════════════════════════════════════════════════════

function potColor(val: number): string {
  if (val >= 60) return "text-emerald-400 font-bold";
  if (val >= 55) return "text-emerald-400";
  if (val >= 50) return "text-accent";
  if (val >= 45) return "text-yellow-400";
  if (val >= 40) return "text-txt-secondary";
  return "text-red-400";
}

function potBg(val: number): string {
  if (val >= 55) return "bg-emerald-500/15";
  if (val >= 45) return "bg-yellow-500/10";
  return "bg-red-500/10";
}

function flagBadge(flag: Flag) {
  const colors = {
    critical: "bg-red-500/20 text-red-400 border-red-500/30",
    warning: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
    info: "bg-blue-500/15 text-blue-400 border-blue-500/30",
    good: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  };
  return (
    <span
      key={flag.tag}
      title={flag.msg}
      className={`inline-block px-1.5 py-0.5 rounded border text-[10px] font-semibold uppercase tracking-wider ${colors[flag.type]}`}
    >
      {flag.tag}
    </span>
  );
}

type Tab = "overview" | "hitters" | "pitchers" | "top" | "algo" | "insights" | "moves";

const BAT_TOOL_COLS = ["CON P", "HT P", "GAP P", "POW P"];
const PIT_TOOL_COLS = ["STU P", "MOV P", "CTL P", "PBABIP P"];
const BAT_EXTRA = ["SctAcc"];
const PIT_EXTRA = ["VT", "SctAcc"];

export default function Home() {
  const [tab, setTab] = useState<Tab>("algo");
  const [levelFilter, setLevelFilter] = useState<string>("All");
  const [posFilter, setPosFilter] = useState<string>("All");
  const [search, setSearch] = useState("");
  const cutSet = useCutSet();

  const activeLevels = useMemo(
    () => data.levels.filter((l) => data.overview.some((o) => o.level === l)),
    []
  );

  const analysis = useMemo(() => analyzeOrg(data.hitters, data.pitchers), []);
  const { reports: levelReports, transfers: orgTransfers } = useMemo(() => buildLevelReports(data.hitters, data.pitchers), []);

  const filteredHitters = useMemo(() => {
    return data.hitters.filter((p) => {
      if (levelFilter !== "All" && p.Level !== levelFilter) return false;
      if (posFilter !== "All" && p.POS !== posFilter) return false;
      if (search && !(p.Name as string).toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [levelFilter, posFilter, search]);

  const filteredPitchers = useMemo(() => {
    return data.pitchers.filter((p) => {
      if (levelFilter !== "All" && p.Level !== levelFilter) return false;
      if (posFilter !== "All" && p.POS !== posFilter) return false;
      if (search && !(p.Name as string).toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [levelFilter, posFilter, search]);

  const top25Bat = useMemo(() => [...data.hitters].sort((a, b) => {
    const d = (b.POT as number) - (a.POT as number);
    return d !== 0 ? d : (b.ToolAvg as number) - (a.ToolAvg as number);
  }).slice(0, 25), []);

  const top25Pit = useMemo(() => [...data.pitchers].sort((a, b) => {
    const d = (b.POT as number) - (a.POT as number);
    return d !== 0 ? d : (b.ToolAvg as number) - (a.ToolAvg as number);
  }).slice(0, 25), []);

  const batPositions = useMemo(() => Array.from(new Set(data.hitters.map((p) => p.POS as string))).sort(), []);
  const pitPositions = useMemo(() => Array.from(new Set(data.pitchers.map((p) => p.POS as string))).sort(), []);
  const positions = tab === "pitchers" ? pitPositions : batPositions;

  return (
    <main className="max-w-6xl mx-auto px-6 py-10">
      <div className="mb-8 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">KC Royals Farm System</h1>
          <p className="text-txt-muted text-sm mt-1">
            {data.hitters.length} hitters + {data.pitchers.length} pitchers across {activeLevels.length} levels
          </p>
        </div>
        {cutSet.count > 0 && (
          <div className="flex items-center gap-3">
            <span className="text-[13px] text-red-400">{cutSet.count} cut</span>
            <button
              onClick={cutSet.clearAll}
              className="text-[12px] text-txt-muted hover:text-txt border border-g-border rounded-md px-2 py-1 hover:bg-g-hover transition-colors"
            >
              Reset all
            </button>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 bg-g-card border border-g-border rounded-lg p-1 w-fit">
        {(["algo", "moves", "insights", "overview", "top", "hitters", "pitchers"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => { setTab(t); setPosFilter("All"); }}
            className={`px-4 py-1.5 rounded-md text-[13px] font-medium transition-all ${
              tab === t
                ? "bg-accent/15 text-accent"
                : "text-txt-secondary hover:text-txt hover:bg-g-hover"
            }`}
          >
            {{algo: "Algo", moves: "Moves", insights: "Insights", overview: "Overview", top: "Top Prospects", hitters: "Hitters", pitchers: "Pitchers"}[t]}
          </button>
        ))}
      </div>

      {/* Filters */}
      {(tab === "hitters" || tab === "pitchers") && (
        <div className="flex flex-wrap gap-3 mb-5">
          <input
            type="text"
            placeholder="Search by name..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="bg-g-card border border-g-border rounded-lg px-3 py-1.5 text-[13px] text-txt placeholder:text-txt-muted focus:outline-none focus:border-accent/50 w-56"
          />
          <select
            value={levelFilter}
            onChange={(e) => setLevelFilter(e.target.value)}
            className="bg-g-card border border-g-border rounded-lg px-3 py-1.5 text-[13px] text-txt focus:outline-none focus:border-accent/50"
          >
            <option value="All">All Levels</option>
            {activeLevels.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
          <select
            value={posFilter}
            onChange={(e) => setPosFilter(e.target.value)}
            className="bg-g-card border border-g-border rounded-lg px-3 py-1.5 text-[13px] text-txt focus:outline-none focus:border-accent/50"
          >
            <option value="All">All Positions</option>
            {positions.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
      )}

      {tab === "algo" && <AlgoTab analysis={analysis} cutSet={cutSet} />}
      {tab === "moves" && <MovesTab levelReports={levelReports} orgTransfers={orgTransfers} analysis={analysis} cutSet={cutSet} />}
      {tab === "insights" && <InsightsTab analysis={analysis} hitters={data.hitters} pitchers={data.pitchers} cutSet={cutSet} levelReports={levelReports} orgTransfers={orgTransfers} />}
      {tab === "overview" && <OverviewTab overview={data.overview} />}

      {tab === "top" && (
        <div className="space-y-8">
          <section>
            <h2 className="text-lg font-semibold mb-3">Top 25 Hitting Prospects</h2>
            <PlayerTable players={top25Bat} toolCols={BAT_TOOL_COLS} extraCols={BAT_EXTRA} ranked cutSet={cutSet} />
          </section>
          <section>
            <h2 className="text-lg font-semibold mb-3">Top 25 Pitching Prospects</h2>
            <PlayerTable players={top25Pit} toolCols={PIT_TOOL_COLS} extraCols={PIT_EXTRA} ranked cutSet={cutSet} />
          </section>
        </div>
      )}

      {tab === "hitters" && (
        <PlayerTable players={filteredHitters} toolCols={BAT_TOOL_COLS} extraCols={BAT_EXTRA} cutSet={cutSet} />
      )}

      {tab === "pitchers" && (
        <PlayerTable players={filteredPitchers} toolCols={PIT_TOOL_COLS} extraCols={PIT_EXTRA} cutSet={cutSet} />
      )}
    </main>
  );
}

// ════════════════════════════════════════════════════════════
// ALGO TAB
// ════════════════════════════════════════════════════════════

type CutSet = ReturnType<typeof useCutSet>;

function CutBtn({ player, cutSet }: { player: Player; cutSet: CutSet }) {
  const key = playerKey(player);
  const isCut = cutSet.cuts.has(key);
  return (
    <button
      onClick={(e) => { e.stopPropagation(); cutSet.toggle(key); }}
      title={isCut ? "Undo cut" : "Cut player"}
      className={`shrink-0 w-6 h-6 rounded flex items-center justify-center text-[11px] font-bold border transition-colors ${
        isCut
          ? "bg-txt-muted/20 border-txt-muted/30 text-txt-muted hover:border-txt-secondary"
          : "bg-red-500/15 border-red-500/30 text-red-400 hover:bg-red-500/25"
      }`}
    >
      {isCut ? "↩" : "✕"}
    </button>
  );
}

function AlgoTab({ analysis, cutSet }: { analysis: ReturnType<typeof analyzeOrg>; cutSet: CutSet }) {
  const [expandedLevel, setExpandedLevel] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      {/* Org grade hero card */}
      <div className="bg-g-card border border-g-border rounded-xl p-6">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-txt-muted text-[11px] uppercase tracking-wider mb-1">Organization Grade</div>
            <div className={`text-5xl font-bold ${analysis.orgGradeColor}`}>{analysis.orgGrade}</div>
          </div>
          <div className="text-right text-[13px]">
            <div className="text-txt-secondary">{analysis.cutList.length} cut candidates</div>
            <div className="text-txt-secondary">{analysis.promoteCandidates.length} promotion candidates</div>
            <div className="text-txt-secondary">{analysis.gaps.length} position gaps</div>
          </div>
        </div>
        {analysis.orgFlags.length > 0 && (
          <div className="mt-4 space-y-2">
            {analysis.orgFlags.map((f, i) => (
              <div key={i} className="flex items-start gap-2 text-[13px]">
                {flagBadge(f)}
                <span className="text-txt-secondary">{f.msg}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Per-level cards */}
      <div className="space-y-3">
        <h2 className="text-lg font-semibold">Level Breakdown</h2>
        {analysis.levels.map((lvl) => (
          <div key={lvl.level} className="bg-g-card border border-g-border rounded-xl overflow-hidden">
            <button
              onClick={() => setExpandedLevel(expandedLevel === lvl.level ? null : lvl.level)}
              className="w-full px-5 py-4 flex items-center justify-between hover:bg-g-hover/50 transition-colors"
            >
              <div className="flex items-center gap-4">
                <span className={`text-2xl font-bold w-10 ${lvl.gradeColor}`}>{lvl.grade}</span>
                <div className="text-left">
                  <div className="text-[15px] font-semibold">{lvl.level}</div>
                  <div className="text-[12px] text-txt-muted">
                    {lvl.totalPlayers} players ({lvl.hitters.length}H / {lvl.pitchers.length}P)
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-wrap justify-end">
                {lvl.flags.filter((f) => f.type === "critical" || f.type === "warning").slice(0, 4).map((f, i) => (
                  <span key={i}>{flagBadge(f)}</span>
                ))}
                <span className="text-txt-muted text-lg ml-2">{expandedLevel === lvl.level ? "−" : "+"}</span>
              </div>
            </button>

            {expandedLevel === lvl.level && (
              <div className="border-t border-g-border px-5 py-4 space-y-4">
                {/* All flags */}
                <div className="space-y-1.5">
                  {lvl.flags.map((f, i) => (
                    <div key={i} className="flex items-start gap-2 text-[13px]">
                      {flagBadge(f)}
                      <span className="text-txt-secondary">{f.msg}</span>
                    </div>
                  ))}
                </div>

                {/* Position depth grid */}
                <div>
                  <div className="text-[12px] text-txt-muted uppercase tracking-wider mb-2">Position Depth</div>
                  <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-11 gap-1.5">
                    {lvl.positionCounts.map((pc) => {
                      const isLow = pc.count < pc.target[0];
                      const isHigh = pc.count > pc.target[2];
                      const bg = pc.count === 0 && pc.target[0] > 0
                        ? "bg-red-500/20 border-red-500/40"
                        : isLow
                        ? "bg-yellow-500/15 border-yellow-500/30"
                        : isHigh
                        ? "bg-orange-500/15 border-orange-500/30"
                        : "bg-g-subtle border-g-border";
                      return (
                        <div
                          key={pc.pos}
                          title={pc.names.join(", ") || "Empty"}
                          className={`rounded-lg border px-2 py-2 text-center ${bg}`}
                        >
                          <div className="text-[10px] text-txt-muted font-medium">{pc.pos}</div>
                          <div className={`text-[15px] font-bold ${isLow || pc.count === 0 ? "text-red-400" : isHigh ? "text-orange-400" : "text-txt"}`}>
                            {pc.count}
                          </div>
                          <div className="text-[9px] text-txt-muted">{pc.target[0]}-{pc.target[2]}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Cut list for this level */}
                {lvl.cutList.length > 0 && (
                  <div>
                    <div className="text-[12px] text-red-400 uppercase tracking-wider mb-2">
                      Cut List ({lvl.cutList.length})
                    </div>
                    <div className="space-y-1">
                      {lvl.cutList.map((p, i) => (
                        <div key={i} className="flex items-center gap-3 text-[13px] bg-red-500/5 rounded-lg px-3 py-1.5">
                          <span className="bg-g-subtle px-1.5 py-0.5 rounded text-[10px] font-medium w-7 text-center">{p.POS as string}</span>
                          <span className="font-medium flex-1">{p.Name as string}</span>
                          <span className="text-txt-muted">Age {p.Age as number}</span>
                          <span className={potColor(p.POT as number)}>POT {p.POT as number}</span>
                          <div className="flex gap-1">
                            {p.flags.filter((f) => f.type === "critical").map((f, j) => (
                              <span key={j}>{flagBadge(f)}</span>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Promote candidates */}
                {lvl.promoteCandidates.length > 0 && (
                  <div>
                    <div className="text-[12px] text-blue-400 uppercase tracking-wider mb-2">
                      Promotion Candidates ({lvl.promoteCandidates.length})
                    </div>
                    <div className="space-y-1">
                      {lvl.promoteCandidates.map((p, i) => (
                        <div key={i} className="flex items-center gap-3 text-[13px] bg-blue-500/5 rounded-lg px-3 py-1.5">
                          <span className="bg-g-subtle px-1.5 py-0.5 rounded text-[10px] font-medium w-7 text-center">{p.POS as string}</span>
                          <span className="font-medium flex-1">{p.Name as string}</span>
                          <span className="text-txt-muted">Age {p.Age as number}</span>
                          <span className={potColor(p.POT as number)}>POT {p.POT as number}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Full roster with flags */}
                <div>
                  <div className="text-[12px] text-txt-muted uppercase tracking-wider mb-2">Full Roster</div>
                  <div className="overflow-x-auto rounded-lg border border-g-border">
                    <table className="w-full text-[12px]">
                      <thead>
                        <tr className="bg-g-subtle border-b border-g-border text-txt-muted text-[10px] uppercase tracking-wider">
                          <th className="px-2 py-2 text-left">POS</th>
                          <th className="px-2 py-2 text-left">Name</th>
                          <th className="px-2 py-2 text-center">Age</th>
                          <th className="px-2 py-2 text-center">POT</th>
                          <th className="px-2 py-2 text-center">Tools</th>
                          <th className="px-2 py-2 text-left">Flags</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...lvl.hitters, ...lvl.pitchers]
                          .sort((a, b) => (b.POT as number) - (a.POT as number))
                          .map((p, i) => (
                            <tr key={i} className="border-b border-g-border/30 hover:bg-g-hover/30">
                              <td className="px-2 py-1.5">
                                <span className="bg-g-subtle px-1 py-0.5 rounded text-[10px] font-medium">{p.POS as string}</span>
                              </td>
                              <td className="px-2 py-1.5 font-medium whitespace-nowrap">{p.Name as string}</td>
                              <td className="px-2 py-1.5 text-center text-txt-secondary">{p.Age as number}</td>
                              <td className="px-2 py-1.5 text-center">
                                <span className={`${potColor(p.POT as number)}`}>{p.POT as number}</span>
                              </td>
                              <td className="px-2 py-1.5 text-center">
                                <span className={potColor(p.ToolAvg as number)}>{p.ToolAvg as number}</span>
                              </td>
                              <td className="px-2 py-1.5">
                                <div className="flex gap-1 flex-wrap">
                                  {p.flags.map((f, j) => <span key={j}>{flagBadge(f)}</span>)}
                                </div>
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Global cut list */}
      {analysis.cutList.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold mb-3">
            Full Cut List <span className="text-red-400 text-[14px]">({analysis.cutList.length})</span>
          </h2>
          <p className="text-txt-muted text-[13px] mb-3">
            Releasing these players frees roster spots and playing time for real prospects.
          </p>
          <div className="overflow-x-auto rounded-xl border border-g-border">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="bg-g-card border-b border-g-border text-txt-muted text-[11px] uppercase tracking-wider">
                  <th className="px-3 py-2.5 text-center w-10"></th>
                  <th className="px-3 py-2.5 text-left">Level</th>
                  <th className="px-3 py-2.5 text-left">POS</th>
                  <th className="px-3 py-2.5 text-left">Name</th>
                  <th className="px-3 py-2.5 text-center">Age</th>
                  <th className="px-3 py-2.5 text-center">POT</th>
                  <th className="px-3 py-2.5 text-left">Reason</th>
                </tr>
              </thead>
              <tbody>
                {analysis.cutList
                  .sort((a, b) => (a.POT as number) - (b.POT as number))
                  .map((p, i) => {
                    const isCut = cutSet.cuts.has(playerKey(p));
                    return (
                    <tr key={i} className={`border-b border-g-border/50 hover:bg-g-hover/50 ${isCut ? "opacity-40 line-through" : ""}`}>
                      <td className="px-3 py-2 text-center"><CutBtn player={p} cutSet={cutSet} /></td>
                      <td className="px-3 py-2 text-txt-secondary">{p.Level as string}</td>
                      <td className="px-3 py-2">
                        <span className="bg-g-subtle px-1.5 py-0.5 rounded text-[11px] font-medium">{p.POS as string}</span>
                      </td>
                      <td className="px-3 py-2 font-medium">{p.Name as string}</td>
                      <td className="px-3 py-2 text-center text-txt-secondary">{p.Age as number}</td>
                      <td className="px-3 py-2 text-center">
                        <span className={potColor(p.POT as number)}>{p.POT as number}</span>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex gap-1 flex-wrap">
                          {p.flags.filter((f) => f.type === "critical").map((f, j) => (
                            <span key={j}>{flagBadge(f)}</span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  );
                  })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Draft needs / gaps */}
      {analysis.gaps.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold mb-3">Draft & Acquisition Needs</h2>
          <p className="text-txt-muted text-[13px] mb-3">
            Position gaps to target in the draft, IFA, or trades.
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
            {analysis.gaps.map((g, i) => (
              <div key={i} className="bg-g-card border border-g-border rounded-lg px-3 py-2 flex items-center gap-2">
                <span className="bg-red-500/20 text-red-400 border border-red-500/30 px-1.5 py-0.5 rounded text-[10px] font-semibold">
                  {g.pos}
                </span>
                <span className="text-[13px] text-txt-secondary">{g.level}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// INSIGHTS TAB
// ════════════════════════════════════════════════════════════

// Ideal roster composition per level
const IDEAL_ROSTER: Record<string, Record<string, { ideal: number; min: number; max: number }>> = {
  "Rookie-DSL": {
    C: { ideal: 3, min: 2, max: 4 }, "1B": { ideal: 2, min: 1, max: 3 }, "2B": { ideal: 2, min: 1, max: 3 },
    SS: { ideal: 2, min: 1, max: 3 }, "3B": { ideal: 2, min: 1, max: 3 },
    LF: { ideal: 2, min: 1, max: 3 }, CF: { ideal: 2, min: 1, max: 3 }, RF: { ideal: 2, min: 1, max: 3 },
    SP: { ideal: 8, min: 6, max: 10 }, RP: { ideal: 6, min: 4, max: 8 }, CL: { ideal: 1, min: 0, max: 2 },
  },
  "Rookie-ACL": {
    C: { ideal: 3, min: 2, max: 4 }, "1B": { ideal: 2, min: 1, max: 3 }, "2B": { ideal: 2, min: 1, max: 3 },
    SS: { ideal: 2, min: 1, max: 3 }, "3B": { ideal: 2, min: 1, max: 3 },
    LF: { ideal: 2, min: 1, max: 3 }, CF: { ideal: 2, min: 1, max: 3 }, RF: { ideal: 2, min: 1, max: 3 },
    SP: { ideal: 6, min: 5, max: 8 }, RP: { ideal: 5, min: 3, max: 7 }, CL: { ideal: 1, min: 0, max: 2 },
  },
  "Low-A": {
    C: { ideal: 2, min: 2, max: 3 }, "1B": { ideal: 2, min: 1, max: 2 }, "2B": { ideal: 2, min: 1, max: 2 },
    SS: { ideal: 2, min: 1, max: 2 }, "3B": { ideal: 2, min: 1, max: 2 },
    LF: { ideal: 2, min: 1, max: 2 }, CF: { ideal: 2, min: 1, max: 2 }, RF: { ideal: 2, min: 1, max: 2 },
    SP: { ideal: 5, min: 5, max: 7 }, RP: { ideal: 5, min: 3, max: 6 }, CL: { ideal: 1, min: 0, max: 2 },
  },
  "High-A": {
    C: { ideal: 2, min: 2, max: 3 }, "1B": { ideal: 2, min: 1, max: 2 }, "2B": { ideal: 2, min: 1, max: 2 },
    SS: { ideal: 2, min: 1, max: 2 }, "3B": { ideal: 2, min: 1, max: 2 },
    LF: { ideal: 2, min: 1, max: 2 }, CF: { ideal: 2, min: 1, max: 2 }, RF: { ideal: 2, min: 1, max: 2 },
    SP: { ideal: 5, min: 5, max: 7 }, RP: { ideal: 5, min: 3, max: 6 }, CL: { ideal: 1, min: 0, max: 2 },
  },
  "AA": {
    C: { ideal: 2, min: 2, max: 3 }, "1B": { ideal: 2, min: 1, max: 2 }, "2B": { ideal: 2, min: 1, max: 2 },
    SS: { ideal: 2, min: 1, max: 2 }, "3B": { ideal: 2, min: 1, max: 2 },
    LF: { ideal: 2, min: 1, max: 2 }, CF: { ideal: 2, min: 1, max: 2 }, RF: { ideal: 2, min: 1, max: 2 },
    SP: { ideal: 5, min: 5, max: 7 }, RP: { ideal: 5, min: 3, max: 7 }, CL: { ideal: 1, min: 1, max: 2 },
  },
  "AAA": {
    C: { ideal: 3, min: 2, max: 3 }, "1B": { ideal: 2, min: 1, max: 2 }, "2B": { ideal: 2, min: 1, max: 2 },
    SS: { ideal: 2, min: 1, max: 2 }, "3B": { ideal: 2, min: 1, max: 2 },
    LF: { ideal: 2, min: 1, max: 2 }, CF: { ideal: 2, min: 1, max: 2 }, RF: { ideal: 2, min: 1, max: 2 },
    SP: { ideal: 6, min: 5, max: 8 }, RP: { ideal: 6, min: 4, max: 8 }, CL: { ideal: 1, min: 1, max: 2 },
  },
};

const POS_ORDER = ["C", "1B", "2B", "SS", "3B", "LF", "CF", "RF", "SP", "RP", "CL"];
const POS_GROUPS = {
  "Infield": ["C", "1B", "2B", "SS", "3B"],
  "Outfield": ["LF", "CF", "RF"],
  "Starting Pitching": ["SP"],
  "Bullpen": ["RP", "CL"],
};

type LevelReport = {
  level: string;
  players: Player[];
  posCounts: Record<string, number>;
  ideal: Record<string, { ideal: number; min: number; max: number }>;
  totalHitters: number;
  totalPitchers: number;
  total: number;
  avgPot: number;
  avgAge: number;
  topProspect: Player | null;
  issues: string[];
  strengths: string[];
  actions: string[];
  summary: string;
};

// ── Org-wide transaction engine ──
// First pass: build a map of every level's surplus/deficit at every position.
// Second pass: match surpluses to deficits across levels, preferring moves
// that go one level at a time (promote/demote) but allowing multi-level jumps
// when no adjacent solution exists. Third pass: per-level issues and prose.

type Transfer = {
  player: Player;
  from: string;
  to: string;
  pos: string;
  reason: string;
};

function buildLevelReports(hitters: Player[], pitchers: Player[]): { reports: LevelReport[]; transfers: Transfer[] } {
  const levels = ["Rookie-DSL", "Rookie-ACL", "Low-A", "High-A", "AA", "AAA"];
  const nextLevel: Record<string, string> = {
    "Rookie-DSL": "Rookie-ACL", "Rookie-ACL": "Low-A", "Low-A": "High-A",
    "High-A": "AA", "AA": "AAA",
  };
  const prevLevel: Record<string, string> = {};
  Object.entries(nextLevel).forEach(([k, v]) => { prevLevel[v] = k; });
  const levelIndex: Record<string, number> = {};
  levels.forEach((l, i) => { levelIndex[l] = i; });

  // ── Pass 1: per-level raw data ──
  const ld: Record<string, {
    hitters: Player[]; pitchers: Player[]; all: Player[];
    posCounts: Record<string, number>; total: number;
  }> = {};
  for (const level of levels) {
    const h = hitters.filter((p) => p.Level === level);
    const pit = pitchers.filter((p) => p.Level === level);
    const all = [...h, ...pit];
    const posCounts: Record<string, number> = {};
    POS_ORDER.forEach((pos) => { posCounts[pos] = 0; });
    all.forEach((p) => { posCounts[p.POS as string] = (posCounts[p.POS as string] || 0) + 1; });
    ld[level] = { hitters: h, pitchers: pit, all, posCounts, total: all.length };
  }

  // ── Pass 2: org-wide surplus/deficit map and transfer recommendations ──
  // For each position at each level, compute: surplus (>max), deficit (<min), or balanced.
  type PosStatus = { level: string; pos: string; count: number; ideal: number; min: number; max: number; delta: number };
  const posGrid: PosStatus[][] = []; // [posIndex][levelIndex]

  for (const pos of POS_ORDER) {
    const row: PosStatus[] = [];
    for (const level of levels) {
      const count = ld[level].posCounts[pos];
      const tgt = IDEAL_ROSTER[level]?.[pos] || { ideal: 1, min: 1, max: 2 };
      row.push({ level, pos, count, ideal: tgt.ideal, min: tgt.min, max: tgt.max, delta: count - tgt.ideal });
    }
    posGrid.push(row);
  }

  // Generate transfers: match deficits with nearest surplus
  const transfers: Transfer[] = [];
  const usedPlayerKeys = new Set<string>(); // prevent double-moving same player

  for (let pi = 0; pi < POS_ORDER.length; pi++) {
    const pos = POS_ORDER[pi];
    const row = posGrid[pi];

    // Find deficits (count < min)
    const deficits = row.filter((s) => s.count < s.min && ld[s.level].total > 0);
    // Find surpluses (count > max)
    const surpluses = row.filter((s) => s.count > s.max && ld[s.level].total > 0);

    for (const deficit of deficits) {
      const diIdx = levelIndex[deficit.level];

      // Try to fill from surpluses, preferring closest level
      const sortedSurpluses = [...surpluses].sort((a, b) =>
        Math.abs(levelIndex[a.level] - diIdx) - Math.abs(levelIndex[b.level] - diIdx)
      );

      for (const surplus of sortedSurpluses) {
        if (surplus.count <= surplus.max) continue; // already resolved
        const siIdx = levelIndex[surplus.level];
        const direction = siIdx < diIdx ? "promote" : "demote";

        // Pick the best player to move
        const candidates = ld[surplus.level].all
          .filter((p) => (p.POS as string) === pos && !usedPlayerKeys.has(playerKey(p)))
          .sort((a, b) => {
            // For promotions: send the best player up. For demotions: send the worst player down.
            if (direction === "promote") return (b.POT as number) - (a.POT as number);
            return (a.POT as number) - (b.POT as number);
          });

        if (candidates.length > 0) {
          const player = candidates[0];
          const verb = direction === "promote" ? "Promote" : "Send down";
          const levelNames = direction === "promote"
            ? levels.slice(siIdx, diIdx + 1).join(" -> ")
            : levels.slice(diIdx, siIdx + 1).reverse().join(" -> ");

          transfers.push({
            player,
            from: surplus.level,
            to: deficit.level,
            pos,
            reason: `${verb} ${player.Name} (${pos}, POT ${player.POT}, Age ${player.Age}) from ${surplus.level} to ${deficit.level}. ${surplus.level} has ${surplus.count} ${pos} (max ${surplus.max}) while ${deficit.level} has ${deficit.count} (need ${deficit.min}). Path: ${levelNames}.`,
          });
          usedPlayerKeys.add(playerKey(player));
          surplus.count--;
          deficit.count++;
        }
      }

      // If still short, look for any level with count > ideal (not just > max)
      if (deficit.count < deficit.min) {
        const flexSources = row
          .filter((s) => s.level !== deficit.level && s.count > s.ideal && ld[s.level].total > 0)
          .sort((a, b) => Math.abs(levelIndex[a.level] - diIdx) - Math.abs(levelIndex[b.level] - diIdx));

        for (const src of flexSources) {
          if (deficit.count >= deficit.min) break;
          const siIdx = levelIndex[src.level];
          const direction = siIdx < diIdx ? "promote" : "demote";
          const candidates = ld[src.level].all
            .filter((p) => (p.POS as string) === pos && !usedPlayerKeys.has(playerKey(p)))
            .sort((a, b) => direction === "promote" ? (b.POT as number) - (a.POT as number) : (a.POT as number) - (b.POT as number));

          if (candidates.length > 0) {
            const player = candidates[0];
            const verb = direction === "promote" ? "Promote" : "Send down";
            transfers.push({
              player, from: src.level, to: deficit.level, pos,
              reason: `${verb} ${player.Name} (${pos}, POT ${player.POT}, Age ${player.Age}) from ${src.level} to ${deficit.level}. ${src.level} has ${src.count} ${pos} (ideal ${src.ideal}) and ${deficit.level} only has ${deficit.count} (need ${deficit.min}).`,
            });
            usedPlayerKeys.add(playerKey(player));
            src.count--;
            deficit.count++;
          }
        }
      }
    }
  }

  // ── Pass 3: build per-level reports with org-aware context ──
  const reports = levels.map((level) => {
    const { hitters: lvlH, pitchers: lvlP, posCounts, all: players, total } = ld[level];
    const ideal = IDEAL_ROSTER[level] || IDEAL_ROSTER["AA"];
    const avgPot = total > 0 ? Math.round(players.reduce((s, p) => s + (p.POT as number), 0) / total) : 0;
    const avgAge = total > 0 ? +(players.reduce((s, p) => s + (p.Age as number), 0) / total).toFixed(1) : 0;
    const topProspect = players.length > 0
      ? players.reduce((best, p) => (p.POT as number) > (best.POT as number) ? p : best) : null;

    const issues: string[] = [];
    const strengths: string[] = [];
    const actions: string[] = [];

    const ageCap = AGE_CAPS[level] || 99;
    const ageIdeal = AGE_IDEAL[level] || [17, 28];
    const potFloor = POT_FLOOR[level] || 30;
    const target = ROSTER_TARGETS[level] || { min: 25, max: 30, ideal: 28 };

    // --- Roster size ---
    if (total > target.max) {
      issues.push(`Roster is bloated at ${total} players, ${total - target.max} over the ${target.max}-man max. Not everyone is getting meaningful reps.`);
    } else if (total < target.min) {
      issues.push(`Roster is dangerously thin at ${total} players, ${target.min - total} short of the ${target.min}-man minimum.`);
    } else {
      strengths.push(`Roster size is healthy at ${total} (target: ${target.min}-${target.max}).`);
    }

    // --- H/P balance ---
    const hRatio = total > 0 ? lvlH.length / total : 0;
    if (hRatio < 0.35) {
      issues.push(`Only ${lvlH.length} position players vs ${lvlP.length} pitchers (${Math.round(hRatio * 100)}% hitters). The lineup is stretched thin.`);
    } else if (hRatio > 0.6) {
      issues.push(`${lvlH.length} position players vs only ${lvlP.length} pitchers. The staff cannot cover a full season.`);
    } else {
      strengths.push(`Good hitter/pitcher balance at ${lvlH.length}H / ${lvlP.length}P.`);
    }

    // --- Per-position issues ---
    for (const pos of POS_ORDER) {
      const count = posCounts[pos];
      const tgt = ideal[pos];
      if (!tgt) continue;

      if (count === 0 && tgt.min > 0) {
        issues.push(`Zero ${pos} on the roster — critical gap.`);
      } else if (count < tgt.min) {
        issues.push(`Only ${count} ${pos} (need ${tgt.min}-${tgt.max}).${pos === "C" ? " Catchers are the hardest to develop." : pos === "SP" ? " Cannot fill a rotation." : ""}`);
      } else if (count > tgt.max) {
        const excess = count - tgt.max;
        if (pos === "RP") {
          issues.push(`${count} relievers is ${excess} over the ${tgt.max}-man max — development innings being wasted.`);
        } else {
          issues.push(`${count} ${pos} is ${excess} over the max of ${tgt.max}.`);
        }
      }
    }

    // --- SP/RP ratio ---
    const spCount = posCounts["SP"];
    const rpClCount = posCounts["RP"] + posCounts["CL"];
    if (rpClCount > 0 && spCount > 0 && rpClCount / spCount > 3) {
      issues.push(`Bullpen outnumbers rotation ${rpClCount} to ${spCount}. Staff is way out of balance.`);
      const convertCandidates = lvlP.filter((p) => (p.POS as string) === "RP" && (p.POT as number) >= 40 && (p.Age as number) <= ageIdeal[1])
        .sort((a, b) => (b.POT as number) - (a.POT as number));
      if (convertCandidates.length > 0 && spCount < (ideal["SP"]?.min || 5)) {
        const names = convertCandidates.slice(0, 2).map((p) => `${p.Name} (POT ${p.POT})`);
        actions.push(`Consider converting to SP: ${names.join(", ")} — they have the upside to start and you need rotation depth.`);
      }
    }

    // --- Org-wide transfers involving this level ---
    const inbound = transfers.filter((t) => t.to === level);
    const outbound = transfers.filter((t) => t.from === level);

    for (const t of inbound) {
      actions.push(`RECEIVE: ${t.reason}`);
    }
    for (const t of outbound) {
      actions.push(`SEND: ${t.reason}`);
    }

    // --- RP bloat: release the worst ---
    if (posCounts["RP"] > (ideal["RP"]?.max || 8)) {
      const rpCuts = players
        .filter((p) => (p.POS as string) === "RP" && (p.POT as number) <= potFloor)
        .sort((a, b) => (a.POT as number) - (b.POT as number) || (b.Age as number) - (a.Age as number));
      if (rpCuts.length > 0) {
        const names = rpCuts.slice(0, 6).map((p) => `${p.Name} (Age ${p.Age}, POT ${p.POT})`);
        actions.push(`Release bottom-tier relievers: ${names.join(", ")}${rpCuts.length > 6 ? `, plus ${rpCuts.length - 6} more` : ""}.`);
      }
    }

    // --- Position surplus with no org deficit: release weakest ---
    for (const pos of POS_ORDER) {
      if (pos === "RP" || pos === "CL") continue; // handled above
      const count = posCounts[pos];
      const tgt = ideal[pos];
      if (!tgt || count <= tgt.max) continue;
      // Check if any other level needs this position
      const anyDeficit = levels.some((l) => l !== level && (ld[l].posCounts[pos] || 0) < (IDEAL_ROSTER[l]?.[pos]?.min || 0));
      if (!anyDeficit) {
        const playersAtPos = players.filter((p) => (p.POS as string) === pos).sort((a, b) => (a.POT as number) - (b.POT as number));
        const excess = count - tgt.max;
        const toCut = playersAtPos.slice(0, excess);
        if (toCut.length > 0 && !outbound.some((t) => t.pos === pos)) {
          actions.push(`No other level needs a ${pos} either — release ${toCut.map((p) => `${p.Name} (POT ${p.POT})`).join(", ")}.`);
        }
      }
    }

    // --- Old players blocking young talent ---
    const tooOld = players.filter((p) => (p.Age as number) > ageCap && (p.POT as number) < 45 && !usedPlayerKeys.has(playerKey(p)));
    if (tooOld.length > 0) {
      // For each old player, check if the next level up could use them or if they should just be cut
      for (const old of tooOld.slice(0, 4)) {
        const up = nextLevel[level];
        const pos = old.POS as string;
        if (up && ld[up] && (ld[up].posCounts[pos] || 0) < (IDEAL_ROSTER[up]?.[pos]?.ideal || 2)) {
          actions.push(`${old.Name} (${pos}, Age ${old.Age}, POT ${old.POT}) is too old for ${level} but ${up} could use a ${pos} — promote them up.`);
        } else {
          actions.push(`${old.Name} (${pos}, Age ${old.Age}, POT ${old.POT}) is too old for ${level} and no higher level needs a ${pos} — release.`);
        }
      }
    }

    // --- Young stars blocked by older low-POT at same position ---
    for (const pos of POS_ORDER) {
      const atPos = players.filter((p) => (p.POS as string) === pos);
      if (atPos.length < 2) continue;
      const youngStar = atPos.find((p) => (p.POT as number) >= 50 && (p.Age as number) <= ageIdeal[0] + 1);
      const oldBlock = atPos.find((p) => (p.POT as number) < 40 && (p.Age as number) >= ageIdeal[1] && !usedPlayerKeys.has(playerKey(p)));
      if (youngStar && oldBlock) {
        const up = nextLevel[level];
        const upNeedsPos = up && ld[up] && (ld[up].posCounts[pos] || 0) < (IDEAL_ROSTER[up]?.[pos]?.ideal || 2);
        if (upNeedsPos) {
          actions.push(`${youngStar.Name} (POT ${youngStar.POT}, Age ${youngStar.Age}) is sharing ${pos} with ${oldBlock.Name} (POT ${oldBlock.POT}, Age ${oldBlock.Age}). Move ${oldBlock.Name} to ${up} where they need a ${pos}, clearing the path for ${youngStar.Name}.`);
        } else {
          actions.push(`${youngStar.Name} (POT ${youngStar.POT}, Age ${youngStar.Age}) is sharing ${pos} with ${oldBlock.Name} (POT ${oldBlock.POT}, Age ${oldBlock.Age}). Release ${oldBlock.Name} — nobody else needs them either.`);
        }
      }
    }

    // --- Promo-ready players (good POT, old for level) ---
    const promoReady = players.filter((p) => {
      const pot = p.POT as number; const age = p.Age as number;
      return pot >= 45 && age > ageIdeal[1] && nextLevel[level] && !usedPlayerKeys.has(playerKey(p));
    }).sort((a, b) => (b.POT as number) - (a.POT as number));
    for (const p of promoReady.slice(0, 3)) {
      const up = nextLevel[level]!;
      const upCount = ld[up]?.posCounts[p.POS as string] || 0;
      const upIdeal = IDEAL_ROSTER[up]?.[p.POS as string];
      const upNeedsPos = upIdeal ? upCount < upIdeal.ideal : false;
      const upTotal = ld[up]?.total || 0;
      const upTarget = ROSTER_TARGETS[up] || { min: 25, max: 30 };
      const upHasRoom = upTotal < upTarget.max;

      if (upNeedsPos && upHasRoom) {
        actions.push(`Promote ${p.Name} (${p.POS}, POT ${p.POT}, Age ${p.Age}) to ${up} — they need a ${p.POS} and have roster room. ${p.Name} has outgrown ${level}.`);
      } else if (upHasRoom) {
        actions.push(`${p.Name} (${p.POS}, POT ${p.POT}, Age ${p.Age}) is ready for ${up}. ${up} already has ${upCount} ${p.POS} but has roster room — keeping them at ${level} wastes development time.`);
      } else {
        // Up is full — check if up has someone to cut to make room
        const upWorst = ld[up]?.all
          .filter((pp) => (pp.POS as string) === (p.POS as string) && (pp.POT as number) < (p.POT as number))
          .sort((a, b) => (a.POT as number) - (b.POT as number))[0];
        if (upWorst) {
          actions.push(`${p.Name} (${p.POS}, POT ${p.POT}, Age ${p.Age}) is ready for ${up}, but ${up} is full. Release ${upWorst.Name} (POT ${upWorst.POT}) from ${up} to make room — ${p.Name} is the better prospect.`);
        }
      }
    }

    // --- Roster bloat: name specific releases if still over cap ---
    if (total > target.max) {
      const releasable = players
        .filter((p) => (p.POT as number) <= potFloor && !usedPlayerKeys.has(playerKey(p))
          && !outbound.some((t) => playerKey(t.player) === playerKey(p)))
        .sort((a, b) => (a.POT as number) - (b.POT as number) || (b.Age as number) - (a.Age as number));
      if (releasable.length > 0) {
        const names = releasable.slice(0, 5).map((p) => `${p.Name} (${p.POS}, Age ${p.Age}, POT ${p.POT})`);
        actions.push(`Release to trim roster: ${names.join(", ")}${releasable.length > 5 ? `, and ${releasable.length - 5} more` : ""}.`);
      }
    }

    // --- Summary ---
    let summary = "";
    if (issues.length === 0 && actions.length === 0) {
      summary = `${level} is well-constructed with ${total} players and an average potential of ${avgPot}. No major moves needed.`;
    } else if (issues.length <= 2) {
      summary = `${level} has ${total} players and is mostly solid, but has ${issues.length === 1 ? "one area" : "a couple areas"} to address. Average potential is ${avgPot}, average age ${avgAge}.`;
    } else {
      summary = `${level} needs significant work — ${issues.length} roster problems and ${actions.length} recommended moves. Average potential is ${avgPot}.`;
    }
    if (topProspect) {
      summary += ` The top prospect is ${topProspect.Name} (${topProspect.POS}, POT ${topProspect.POT}, Age ${topProspect.Age})${(topProspect.POT as number) >= 60 ? " — a franchise-caliber talent who must be the development priority here" : (topProspect.POT as number) >= 50 ? " — a legitimate prospect who needs consistent playing time" : ""}.`;
    }

    // --- Org context in summary ---
    if (inbound.length > 0 || outbound.length > 0) {
      summary += ` Org-wide: ${inbound.length > 0 ? `receiving ${inbound.length} player${inbound.length > 1 ? "s" : ""} from ${Array.from(new Set(inbound.map((t) => t.from))).join("/")}` : ""}${inbound.length > 0 && outbound.length > 0 ? ", " : ""}${outbound.length > 0 ? `sending ${outbound.length} player${outbound.length > 1 ? "s" : ""} to ${Array.from(new Set(outbound.map((t) => t.to))).join("/")}` : ""}.`;
    }

    return { level, players, posCounts, ideal, totalHitters: lvlH.length, totalPitchers: lvlP.length, total, avgPot, avgAge, topProspect, issues, strengths, actions, summary };
  }).filter((r) => r.total > 0);

  return { reports, transfers };
}

function InsightsTab({
  analysis, hitters, pitchers, cutSet, levelReports, orgTransfers,
}: {
  analysis: ReturnType<typeof analyzeOrg>;
  hitters: Player[];
  pitchers: Player[];
  cutSet: CutSet;
  levelReports: LevelReport[];
  orgTransfers: Transfer[];
}) {
  const allPlayers = useMemo(() => [...hitters, ...pitchers], [hitters, pitchers]);

  // Elite prospects (POT >= 60)
  const elites = useMemo(() =>
    allPlayers.filter((p) => (p.POT as number) >= 60).sort((a, b) => (b.POT as number) - (a.POT as number)),
  [allPlayers]);

  // Solid tier (POT 50-59)
  const solidTier = useMemo(() =>
    allPlayers.filter((p) => (p.POT as number) >= 50 && (p.POT as number) < 60).sort((a, b) => (b.POT as number) - (a.POT as number)),
  [allPlayers]);

  const totalIssues = levelReports.reduce((s, r) => s + r.issues.length, 0);

  // Expand state for level cards
  const [expandedLevels, setExpandedLevels] = useState<Set<string>>(new Set());
  const toggleLevel = (level: string) => {
    setExpandedLevels((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level); else next.add(level);
      return next;
    });
  };

  return (
    <div className="space-y-6">
      {/* Hero */}
      <div className="bg-g-card border border-g-border rounded-xl p-6">
        <div className="text-txt-muted text-[11px] uppercase tracking-wider mb-1">Organization Scouting Report</div>
        <p className="text-[15px] text-txt-secondary mt-2 leading-relaxed">
          The Royals farm system carries {allPlayers.length} minor leaguers across {levelReports.length} levels.
          {elites.length === 0
            ? " There are no elite-ceiling prospects (POT 60+) in the system, which is a major concern for the long-term pipeline."
            : elites.length === 1
            ? ` There is just ${elites.length} elite prospect in the entire system — ${elites[0].Name} (${elites[0].POS}, POT ${elites[0].POT}) — making the talent base extremely top-heavy.`
            : ` There are ${elites.length} elite prospects (POT 60+), headlined by ${elites[0].Name} (${elites[0].POS}, POT ${elites[0].POT}).`}
          {" "}{analysis.cutList.length > 10
            ? `A staggering ${analysis.cutList.length} players are flagged for release, meaning roughly ${Math.round(analysis.cutList.length / allPlayers.length * 100)}% of the system is dead weight stealing development time from real prospects.`
            : analysis.cutList.length > 0
            ? `${analysis.cutList.length} players are flagged for release across the system.`
            : "The roster is lean with no obvious cut candidates."}
          {" "}{totalIssues > 8
            ? `There are ${totalIssues} roster construction issues across all levels — this system needs a significant overhaul.`
            : totalIssues > 3
            ? `There are ${totalIssues} roster construction issues that should be addressed.`
            : "Roster construction is generally solid."}
        </p>
      </div>

      {/* Elite Prospects */}
      <div className="bg-g-card border border-g-border rounded-xl p-5">
        <h2 className="text-[15px] font-semibold mb-3">Franchise Cornerstones</h2>
        {elites.length === 0 ? (
          <p className="text-[13px] text-red-400 leading-relaxed">
            There are zero players with POT 60+ in the system. This is a franchise-level problem. Without elite-ceiling talent, even perfect player development will not produce impact major leaguers. The draft and international free agency pipeline needs to be the #1 priority.
          </p>
        ) : (
          <div className="space-y-2">
            {elites.map((p, i) => (
              <div key={i} className="flex items-center gap-3 bg-yellow-500/5 border border-yellow-500/10 rounded-lg px-4 py-3">
                <span className={`text-2xl font-bold ${potColor(p.POT as number)}`}>{p.POT as number}</span>
                <div className="flex-1">
                  <div className="font-semibold">{p.Name as string}</div>
                  <div className="text-[12px] text-txt-muted">{p.Level as string} — {p.POS as string} — Age {p.Age as number} — Tools {p.ToolAvg as number}</div>
                </div>
              </div>
            ))}
          </div>
        )}
        {solidTier.length > 0 && (
          <div className="mt-4">
            <div className="text-[12px] text-txt-muted uppercase tracking-wider mb-2">Building Blocks (POT 50-59)</div>
            <p className="text-[13px] text-txt-secondary mb-2 leading-relaxed">
              These {solidTier.length} players form the next tier of the system. They project as solid regulars or rotation pieces at the major league level. Protecting their at-bats and innings is critical — they should not be sharing playing time with POT 30 filler.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
              {solidTier.map((p, i) => (
                <div key={i} className="flex items-center gap-2 text-[13px] bg-g-subtle rounded-lg px-3 py-2">
                  <span className={`font-bold w-7 text-center ${potColor(p.POT as number)}`}>{p.POT as number}</span>
                  <span className="font-medium">{p.Name as string}</span>
                  <span className="text-txt-muted text-[11px]">{p.Level as string} — {p.POS as string} — Age {p.Age as number}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Org-Wide Transaction Board */}
      {orgTransfers.length > 0 && (
        <div className="bg-g-card border border-g-border rounded-xl p-5">
          <h2 className="text-[15px] font-semibold mb-2">Org-Wide Transaction Board</h2>
          <p className="text-[13px] text-txt-secondary mb-3 leading-relaxed">
            These are cross-level moves that solve multiple problems at once — fixing a surplus at one level while filling a gap at another. Each move is connected to the bigger picture.
          </p>
          <div className="space-y-2">
            {orgTransfers.map((t, i) => {
              const isPromo = t.reason.startsWith("Promote");
              return (
                <div key={i} className={`flex items-start gap-3 text-[13px] rounded-lg px-4 py-3 border ${isPromo ? "bg-blue-500/5 border-blue-500/10" : "bg-orange-500/5 border-orange-500/10"}`}>
                  <span className={`shrink-0 mt-0.5 text-[11px] font-bold px-2 py-0.5 rounded ${isPromo ? "bg-blue-500/20 text-blue-400" : "bg-orange-500/20 text-orange-400"}`}>
                    {isPromo ? "PROMOTE" : "DEMOTE"}
                  </span>
                  <div className="flex-1 leading-relaxed">
                    <span className="font-semibold">{t.player.Name as string}</span>
                    <span className="text-txt-muted"> ({t.pos}, POT {t.player.POT as number}, Age {t.player.Age as number})</span>
                    <span className="text-txt-muted"> — </span>
                    <span className="text-txt-secondary">{t.from}</span>
                    <span className="text-txt-muted"> to </span>
                    <span className="text-txt-secondary">{t.to}</span>
                    <div className="text-[12px] text-txt-muted mt-1">{t.reason.split(". ").slice(1).join(". ")}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Per-Level Roster Reports */}
      <div>
        <h2 className="text-lg font-semibold mb-3">Level-by-Level Roster Report</h2>
        <div className="space-y-3">
          {levelReports.map((report) => {
            const isExpanded = expandedLevels.has(report.level);
            const healthColor = report.issues.length === 0
              ? "text-green-400"
              : report.issues.length <= 2
              ? "text-yellow-400"
              : "text-red-400";
            const healthLabel = report.issues.length === 0
              ? "Healthy"
              : `${report.issues.length} Issue${report.issues.length > 1 ? "s" : ""}${report.actions.length > 0 ? ` / ${report.actions.length} Move${report.actions.length > 1 ? "s" : ""}` : ""}`;

            return (
              <div key={report.level} className="bg-g-card border border-g-border rounded-xl overflow-hidden">
                <button
                  onClick={() => toggleLevel(report.level)}
                  className="w-full px-5 py-4 flex items-center justify-between hover:bg-g-hover/50 transition-colors text-left"
                >
                  <div className="flex items-center gap-4">
                    <div>
                      <div className="text-[15px] font-semibold">{report.level}</div>
                      <div className="text-[12px] text-txt-muted">
                        {report.total} players — {report.totalHitters}H / {report.totalPitchers}P — Avg POT {report.avgPot} — Avg Age {report.avgAge}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={`text-[12px] font-medium ${healthColor}`}>{healthLabel}</span>
                    <span className="text-txt-muted text-lg">{isExpanded ? "−" : "+"}</span>
                  </div>
                </button>

                {isExpanded && (
                  <div className="border-t border-g-border px-5 py-4 space-y-5">
                    {/* Summary */}
                    <p className="text-[13px] text-txt-secondary leading-relaxed">{report.summary}</p>

                    {/* Position Grid */}
                    {Object.entries(POS_GROUPS).map(([groupName, positions]) => (
                      <div key={groupName}>
                        <div className="text-[11px] text-txt-muted uppercase tracking-wider mb-2">{groupName}</div>
                        <div className="grid grid-cols-3 sm:grid-cols-5 gap-1.5">
                          {positions.map((pos) => {
                            const count = report.posCounts[pos] || 0;
                            const tgt = report.ideal[pos];
                            if (!tgt) return null;
                            const isLow = count < tgt.min;
                            const isHigh = count > tgt.max;
                            const isEmpty = count === 0 && tgt.min > 0;
                            const bg = isEmpty
                              ? "bg-red-500/20 border-red-500/40"
                              : isLow
                              ? "bg-yellow-500/15 border-yellow-500/30"
                              : isHigh
                              ? "bg-orange-500/15 border-orange-500/30"
                              : "bg-g-subtle border-g-border";
                            return (
                              <div key={pos} className={`rounded-lg border px-3 py-2 text-center ${bg}`}>
                                <div className="text-[10px] text-txt-muted font-medium">{pos}</div>
                                <div className={`text-[18px] font-bold ${isEmpty || isLow ? "text-red-400" : isHigh ? "text-orange-400" : "text-txt"}`}>
                                  {count}
                                </div>
                                <div className="text-[9px] text-txt-muted">ideal {tgt.ideal} ({tgt.min}-{tgt.max})</div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}

                    {/* Issues */}
                    {report.issues.length > 0 && (
                      <div>
                        <div className="text-[11px] text-red-400 uppercase tracking-wider mb-2">Issues ({report.issues.length})</div>
                        <div className="space-y-2">
                          {report.issues.map((issue, i) => (
                            <div key={i} className="flex items-start gap-2 text-[13px] bg-red-500/5 rounded-lg px-3 py-2">
                              <span className="text-red-400 mt-0.5 shrink-0">!</span>
                              <span className="text-txt-secondary leading-relaxed">{issue}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Actions */}
                    {report.actions.length > 0 && (
                      <div>
                        <div className="text-[11px] text-accent uppercase tracking-wider mb-2">Recommended Moves ({report.actions.length})</div>
                        <div className="space-y-2">
                          {report.actions.map((action, i) => (
                            <div key={i} className="flex items-start gap-2 text-[13px] bg-accent/5 border border-accent/10 rounded-lg px-3 py-2">
                              <span className="text-accent mt-0.5 shrink-0 font-bold">{i + 1}.</span>
                              <span className="text-txt-secondary leading-relaxed">{action}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Strengths */}
                    {report.strengths.length > 0 && (
                      <div>
                        <div className="text-[11px] text-green-400 uppercase tracking-wider mb-2">Strengths</div>
                        <div className="space-y-1.5">
                          {report.strengths.map((s, i) => (
                            <div key={i} className="flex items-start gap-2 text-[13px] bg-green-500/5 rounded-lg px-3 py-2">
                              <span className="text-green-400 mt-0.5 shrink-0">+</span>
                              <span className="text-txt-secondary">{s}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Cut List */}
      {analysis.cutList.length > 0 && (
        <div className="bg-g-card border border-g-border rounded-xl p-5">
          <h2 className="text-[15px] font-semibold mb-2">Cut List ({analysis.cutList.length})</h2>
          <p className="text-[13px] text-txt-secondary mb-3 leading-relaxed">
            {analysis.cutList.length > 15
              ? `The system is carrying ${analysis.cutList.length} players who should be released immediately. That's ${Math.round(analysis.cutList.length / allPlayers.length * 100)}% of the entire org — every one of these players is taking at-bats, innings, or a roster spot away from someone with actual upside. The majority are low-ceiling relievers clogging the Rookie and Low-A levels.`
              : analysis.cutList.length > 5
              ? `${analysis.cutList.length} players should be released to free up roster spots and development time. Most are too old for their level, too low-potential to project, or both.`
              : `A small group of ${analysis.cutList.length} players are flagged for release based on age and potential.`}
          </p>
          <div className="overflow-x-auto rounded-lg border border-g-border">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="bg-g-subtle border-b border-g-border text-txt-muted text-[10px] uppercase tracking-wider">
                  <th className="px-3 py-2 text-center w-10"></th>
                  <th className="px-3 py-2 text-left">Name</th>
                  <th className="px-3 py-2 text-left">Level</th>
                  <th className="px-3 py-2 text-center">POS</th>
                  <th className="px-3 py-2 text-center">Age</th>
                  <th className="px-3 py-2 text-center">POT</th>
                  <th className="px-3 py-2 text-left">Why</th>
                </tr>
              </thead>
              <tbody>
                {analysis.cutList
                  .sort((a, b) => (a.POT as number) - (b.POT as number) || (b.Age as number) - (a.Age as number))
                  .map((p, i) => {
                    const isCut = cutSet.cuts.has(playerKey(p));
                    return (
                      <tr key={i} className={`border-b border-g-border/30 hover:bg-g-hover/30 ${isCut ? "opacity-40 line-through" : ""}`}>
                        <td className="px-3 py-1.5 text-center"><CutBtn player={p} cutSet={cutSet} /></td>
                        <td className="px-3 py-1.5 font-medium">{p.Name as string}</td>
                        <td className="px-3 py-1.5 text-txt-secondary">{p.Level as string}</td>
                        <td className="px-3 py-1.5 text-center">
                          <span className="bg-g-subtle px-1.5 py-0.5 rounded text-[10px] font-medium">{p.POS as string}</span>
                        </td>
                        <td className="px-3 py-1.5 text-center">{p.Age as number}</td>
                        <td className="px-3 py-1.5 text-center">
                          <span className={potColor(p.POT as number)}>{p.POT as number}</span>
                        </td>
                        <td className="px-3 py-1.5 text-[12px]">
                          <div className="flex gap-1 flex-wrap">
                            {p.flags.filter((f) => f.type === "critical").map((f, j) => (
                              <span key={j}>{flagBadge(f)}</span>
                            ))}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Promote Candidates */}
      {analysis.promoteCandidates.length > 0 && (
        <div className="bg-g-card border border-g-border rounded-xl p-5">
          <h2 className="text-[15px] font-semibold mb-2">Promotion Candidates ({analysis.promoteCandidates.length})</h2>
          <p className="text-[13px] text-txt-secondary mb-3 leading-relaxed">
            These players have outgrown their current level based on age and potential. Promoting them would help fill gaps at higher levels while giving them a better development environment.
          </p>
          <div className="space-y-1">
            {analysis.promoteCandidates
              .sort((a, b) => (b.POT as number) - (a.POT as number))
              .map((p, i) => (
                <div key={i} className="flex items-center gap-3 text-[13px] bg-blue-500/5 rounded-lg px-3 py-2">
                  <span className="bg-g-subtle px-1.5 py-0.5 rounded text-[10px] font-medium w-7 text-center">{p.POS as string}</span>
                  <span className="font-medium flex-1">{p.Name as string}</span>
                  <span className="text-txt-muted">{p.Level as string}</span>
                  <span className="text-txt-muted">Age {p.Age as number}</span>
                  <span className={potColor(p.POT as number)}>POT {p.POT as number}</span>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Pipeline Funnel */}
      <div className="bg-g-card border border-g-border rounded-xl p-5">
        <h2 className="text-[15px] font-semibold mb-2">Pipeline Funnel</h2>
        <p className="text-[13px] text-txt-secondary mb-3 leading-relaxed">
          {(() => {
            const dsl = levelReports.find((r) => r.level === "Rookie-DSL");
            const aaa = levelReports.find((r) => r.level === "AAA");
            const highA = levelReports.find((r) => r.level === "High-A");
            const lowA = levelReports.find((r) => r.level === "Low-A");
            let text = "";
            if (dsl && aaa) {
              text += `The system funnels from ${dsl.total} players at Rookie-DSL down to ${aaa.total} at AAA. `;
            }
            if (lowA && highA && lowA.total - highA.total > 10) {
              text += `The sharpest drop-off is between Low-A (${lowA.total}) and High-A (${highA.total}), a loss of ${lowA.total - highA.total} players — this could indicate overly aggressive attrition or a failure to promote ready players. `;
            }
            const thinLevels = levelReports.filter((r) => r.total < (ROSTER_TARGETS[r.level]?.min || 25));
            if (thinLevels.length > 0) {
              text += `${thinLevels.map((l) => l.level).join(" and ")} ${thinLevels.length === 1 ? "is" : "are"} running below minimum roster size.`;
            }
            return text || "The pipeline is evenly distributed across all levels.";
          })()}
        </p>
        <div className="flex items-end gap-2">
          {levelReports.map((report, i) => {
            const maxTotal = Math.max(...levelReports.map((r) => r.total));
            const pct = (report.total / maxTotal) * 100;
            const prevTotal = i > 0 ? levelReports[i - 1].total : null;
            const drop = prevTotal ? prevTotal - report.total : null;
            const target = ROSTER_TARGETS[report.level] || { min: 25 };
            return (
              <div key={report.level} className="flex-1 flex flex-col items-center gap-1">
                <div className="text-[12px] font-semibold">{report.total}</div>
                <div
                  className={`w-full rounded-t-lg ${report.total < target.min ? "bg-orange-500/40" : "bg-accent/30"}`}
                  style={{ height: `${Math.max(pct * 1.5, 12)}px` }}
                />
                <div className="text-[10px] text-txt-muted text-center leading-tight">{report.level.replace("Rookie-", "R-")}</div>
                {drop !== null && drop > 10 && (
                  <div className="text-[10px] text-red-400">-{drop}</div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// MOVES TAB
// ════════════════════════════════════════════════════════════

function MovesTab({
  levelReports, orgTransfers, analysis, cutSet,
}: {
  levelReports: LevelReport[];
  orgTransfers: Transfer[];
  analysis: ReturnType<typeof analyzeOrg>;
  cutSet: CutSet;
}) {
  // Collect ALL actions from all levels
  const allActions = useMemo(() => {
    const moves: { category: string; categoryColor: string; items: string[] }[] = [];

    // 1. Org-wide transfers (promote/demote)
    if (orgTransfers.length > 0) {
      moves.push({
        category: "Transfers",
        categoryColor: "text-blue-400",
        items: orgTransfers.map((t) => t.reason),
      });
    }

    // 2. Releases from cut list
    if (analysis.cutList.length > 0) {
      // Group by level
      const byLevel: Record<string, string[]> = {};
      for (const p of analysis.cutList.sort((a, b) => (a.POT as number) - (b.POT as number))) {
        const lv = p.Level as string;
        if (!byLevel[lv]) byLevel[lv] = [];
        byLevel[lv].push(`${p.Name} (${p.POS}, Age ${p.Age}, POT ${p.POT})`);
      }
      const releaseItems: string[] = [];
      for (const lv of Object.keys(byLevel)) {
        releaseItems.push(`${lv}: Release ${byLevel[lv].join(", ")}.`);
      }
      moves.push({
        category: "Releases",
        categoryColor: "text-red-400",
        items: releaseItems,
      });
    }

    // 3. Per-level specific actions (excluding SEND/RECEIVE which are already in transfers)
    const levelActions: string[] = [];
    for (const report of levelReports) {
      for (const action of report.actions) {
        if (action.startsWith("SEND:") || action.startsWith("RECEIVE:")) continue;
        levelActions.push(`${report.level}: ${action}`);
      }
    }
    if (levelActions.length > 0) {
      moves.push({
        category: "Roster Fixes",
        categoryColor: "text-orange-400",
        items: levelActions,
      });
    }

    // 4. Promotions from analysis
    if (analysis.promoteCandidates.length > 0) {
      moves.push({
        category: "Additional Promotions",
        categoryColor: "text-green-400",
        items: analysis.promoteCandidates
          .filter((p) => !orgTransfers.some((t) => playerKey(t.player) === playerKey(p)))
          .sort((a, b) => (b.POT as number) - (a.POT as number))
          .map((p) => {
            const reason = p.flags.find((f: Flag) => f.tag === "PROMOTE");
            return `${p.Name} (${p.POS}, POT ${p.POT}, Age ${p.Age}) at ${p.Level}${reason ? " — " + reason.msg : ""}.`;
          }),
      });
    }

    return moves.filter((m) => m.items.length > 0);
  }, [levelReports, orgTransfers, analysis]);

  const totalMoves = allActions.reduce((s, a) => s + a.items.length, 0);

  return (
    <div className="space-y-6">
      <div className="bg-g-card border border-g-border rounded-xl p-6">
        <div className="text-txt-muted text-[11px] uppercase tracking-wider mb-1">Action Plan</div>
        <p className="text-[15px] text-txt-secondary mt-2 leading-relaxed">
          {totalMoves} total moves to optimize the farm system. Transfers rebalance position depth across levels, releases clear dead weight, and roster fixes address level-specific issues.
        </p>
      </div>

      {allActions.map((section, si) => (
        <div key={si} className="bg-g-card border border-g-border rounded-xl p-5">
          <div className="flex items-center gap-2 mb-4">
            <h2 className={`text-[15px] font-semibold ${section.categoryColor}`}>{section.category}</h2>
            <span className={`text-[12px] ${section.categoryColor} bg-g-subtle border border-g-border px-2 py-0.5 rounded-full`}>
              {section.items.length}
            </span>
          </div>
          <div className="space-y-2">
            {section.items.map((item, i) => {
              // For releases, add cut buttons
              if (section.category === "Releases") {
                return (
                  <div key={i} className="text-[13px] bg-red-500/5 border border-red-500/10 rounded-lg px-4 py-2.5 leading-relaxed">
                    <span className="text-txt-secondary">{item}</span>
                  </div>
                );
              }
              const color = section.category === "Transfers"
                ? item.startsWith("Promote") ? "bg-blue-500/5 border-blue-500/10" : "bg-orange-500/5 border-orange-500/10"
                : section.category === "Roster Fixes"
                ? "bg-orange-500/5 border-orange-500/10"
                : "bg-green-500/5 border-green-500/10";
              return (
                <div key={i} className={`text-[13px] border rounded-lg px-4 py-2.5 leading-relaxed ${color}`}>
                  <span className="text-txt-secondary">{item}</span>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {/* Quick cut checklist */}
      {analysis.cutList.length > 0 && (
        <div className="bg-g-card border border-g-border rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-[15px] font-semibold text-red-400">Cut Checklist</h2>
            {cutSet.count > 0 && (
              <div className="flex items-center gap-3">
                <span className="text-[13px] text-txt-muted">{cutSet.count} / {analysis.cutList.length} marked</span>
                <button
                  onClick={cutSet.clearAll}
                  className="text-[12px] text-txt-muted hover:text-txt border border-g-border rounded-md px-2 py-1 hover:bg-g-hover transition-colors"
                >
                  Reset
                </button>
              </div>
            )}
          </div>
          <div className="space-y-1">
            {analysis.cutList
              .sort((a, b) => (a.POT as number) - (b.POT as number) || (b.Age as number) - (a.Age as number))
              .map((p, i) => {
                const isCut = cutSet.cuts.has(playerKey(p));
                return (
                  <div
                    key={i}
                    className={`flex items-center gap-3 text-[13px] rounded-lg px-3 py-1.5 transition-colors ${isCut ? "opacity-40" : "hover:bg-g-hover/30"}`}
                  >
                    <CutBtn player={p} cutSet={cutSet} />
                    <span className={`font-medium flex-1 ${isCut ? "line-through" : ""}`}>{p.Name as string}</span>
                    <span className="text-txt-muted text-[12px]">{p.Level as string}</span>
                    <span className="bg-g-subtle px-1.5 py-0.5 rounded text-[10px] font-medium">{p.POS as string}</span>
                    <span className="text-txt-muted text-[12px]">Age {p.Age as number}</span>
                    <span className={`text-[12px] ${potColor(p.POT as number)}`}>POT {p.POT as number}</span>
                  </div>
                );
              })}
          </div>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// SHARED COMPONENTS
// ════════════════════════════════════════════════════════════

function OverviewTab({ overview }: { overview: Overview[] }) {
  return (
    <div className="grid gap-3">
      {overview.map((o) => (
        <div key={o.level} className="bg-g-card border border-g-border rounded-xl px-5 py-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-[15px] font-semibold">{o.level}</h3>
            <span className="text-[12px] text-txt-muted">{o.hitters + o.pitchers} players</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-[13px]">
            <Stat label="Hitters" value={o.hitters} />
            <Stat label="Pitchers" value={o.pitchers} />
            <Stat label="Avg POT (Bat)" value={o.avgPotBat ?? "—"} colored={o.avgPotBat} />
            <Stat label="Avg POT (Pit)" value={o.avgPotPit ?? "—"} colored={o.avgPotPit} />
          </div>
          <div className="flex gap-6 mt-3 text-[12px] text-txt-secondary">
            {o.bestBat && <span>Best Bat: <span className="text-accent">{o.bestBat}</span></span>}
            {o.bestPit && <span>Best Arm: <span className="text-accent">{o.bestPit}</span></span>}
          </div>
        </div>
      ))}
    </div>
  );
}

function Stat({ label, value, colored }: { label: string; value: string | number; colored?: number | null }) {
  return (
    <div>
      <div className="text-txt-muted text-[11px] uppercase tracking-wider mb-0.5">{label}</div>
      <div className={colored ? potColor(colored) : "text-txt font-medium"}>{value}</div>
    </div>
  );
}

function PlayerTable({
  players, toolCols, extraCols, ranked, cutSet,
}: {
  players: Player[];
  toolCols: string[];
  extraCols: string[];
  ranked?: boolean;
  cutSet?: CutSet;
}) {
  if (players.length === 0) {
    return <p className="text-txt-muted text-sm">No players match your filters.</p>;
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-g-border">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="bg-g-card border-b border-g-border text-txt-muted text-[11px] uppercase tracking-wider">
            {cutSet && <th className="px-3 py-2.5 text-center w-10"></th>}
            {ranked && <th className="px-3 py-2.5 text-left">#</th>}
            <th className="px-3 py-2.5 text-left">Level</th>
            <th className="px-3 py-2.5 text-left">POS</th>
            <th className="px-3 py-2.5 text-left">Name</th>
            <th className="px-3 py-2.5 text-center">Age</th>
            <th className="px-3 py-2.5 text-center">B/T</th>
            <th className="px-3 py-2.5 text-center">POT</th>
            <th className="px-3 py-2.5 text-center">Tools</th>
            {toolCols.map((c) => (
              <th key={c} className="px-2 py-2.5 text-center">{c.replace(" P", "")}</th>
            ))}
            {extraCols.map((c) => (
              <th key={c} className="px-2 py-2.5 text-center">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {players.map((p, i) => {
            const isCut = cutSet ? cutSet.cuts.has(playerKey(p)) : false;
            return (
            <tr
              key={`${p.Name}-${p.Level}-${i}`}
              className={`border-b border-g-border/50 hover:bg-g-hover/50 transition-colors ${isCut ? "opacity-40 line-through" : ""}`}
            >
              {cutSet && <td className="px-3 py-2 text-center"><CutBtn player={p} cutSet={cutSet} /></td>}
              {ranked && <td className="px-3 py-2 text-txt-muted font-medium">{i + 1}</td>}
              <td className="px-3 py-2 text-txt-secondary">{p.Level as string}</td>
              <td className="px-3 py-2">
                <span className="bg-g-subtle px-1.5 py-0.5 rounded text-[11px] font-medium">{p.POS as string}</span>
              </td>
              <td className="px-3 py-2 font-medium whitespace-nowrap">{p.Name as string}</td>
              <td className="px-3 py-2 text-center text-txt-secondary">{p.Age as number}</td>
              <td className="px-3 py-2 text-center text-txt-secondary">{p.B as string}/{p.T as string}</td>
              <td className="px-3 py-2 text-center">
                <span className={`inline-block w-8 py-0.5 rounded text-[12px] font-semibold ${potBg(p.POT as number)} ${potColor(p.POT as number)}`}>
                  {p.POT as number}
                </span>
              </td>
              <td className="px-3 py-2 text-center">
                <span className={potColor(p.ToolAvg as number)}>{p.ToolAvg as number}</span>
              </td>
              {toolCols.map((c) => (
                <td key={c} className="px-2 py-2 text-center">
                  <span className={potColor(p[c] as number)}>
                    {p[c] != null && p[c] !== "" ? (p[c] as number) : "—"}
                  </span>
                </td>
              ))}
              {extraCols.map((c) => (
                <td key={c} className="px-2 py-2 text-center text-txt-secondary whitespace-nowrap">
                  {p[c] != null && p[c] !== "" ? String(p[c]) : "—"}
                </td>
              ))}
            </tr>
          );
          })}
        </tbody>
      </table>
    </div>
  );
}
