import test from "node:test";
import assert from "node:assert/strict";
import { createCamera, getTransform, clampCamera, resetCamera, zoomAt } from "../src/vtt/camera.js";

// Зона показа (scene.viewBounds ставит net.js игроку и трансляции): камера
// вписывает её, а не всю карту, и не выпускает вид за её край.
const scene = { width: 2000, height: 1000, viewBounds: { x: 500, y: 200, w: 800, h: 400 } };

test("камера вписывает зону показа, а не холст", () => {
  const cam = createCamera(scene);
  assert.deepEqual([cam.x, cam.y], [900, 400]);
  const { scale } = getTransform(800, 400, scene, cam);
  assert.equal(scale, 1); // 800×400 экран под 800×400 зону — 1:1, без зоны было бы 0.4
});

test("клэмп держит край вида на краю зоны", () => {
  const cam = createCamera(scene);
  zoomAt(cam, 400, 200, 2, 800, 400, scene); // приблизили вдвое — виден кусок 400×200
  cam.x = 0;
  cam.y = 5000;
  clampCamera(cam, 800, 400, scene);
  assert.deepEqual([cam.x, cam.y], [700, 500]); // левый/нижний край вида = край зоны
});

test("экран шире зоны — центр по оси, без зоны клэмпа нет", () => {
  const cam = createCamera(scene);
  cam.zoom = 0.5; // вид вдвое шире зоны
  cam.x = 100;
  clampCamera(cam, 800, 400, scene);
  assert.equal(cam.x, 900);

  const free = { width: 2000, height: 1000 };
  const c2 = createCamera(free);
  c2.x = -500;
  clampCamera(c2, 800, 400, free);
  assert.equal(c2.x, -500);
  resetCamera(c2, free);
  assert.deepEqual([c2.x, c2.y], [1000, 500]);
});
