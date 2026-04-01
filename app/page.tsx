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

type Tab = "overview" | "hitters" | "pitchers" | "top" | "algo" | "insights";

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
        {(["algo", "insights", "overview", "top", "hitters", "pitchers"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => { setTab(t); setPosFilter("All"); }}
            className={`px-4 py-1.5 rounded-md text-[13px] font-medium transition-all ${
              tab === t
                ? "bg-accent/15 text-accent"
                : "text-txt-secondary hover:text-txt hover:bg-g-hover"
            }`}
          >
            {t === "algo" ? "Algo" : t === "insights" ? "Insights" : t === "overview" ? "Overview" : t === "top" ? "Top Prospects" : t === "hitters" ? "Hitters" : "Pitchers"}
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
      {tab === "insights" && <InsightsTab analysis={analysis} hitters={data.hitters} pitchers={data.pitchers} cutSet={cutSet} />}
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

function InsightsTab({
  analysis, hitters, pitchers, cutSet,
}: {
  analysis: ReturnType<typeof analyzeOrg>;
  hitters: Player[];
  pitchers: Player[];
  cutSet: CutSet;
}) {
  // Elite prospects (POT >= 60)
  const elites = useMemo(() =>
    [...hitters, ...pitchers]
      .filter((p) => (p.POT as number) >= 60)
      .sort((a, b) => (b.POT as number) - (a.POT as number)),
  [hitters, pitchers]);

  // Solid tier (POT 50-59)
  const solidTier = useMemo(() =>
    [...hitters, ...pitchers]
      .filter((p) => (p.POT as number) >= 50 && (p.POT as number) < 60)
      .sort((a, b) => (b.POT as number) - (a.POT as number)),
  [hitters, pitchers]);

  // Level staffing stats
  const levelStats = useMemo(() => {
    const levels = ["Rookie-DSL", "Rookie-ACL", "Low-A", "High-A", "AA", "AAA"];
    return levels.map((level) => {
      const h = hitters.filter((p) => p.Level === level);
      const p = pitchers.filter((pp) => pp.Level === level);
      const total = h.length + p.length;
      const target = ROSTER_TARGETS[level] || { min: 25, max: 30, ideal: 28 };
      const sp = p.filter((pp) => pp.POS === "SP");
      const rp = p.filter((pp) => pp.POS === "RP" || pp.POS === "CL");
      const avgPot = total > 0
        ? Math.round([...h, ...p].reduce((s, pp) => s + (pp.POT as number), 0) / total)
        : 0;

      // Position gaps
      const keyPositions = ["C", "SS", "CF"];
      const gaps = keyPositions.filter((pos) => !h.some((pp) => pp.POS === pos));

      return { level, hitters: h.length, pitchers: p.length, total, target, sp: sp.length, rp: rp.length, avgPot, gaps };
    }).filter((l) => l.total > 0);
  }, [hitters, pitchers]);

  // RP bloat per level
  const rpBloat = useMemo(() =>
    levelStats.filter((l) => l.rp > 10),
  [levelStats]);

  // Understaffed levels
  const understaffed = useMemo(() =>
    levelStats.filter((l) => l.total < l.target.min),
  [levelStats]);

  return (
    <div className="space-y-6">
      {/* Hero: System Health */}
      <div className="bg-g-card border border-g-border rounded-xl p-6">
        <div className="text-txt-muted text-[11px] uppercase tracking-wider mb-1">System Health Report</div>
        <div className="text-[15px] text-txt-secondary mt-2">
          {hitters.length + pitchers.length} players across {levelStats.length} levels — {elites.length} elite prospect{elites.length !== 1 ? "s" : ""}, {analysis.cutList.length} cut candidates, {analysis.gaps.length} position gaps
        </div>
      </div>

      {/* 1. Elite Prospects */}
      <div className="bg-g-card border border-g-border rounded-xl p-5">
        <div className="flex items-center gap-2 mb-4">
          <span className="text-lg">1</span>
          <h2 className="text-[15px] font-semibold">Elite Prospects (POT 60+)</h2>
          <span className="text-[12px] text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 px-2 py-0.5 rounded-full">
            {elites.length} found — thin system
          </span>
        </div>
        {elites.length === 0 ? (
          <p className="text-red-400 text-[13px]">No elite-tier prospects in the system. Extremely concerning.</p>
        ) : (
          <div className="space-y-2">
            {elites.map((p, i) => (
              <div key={i} className="flex items-center gap-3 bg-yellow-500/5 border border-yellow-500/10 rounded-lg px-4 py-3">
                <span className={`text-2xl font-bold ${potColor(p.POT as number)}`}>{p.POT as number}</span>
                <div className="flex-1">
                  <div className="font-semibold">{p.Name as string}</div>
                  <div className="text-[12px] text-txt-muted">{p.Level as string} — {p.POS as string} — Age {p.Age as number}</div>
                </div>
                <span className="text-[12px] text-txt-muted">Tools {p.ToolAvg as number}</span>
              </div>
            ))}
          </div>
        )}
        {solidTier.length > 0 && (
          <div className="mt-4">
            <div className="text-[12px] text-txt-muted uppercase tracking-wider mb-2">Next Tier (POT 50-59) — protect their development</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
              {solidTier.map((p, i) => (
                <div key={i} className="flex items-center gap-2 text-[13px] bg-g-subtle rounded-lg px-3 py-2">
                  <span className={`font-bold w-7 text-center ${potColor(p.POT as number)}`}>{p.POT as number}</span>
                  <span className="font-medium">{p.Name as string}</span>
                  <span className="text-txt-muted text-[11px]">{p.Level as string} — {p.POS as string} — {p.Age as number}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 2. Cut Dead Weight */}
      <div className="bg-g-card border border-g-border rounded-xl p-5">
        <div className="flex items-center gap-2 mb-4">
          <span className="text-lg">2</span>
          <h2 className="text-[15px] font-semibold">Cut Dead Weight</h2>
          <span className="text-[12px] text-red-400 bg-red-500/10 border border-red-500/20 px-2 py-0.5 rounded-full">
            {analysis.cutList.length} players to release
          </span>
        </div>
        <p className="text-[13px] text-txt-secondary mb-3">
          These players are too old and/or too low-potential for their level. Releasing them frees roster spots and playing time for real prospects.
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
        {/* Breakdown by level */}
        <div className="mt-3 flex gap-2 flex-wrap">
          {levelStats.map((l) => {
            const cutsAtLevel = analysis.cutList.filter((p) => p.Level === l.level).length;
            if (cutsAtLevel === 0) return null;
            return (
              <span key={l.level} className="text-[11px] bg-red-500/10 text-red-400 border border-red-500/20 px-2 py-0.5 rounded-full">
                {l.level}: {cutsAtLevel}
              </span>
            );
          })}
        </div>
      </div>

      {/* 3. Understaffed Levels */}
      {understaffed.length > 0 && (
        <div className="bg-g-card border border-g-border rounded-xl p-5">
          <div className="flex items-center gap-2 mb-4">
            <span className="text-lg">3</span>
            <h2 className="text-[15px] font-semibold">Understaffed Levels</h2>
            <span className="text-[12px] text-orange-400 bg-orange-500/10 border border-orange-500/20 px-2 py-0.5 rounded-full">
              {understaffed.length} level{understaffed.length !== 1 ? "s" : ""} below minimum
            </span>
          </div>
          <div className="space-y-2">
            {understaffed.map((l) => (
              <div key={l.level} className="flex items-center justify-between bg-orange-500/5 border border-orange-500/10 rounded-lg px-4 py-3">
                <div>
                  <div className="font-semibold text-[14px]">{l.level}</div>
                  <div className="text-[12px] text-txt-muted">
                    {l.total} players ({l.hitters}H / {l.pitchers}P) — target {l.target.min}-{l.target.max}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-orange-400 text-[13px] font-medium">{l.target.min - l.total} players short</div>
                  {l.gaps.length > 0 && (
                    <div className="text-[11px] text-red-400">Missing: {l.gaps.join(", ")}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 4. Position Gaps */}
      {analysis.gaps.length > 0 && (
        <div className="bg-g-card border border-g-border rounded-xl p-5">
          <div className="flex items-center gap-2 mb-4">
            <span className="text-lg">4</span>
            <h2 className="text-[15px] font-semibold">Position Gaps</h2>
            <span className="text-[12px] text-red-400 bg-red-500/10 border border-red-500/20 px-2 py-0.5 rounded-full">
              {analysis.gaps.length} gaps
            </span>
          </div>
          <p className="text-[13px] text-txt-secondary mb-3">
            Positions to target in the draft, IFA, or trades.
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
            {analysis.gaps.map((g, i) => (
              <div key={i} className="bg-g-subtle border border-g-border rounded-lg px-3 py-2 flex items-center gap-2">
                <span className="bg-red-500/20 text-red-400 border border-red-500/30 px-1.5 py-0.5 rounded text-[10px] font-semibold">
                  {g.pos}
                </span>
                <span className="text-[13px] text-txt-secondary">{g.level}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 5. RP Bloat */}
      {rpBloat.length > 0 && (
        <div className="bg-g-card border border-g-border rounded-xl p-5">
          <div className="flex items-center gap-2 mb-4">
            <span className="text-lg">5</span>
            <h2 className="text-[15px] font-semibold">Reliever Bloat</h2>
          </div>
          <p className="text-[13px] text-txt-secondary mb-3">
            These levels carry an excessive number of relievers, stealing development innings from real prospects.
          </p>
          <div className="space-y-2">
            {rpBloat.map((l) => (
              <div key={l.level} className="flex items-center justify-between bg-g-subtle rounded-lg px-4 py-3">
                <div>
                  <div className="font-semibold text-[14px]">{l.level}</div>
                  <div className="text-[12px] text-txt-muted">{l.sp} SP / {l.rp} RP+CL — {l.total} total</div>
                </div>
                <div className="text-orange-400 text-[13px] font-medium">{l.rp - 8} excess relievers</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 6. Promote Candidates */}
      {analysis.promoteCandidates.length > 0 && (
        <div className="bg-g-card border border-g-border rounded-xl p-5">
          <div className="flex items-center gap-2 mb-4">
            <span className="text-lg">6</span>
            <h2 className="text-[15px] font-semibold">Promotion Candidates</h2>
            <span className="text-[12px] text-blue-400 bg-blue-500/10 border border-blue-500/20 px-2 py-0.5 rounded-full">
              {analysis.promoteCandidates.length} ready
            </span>
          </div>
          <p className="text-[13px] text-txt-secondary mb-3">
            Players who may be ready for a level bump based on age and potential.
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
                  <div className="flex gap-1">
                    {p.flags.filter((f) => f.tag === "PROMOTE").map((f, j) => (
                      <span key={j}>{flagBadge(f)}</span>
                    ))}
                  </div>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* 7. Pipeline Funnel */}
      <div className="bg-g-card border border-g-border rounded-xl p-5">
        <div className="flex items-center gap-2 mb-4">
          <span className="text-lg">7</span>
          <h2 className="text-[15px] font-semibold">Pipeline Funnel</h2>
        </div>
        <p className="text-[13px] text-txt-secondary mb-3">
          How player counts change level-to-level. Sharp drops may indicate aggressive attrition or failure to promote.
        </p>
        <div className="flex items-end gap-2">
          {levelStats.map((l, i) => {
            const maxTotal = Math.max(...levelStats.map((ll) => ll.total));
            const pct = (l.total / maxTotal) * 100;
            const prevTotal = i > 0 ? levelStats[i - 1].total : null;
            const drop = prevTotal ? prevTotal - l.total : null;
            return (
              <div key={l.level} className="flex-1 flex flex-col items-center gap-1">
                <div className="text-[12px] font-semibold">{l.total}</div>
                <div
                  className={`w-full rounded-t-lg ${l.total < l.target.min ? "bg-orange-500/40" : "bg-accent/30"}`}
                  style={{ height: `${Math.max(pct * 1.5, 12)}px` }}
                />
                <div className="text-[10px] text-txt-muted text-center leading-tight">{l.level.replace("Rookie-", "R-")}</div>
                {drop !== null && drop > 15 && (
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
