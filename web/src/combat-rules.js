// combat-rules.js — правила боя игровой системы на стороне клиента. Сами
// правила решает сервер (domain.CombatRules, internal/service/room.go), сюда
// приходит только то, что нужно для отрисовки трекера: combat_state.zeroHp —
// что происходит с бойцом на 0 хитов.

// deathSavesFor — {success, fail} (сколько лампочек рисовать), если этот
// боец на 0 хитов по правилам системы бросает спасброски от смерти, иначе
// null. Правило своё у персонажей (characterId) и у остальных.
export function deathSavesFor(zeroHp, cmb) {
  if (!zeroHp || !cmb || !zeroHp.deathSaves) return null;
  const mode = cmb.characterId ? zeroHp.character : zeroHp.other;
  if (mode !== "deathSaves") return null;
  const { success, fail } = zeroHp.deathSaves;
  if (!(success > 0) || !(fail > 0)) return null;
  return { success, fail };
}
