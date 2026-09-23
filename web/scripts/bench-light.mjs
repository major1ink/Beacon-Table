// Замер пересчёта света на сцене из файла: node scripts/bench-light.mjs <scene.json>
import { readFileSync } from "node:fs";
import { computeVisionPlanWithFallback } from "../src/vtt/vision-plan.js";

const raw = JSON.parse(readFileSync(process.argv[2], "utf8"));
const base = raw.scene || raw;
const G = base.grid.size;

function clone(s) {
  return { ...s, tokens: { ...s.tokens }, walls: { ...s.walls } };
}

function run(label, isDM, prepare, steps) {
  let scene = clone(base);
  prepare && prepare(scene);
  const memo = {};
  computeVisionPlanWithFallback(scene, isDM, memo); // прогрев кэша
  const times = [];
  for (let i = 0; i < steps.length; i++) {
    scene = clone(scene);
    steps[i](scene);
    const t0 = performance.now();
    const { plan, error } = computeVisionPlanWithFallback(scene, isDM, memo);
    times.push(performance.now() - t0);
    if (!plan) throw error;
  }
  times.sort((a, b) => a - b);
  const p = (q) => times[Math.min(times.length - 1, Math.floor(times.length * q))].toFixed(1);
  console.log(`${label.padEnd(28)} median ${p(0.5).padStart(6)} мс  p95 ${p(0.95).padStart(6)}  max ${p(1).padStart(6)}`);
}

const walk = (id, n) => Array.from({ length: n }, () => (s) => { s.tokens[id] = { ...s.tokens[id], x: s.tokens[id].x + G }; });
const owners = (s) => { for (const id in s.tokens) if (id.startsWith("pt-pc")) s.tokens[id] = { ...s.tokens[id], ownerId: "p1" }; };
const doors = Object.values(base.walls).filter((w) => w.door).slice(0, 10).map((w) => w.id);
const toggle = doors.map((id) => (s) => { s.walls[id] = { ...s.walls[id], doorState: "open" }; });

run("ДМ: шаг PC с факелом", true, null, walk("pt-pc0", 20));
run("Игрок: шаг PC с факелом", false, owners, walk("pt-pc0", 20));
run("Игрок: шаг PC без света", false, owners, walk("pt-pc3", 20));
run("Игрок: открыть дверь", false, owners, toggle);
run("ДМ: открыть дверь", true, null, toggle);
