import { Container, Graphics, Text, BlurFilter } from "pixi.js";
import { dashedPolyline } from "../dash.js";
import { fogAreaHandles, fogAreaCenter } from "../../geometry.js";

// Зоны ручного тумана (domain.FogArea) — замкнутые контуры, которые ДМ
// рисует точками (как стены, см. interaction.js: tool "fog") и по своей
// команде скрывает/показывает игрокам, не стирая (FogArea.Revealed). У
// игрока скрытая зона — СПЛОШНАЯ тьма: непрозрачная заливка поверх всего
// (слой лежит выше vision-fog и токенов, см. index.js), сквозь неё не
// видно ни факела, ни тёмного зрения — только мягкий край наружу (блюр).
// ДМ видит все зоны всегда: пунктирный контур, подпись с именем и режимом,
// а внутри инструмента «Туман» — ещё и точки-ручки для правки.
//
// Свет показанной зоны (FogArea.Light) рисует НЕ этот слой, а vision-fog по
// плану из vision-plan.js (applyZones) — тут он только отражается в цвете
// заливки и значке подписи у ДМ, чтобы режим читался с карты без панели.
//
// Геометрия перестраивается только по dirty.manualFog — правка зон, смена
// инструмента, пан/зум (у линий и ручек постоянная ЭКРАННАЯ толщина, у
// подписи — экранный размер); блюр края — GPU-шейдер (BlurFilter).

// Цвет контура/заливки у ДМ по состоянию зоны. Скрытая — тот же голубой,
// что и раньше (не путать со стенами: те сплошные, тут пунктир); показанная
// игрокам — приглушённая серая, чтобы с одного взгляда видеть, где туман
// ещё лежит. Свет — своим оттенком: тёплый у освещённой, фиолетовый у тьмы.
const HIDDEN_COLOR = 0x8bc3ff;
const REVEALED_COLOR = 0x9aa7b8;
const LIGHT_TINT = { bright: 0xffd866, dim: 0xd9b45a, dark: 0x8b5cf6 };
const LIGHT_GLYPH = { bright: "☀", dim: "◐", dark: "●" };

// FOG_FILL — тьма скрытой зоны у игрока: тот же почти-чёрный, что у крыши
// здания (layers/buildings.js), непрозрачный.
const FOG_FILL = 0x06060a;

// zoneStyle — цвет и подпись состояния зоны для ДМ (общая для слоя и панели
// «Туман» в pages/dm.js — там та же логика словами).
export function zoneStyle(zone) {
  const color = zone.light ? LIGHT_TINT[zone.light] : zone.revealed ? REVEALED_COLOR : HIDDEN_COLOR;
  return { color, glyph: zone.light ? LIGHT_GLYPH[zone.light] : "", revealed: !!zone.revealed };
}

export function createManualFogLayer(ctx) {
  const container = new Container();
  const dmOutline = new Graphics();
  const dmHandles = new Graphics();
  const dmLabels = new Container();
  const playerHalo = new Graphics(); // размытая копия заливки — мягкий край НАРУЖУ
  const playerFill = new Graphics(); // сплошная заливка — внутри не просвечивает ни на пиксель
  playerHalo.filters = [new BlurFilter({ strength: 14, quality: 4 })];
  container.addChild(playerHalo, playerFill, dmOutline, dmLabels, dmHandles);

  const labels = new Map(); // id -> {text, bg} — retained: Text пересоздавать на каждый пан дорого

  function rebuildDM(areas) {
    const scale = ctx.world.scale.x || 1;
    for (const area of areas) {
      const { color, revealed } = zoneStyle(area);
      dmOutline.poly(area.points).fill({ color, alpha: revealed ? 0.04 : 0.1 });
      // Показанная зона — редкий пунктир: контур остаётся ориентиром, но не
      // спорит с настоящими (скрытыми) облаками.
      dashedPolyline(dmOutline, area.points, revealed ? 3 : 7, revealed ? 6 : 4, true);
      dmOutline.stroke({ width: 2 / scale, color, alpha: revealed ? 0.5 : 0.75 });
    }

    // Подписи — только у зон с именем или режимом: безымянная скрытая зона
    // читается по самому облаку, лишняя плашка тут — шум.
    const seen = new Set();
    for (const area of areas) {
      const { color, glyph } = zoneStyle(area);
      const text = [glyph, area.name || ""].filter(Boolean).join(" ");
      if (!text) continue;
      seen.add(area.id);
      let view = labels.get(area.id);
      if (!view) {
        view = {
          bg: new Graphics(),
          text: new Text({ text: "", style: { fill: 0xffffff, fontSize: 12, fontFamily: "sans-serif", fontWeight: "600", align: "center" } }),
        };
        view.text.anchor.set(0.5, 0.5);
        dmLabels.addChild(view.bg, view.text);
        labels.set(area.id, view);
      }
      const c = fogAreaCenter(area.points);
      if (view.text.text !== text) view.text.text = text;
      view.text.style.fill = color;
      // Экранный размер подписи: мир масштабируется камерой, подпись — нет.
      view.text.scale.set(1 / scale);
      view.text.position.set(c.x, c.y);
      // width/height у уже отмасштабированного Text — в мировых единицах,
      // поля тоже переводим из экранных.
      const w = view.text.width + 12 / scale;
      const h = view.text.height + 6 / scale;
      view.bg.clear();
      view.bg.roundRect(c.x - w / 2, c.y - h / 2, w, h, 5 / scale).fill({ color: 0x0b0d14, alpha: 0.72 });
    }
    for (const [id, view] of labels) {
      if (seen.has(id)) continue;
      view.bg.destroy();
      view.text.destroy();
      labels.delete(id);
    }

    // Точки-ручки — та же идиома, что у стен (layers/walls.js): за них
    // хватает мышью interaction.js, и только пока активен сам инструмент
    // «Туман». Запертая зона — ручки без белой середины: тянуть нельзя.
    if (ctx.tool !== "fog") return;
    for (const area of areas) {
      const { color } = zoneStyle(area);
      for (const h of fogAreaHandles(area)) {
        dmHandles
          .circle(h.x, h.y, 5 / scale)
          .fill(area.locked ? color : 0xffffff)
          .stroke({ width: 1.5 / scale, color, alpha: area.locked ? 0.5 : 1 });
      }
    }
  }

  function rebuild() {
    dmOutline.clear();
    dmHandles.clear();
    playerFill.clear();
    playerHalo.clear();
    const areas = Object.values(ctx.scene.fogAreas || {}).filter((a) => a.points.length >= 3);
    if (ctx.isDM) {
      rebuildDM(areas);
      return;
    }
    for (const view of labels.values()) {
      view.bg.destroy();
      view.text.destroy();
    }
    labels.clear();
    for (const area of areas) {
      if (area.revealed) continue;
      playerFill.poly(area.points).fill({ color: FOG_FILL, alpha: 1 });
      playerHalo.poly(area.points).fill({ color: FOG_FILL, alpha: 1 });
    }
  }

  function update() {
    if (ctx.dirty.manualFog) rebuild();
  }

  return { container, update };
}
