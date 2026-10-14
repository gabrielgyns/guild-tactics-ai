import * as THREE from 'three';
import { getHero } from '../domain/heroes';
import type { Side } from '../domain/types';

// Voxel hero models are assembled from boxes. Every model faces +Z and stands on y = 0.

export const TEAM_COLOR: Record<Side, number> = { player: 0x4aa3ff, enemy: 0xe0524a };

const materialCache = new Map<string, THREE.MeshLambertMaterial>();
export function mat(color: number, emissive = 0): THREE.MeshLambertMaterial {
  const key = `${color}-${emissive}`;
  let m = materialCache.get(key);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color, emissive, emissiveIntensity: emissive ? 0.9 : 0 });
    materialCache.set(key, m);
  }
  return m;
}

const boxCache = new Map<string, THREE.BoxGeometry>();
function boxGeo(w: number, h: number, d: number) {
  const key = `${w}|${h}|${d}`;
  let g = boxCache.get(key);
  if (!g) {
    g = new THREE.BoxGeometry(w, h, d);
    boxCache.set(key, g);
  }
  return g;
}

/** Adds a box whose min corner sits at (x - w/2, y, z - d/2). */
function box(parent: THREE.Object3D, w: number, h: number, d: number, x: number, y: number, z: number, color: number, emissive = 0) {
  const m = new THREE.Mesh(boxGeo(w, h, d), mat(color, emissive));
  m.position.set(x, y + h / 2, z);
  m.castShadow = true;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

export interface HeroModel {
  root: THREE.Group; // positioned on the tile
  body: THREE.Group; // animated (hop, lunge, flash)
  ring: THREE.Mesh;
  meshes: THREE.Mesh[];
}

export function buildHeroModel(heroId: string, side: Side): HeroModel {
  const hero = getHero(heroId);
  const p = hero.palette;
  const team = TEAM_COLOR[side];
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  // Team base
  const ring = new THREE.Mesh(boxGeo(0.78, 0.04, 0.78), new THREE.MeshLambertMaterial({ color: team, transparent: true, opacity: 0.85 }));
  ring.position.y = 0.02;
  ring.receiveShadow = true;
  root.add(ring);

  const dark = 0x2a2522;
  // Legs & boots
  box(body, 0.12, 0.18, 0.14, -0.08, 0.04, 0, p.secondary);
  box(body, 0.12, 0.18, 0.14, 0.08, 0.04, 0, p.secondary);
  box(body, 0.13, 0.06, 0.16, -0.08, 0.04, 0.01, dark);
  box(body, 0.13, 0.06, 0.16, 0.08, 0.04, 0.01, dark);
  // Torso
  box(body, 0.34, 0.28, 0.22, 0, 0.22, 0, p.primary);
  box(body, 0.35, 0.05, 0.23, 0, 0.24, 0, p.secondary); // belt
  // Cape in team colour
  box(body, 0.32, 0.36, 0.04, 0, 0.12, -0.13, team);
  // Arms
  box(body, 0.1, 0.24, 0.12, -0.22, 0.24, 0, p.primary);
  box(body, 0.1, 0.24, 0.12, 0.22, 0.24, 0, p.primary);
  box(body, 0.1, 0.06, 0.12, -0.22, 0.2, 0, p.skin);
  box(body, 0.1, 0.06, 0.12, 0.22, 0.2, 0, p.skin);
  // Head
  box(body, 0.28, 0.26, 0.26, 0, 0.5, 0, p.skin);
  box(body, 0.05, 0.05, 0.02, -0.07, 0.6, 0.13, dark); // eyes
  box(body, 0.05, 0.05, 0.02, 0.07, 0.6, 0.13, dark);

  switch (heroId) {
    case 'brann':
      box(body, 0.32, 0.12, 0.3, 0, 0.7, 0, p.primary); // helmet
      box(body, 0.06, 0.1, 0.3, 0, 0.82, 0, p.accent); // crest
      box(body, 0.3, 0.06, 0.04, 0, 0.53, 0.13, p.hair); // beard
      box(body, 0.06, 0.4, 0.36, -0.31, 0.12, 0.04, p.secondary); // shield
      box(body, 0.04, 0.12, 0.12, -0.35, 0.26, 0.04, p.accent); // boss
      box(body, 0.05, 0.42, 0.05, 0.3, 0.22, 0.12, 0xcfd6de); // sword
      box(body, 0.14, 0.04, 0.05, 0.3, 0.24, 0.12, p.accent);
      break;
    case 'kael':
      box(body, 0.3, 0.1, 0.28, 0, 0.72, -0.01, p.hair);
      box(body, 0.3, 0.06, 0.28, 0, 0.66, 0, p.primary); // bandana
      box(body, 0.06, 0.14, 0.04, 0.05, 0.6, -0.16, p.primary);
      box(body, 0.06, 0.58, 0.06, 0.3, 0.2, 0.14, 0xe6e0d0); // greatsword
      box(body, 0.18, 0.05, 0.06, 0.3, 0.24, 0.14, p.accent);
      box(body, 0.05, 0.3, 0.05, -0.29, 0.14, 0.1, 0xcfd6de); // off-hand blade
      break;
    case 'lyra':
      box(body, 0.32, 0.18, 0.3, 0, 0.62, -0.02, p.primary); // hood
      box(body, 0.2, 0.2, 0.06, 0, 0.42, -0.17, p.hair); // braid
      box(body, 0.05, 0.08, 0.05, -0.32, 0.56, 0.06, p.secondary); // bow
      box(body, 0.05, 0.08, 0.05, -0.32, 0.48, 0.1, p.secondary);
      box(body, 0.05, 0.16, 0.05, -0.32, 0.32, 0.12, p.secondary);
      box(body, 0.05, 0.08, 0.05, -0.32, 0.24, 0.1, p.secondary);
      box(body, 0.05, 0.08, 0.05, -0.32, 0.16, 0.06, p.secondary);
      box(body, 0.1, 0.32, 0.1, 0.12, 0.3, -0.16, p.secondary); // quiver
      box(body, 0.06, 0.08, 0.06, 0.12, 0.62, -0.16, p.accent);
      break;
    case 'tobin':
      box(body, 0.46, 0.04, 0.46, 0, 0.74, 0, p.primary); // wide hat
      box(body, 0.26, 0.12, 0.26, 0, 0.78, 0, p.primary);
      box(body, 0.28, 0.06, 0.04, 0, 0.53, 0.13, p.hair);
      box(body, 0.32, 0.06, 0.08, 0.24, 0.3, 0.2, p.secondary); // crossbow
      box(body, 0.06, 0.06, 0.3, 0.24, 0.3, 0.14, p.secondary);
      box(body, 0.24, 0.12, 0.08, -0.08, 0.3, -0.16, p.accent); // pouch/net
      break;
    case 'seren':
      box(body, 0.36, 0.06, 0.36, 0, 0.74, 0, p.secondary); // pointed hat
      box(body, 0.26, 0.12, 0.26, 0, 0.8, 0, p.secondary);
      box(body, 0.16, 0.12, 0.16, 0.02, 0.92, -0.02, p.secondary);
      box(body, 0.08, 0.1, 0.08, 0.05, 1.04, -0.05, p.secondary);
      box(body, 0.3, 0.16, 0.1, 0, 0.5, -0.12, p.hair);
      box(body, 0.05, 0.7, 0.05, 0.3, 0.04, 0.12, 0x6b5232); // staff
      box(body, 0.12, 0.12, 0.12, 0.3, 0.74, 0.12, p.accent, p.accent); // flame orb
      break;
    case 'vex':
      box(body, 0.32, 0.2, 0.3, 0, 0.62, -0.02, p.secondary); // hood
      box(body, 0.06, 0.08, 0.04, -0.08, 0.55, 0.14, p.hair);
      box(body, 0.05, 0.64, 0.05, -0.3, 0.04, 0.12, 0x9fb3c8); // staff
      box(body, 0.08, 0.16, 0.08, -0.3, 0.68, 0.12, p.accent, 0x5fb8ff); // crystal
      box(body, 0.05, 0.1, 0.05, -0.36, 0.7, 0.12, p.accent, 0x5fb8ff);
      box(body, 0.05, 0.1, 0.05, -0.24, 0.66, 0.12, p.accent, 0x5fb8ff);
      break;
    case 'mira':
      box(body, 0.32, 0.14, 0.3, 0, 0.68, -0.02, p.hair);
      box(body, 0.3, 0.3, 0.06, 0, 0.42, -0.15, p.hair);
      box(body, 0.36, 0.04, 0.04, 0, 0.88, 0, p.secondary, 0xd9a441); // halo
      box(body, 0.04, 0.04, 0.36, -0.16, 0.88, 0, p.secondary, 0xd9a441);
      box(body, 0.04, 0.04, 0.36, 0.16, 0.88, 0, p.secondary, 0xd9a441);
      box(body, 0.05, 0.62, 0.05, 0.3, 0.04, 0.12, p.secondary); // staff
      box(body, 0.16, 0.05, 0.05, 0.3, 0.6, 0.12, p.accent, 0x7fd6a0);
      box(body, 0.05, 0.16, 0.05, 0.3, 0.55, 0.12, p.accent, 0x7fd6a0);
      break;
    case 'orrin':
      box(body, 0.32, 0.1, 0.3, 0, 0.72, 0, p.primary); // cap
      box(body, 0.04, 0.24, 0.1, 0.12, 0.76, -0.08, p.accent); // feather
      box(body, 0.3, 0.1, 0.04, 0, 0.6, -0.12, p.hair);
      box(body, 0.24, 0.26, 0.08, 0, 0.18, 0.15, p.secondary); // lute body
      box(body, 0.06, 0.3, 0.05, 0.1, 0.36, 0.17, 0x6b5232); // neck
      break;
  }
  const meshes: THREE.Mesh[] = [];
  body.traverse((o) => {
    if (o instanceof THREE.Mesh) meshes.push(o);
  });
  return { root, body, ring, meshes };
}

/** Renders a small portrait of each hero to data URLs (for cards and the turn bar). */
export function renderPortraits(heroIds: string[], sides: Side[] = ['player', 'enemy']): Map<string, string> {
  const out = new Map<string, string>();
  const size = 160;
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  } catch {
    return out;
  }
  renderer.setSize(size, size);
  renderer.setPixelRatio(1);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xfff4e0, 0x404a5a, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(1.5, 3, 2.5);
  scene.add(sun);
  const cam = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0.1, 10);
  cam.position.set(0.9, 1.05, 1.9);
  cam.lookAt(0, 0.5, 0);
  for (const side of sides) {
    for (const id of heroIds) {
      const model = buildHeroModel(id, side);
      model.ring.visible = false;
      model.root.rotation.y = -0.35;
      model.root.position.y = 0.05;
      scene.add(model.root);
      cam.zoom = 0.95;
      cam.updateProjectionMatrix();
      renderer.render(scene, cam);
      out.set(`${id}:${side}`, renderer.domElement.toDataURL('image/png'));
      scene.remove(model.root);
    }
  }
  renderer.dispose();
  renderer.forceContextLoss();
  return out;
}
