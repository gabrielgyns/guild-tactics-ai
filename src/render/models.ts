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
  body: THREE.Group; // animated by actions (hop, lunge, flash)
  idle: THREE.Group; // breathing / sway, inside body
  ring: THREE.Mesh;
  meshes: THREE.Mesh[];
}

export type SkinId = 'classic' | 'veteran' | 'legend';

function shade(color: number, f: number): number {
  const c = new THREE.Color(color);
  c.multiplyScalar(f);
  return c.getHex();
}

function mix(a: number, b: number, t: number): number {
  return new THREE.Color(a).lerp(new THREE.Color(b), t).getHex();
}

/** Cosmetic palettes unlocked through mastery. They never change stats. */
function skinPalette(p: ReturnType<typeof getHero>['palette'], skin: SkinId) {
  if (skin === 'veteran') return { ...p, primary: shade(p.primary, 0.62), secondary: 0x2a2522, accent: 0xd9a441 };
  if (skin === 'legend') return { ...p, primary: mix(p.primary, 0xf2e6c8, 0.55), secondary: 0xb88a2e, accent: 0xffd166 };
  return p;
}

export function buildHeroModel(heroId: string, side: Side, skin: SkinId = 'classic'): HeroModel {
  const hero = getHero(heroId);
  const p = skinPalette(hero.palette, skin);
  const team = TEAM_COLOR[side];
  const root = new THREE.Group();
  const act = new THREE.Group();
  const body = new THREE.Group(); // every voxel goes here; `act` moves it for actions
  root.add(act);
  act.add(body);

  // Team base: a bevelled plate with a brighter rim.
  const ring = new THREE.Mesh(boxGeo(0.8, 0.04, 0.8), new THREE.MeshLambertMaterial({ color: shade(team, 0.75), transparent: true, opacity: 0.9 }));
  ring.position.y = 0.02;
  ring.receiveShadow = true;
  root.add(ring);
  const rim = new THREE.Mesh(boxGeo(0.66, 0.05, 0.66), new THREE.MeshLambertMaterial({ color: team, emissive: team, emissiveIntensity: 0.25 }));
  rim.position.y = 0.0;
  ring.add(rim);

  const dark = 0x2a2522;
  const skinShade = shade(p.skin, 0.82);
  // Legs, knees and boots with soles and toe caps
  for (const x of [-0.08, 0.08]) {
    box(body, 0.12, 0.16, 0.14, x, 0.06, 0, shade(p.secondary, 0.9));
    box(body, 0.13, 0.03, 0.15, x, 0.13, 0.002, shade(p.secondary, 0.7)); // knee band
    box(body, 0.13, 0.07, 0.16, x, 0.02, 0.01, dark); // boot
    box(body, 0.13, 0.02, 0.17, x, 0.0, 0.015, 0x15110f); // sole
    box(body, 0.12, 0.03, 0.03, x, 0.05, 0.085, shade(dark, 1.6)); // toe cap
  }
  // Torso: tunic with a lighter front panel, collar, belt and buckle
  box(body, 0.34, 0.28, 0.22, 0, 0.22, 0, p.primary);
  box(body, 0.16, 0.24, 0.01, 0, 0.24, 0.111, shade(p.primary, 1.15));
  box(body, 0.22, 0.04, 0.2, 0, 0.47, 0, shade(p.primary, 0.8)); // collar
  box(body, 0.35, 0.05, 0.23, 0, 0.24, 0, p.secondary); // belt
  box(body, 0.06, 0.05, 0.01, 0, 0.24, 0.117, p.accent, shade(p.accent, 0.25)); // buckle
  // Cape in team colour: two panels and a darker hem
  box(body, 0.32, 0.22, 0.04, 0, 0.26, -0.13, team);
  box(body, 0.3, 0.16, 0.04, 0, 0.1, -0.15, shade(team, 0.92));
  box(body, 0.3, 0.03, 0.045, 0, 0.08, -0.15, shade(team, 0.6));
  // Shoulders, sleeves and hands
  for (const sx of [-1, 1]) {
    box(body, 0.13, 0.07, 0.15, sx * 0.22, 0.44, 0, p.secondary); // pauldron
    box(body, 0.1, 0.13, 0.12, sx * 0.22, 0.32, 0, p.primary); // upper arm
    box(body, 0.105, 0.08, 0.125, sx * 0.22, 0.25, 0, shade(p.primary, 0.85)); // sleeve
    box(body, 0.1, 0.06, 0.12, sx * 0.22, 0.2, 0, p.skin); // hand
  }
  // Head: face, ears, eyes with highlights, brows, nose and mouth
  box(body, 0.28, 0.26, 0.26, 0, 0.5, 0, p.skin);
  box(body, 0.03, 0.07, 0.06, -0.15, 0.58, 0, skinShade); // ears
  box(body, 0.03, 0.07, 0.06, 0.15, 0.58, 0, skinShade);
  for (const ex of [-0.07, 0.07]) {
    box(body, 0.06, 0.06, 0.02, ex, 0.59, 0.128, 0xf4efe6); // eye white
    box(body, 0.035, 0.05, 0.02, ex + (ex < 0 ? 0.01 : -0.01), 0.59, 0.136, 0x1d1a24); // pupil
    box(body, 0.015, 0.015, 0.01, ex + (ex < 0 ? 0.018 : -0.002), 0.625, 0.147, 0xffffff); // glint
    box(body, 0.07, 0.015, 0.02, ex, 0.66, 0.13, shade(p.hair, 0.8)); // brow
  }
  box(body, 0.04, 0.04, 0.03, 0, 0.55, 0.14, skinShade); // nose
  box(body, 0.07, 0.015, 0.01, 0, 0.525, 0.133, shade(p.skin, 0.55)); // mouth
  box(body, 0.29, 0.06, 0.27, 0, 0.7, 0, p.hair); // hair cap (hats and hoods cover it)

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
    case 'dagna':
      box(body, 0.32, 0.1, 0.3, 0, 0.72, 0, p.secondary); // circlet helm
      box(body, 0.12, 0.08, 0.04, 0, 0.74, 0.15, p.accent, 0xb08a20);
      box(body, 0.3, 0.2, 0.06, 0, 0.44, -0.16, p.hair); // long hair
      box(body, 0.05, 0.5, 0.05, 0.3, 0.12, 0.12, 0x8a6a2e); // hammer haft
      box(body, 0.22, 0.14, 0.16, 0.3, 0.58, 0.12, p.primary); // hammer head
      box(body, 0.08, 0.08, 0.17, 0.3, 0.61, 0.12, p.accent, 0xb08a20);
      box(body, 0.38, 0.08, 0.26, 0, 0.44, 0, p.primary); // pauldrons
      break;
    case 'nyx':
      box(body, 0.32, 0.2, 0.3, 0, 0.62, -0.02, p.primary); // hood
      box(body, 0.28, 0.08, 0.04, 0, 0.52, 0.13, p.secondary); // mask
      box(body, 0.04, 0.2, 0.04, -0.3, 0.22, 0.12, 0xcfd6de); // daggers
      box(body, 0.04, 0.2, 0.04, 0.3, 0.22, 0.12, 0xcfd6de);
      box(body, 0.36, 0.05, 0.05, 0, 0.32, 0.13, p.accent, 0x6a3ab0); // dagger belt
      break;
    case 'fenna':
      box(body, 0.34, 0.08, 0.32, 0, 0.72, 0, p.primary); // leaf crown
      box(body, 0.06, 0.14, 0.06, -0.12, 0.8, 0.06, p.accent, 0x3a7a20);
      box(body, 0.06, 0.14, 0.06, 0.12, 0.8, 0.06, p.accent, 0x3a7a20);
      box(body, 0.3, 0.26, 0.08, 0, 0.42, -0.15, p.hair);
      box(body, 0.06, 0.66, 0.06, -0.3, 0.04, 0.12, p.secondary); // gnarled staff
      box(body, 0.12, 0.1, 0.12, -0.3, 0.7, 0.12, p.accent, 0x3a7a20);
      break;
    case 'maris':
      box(body, 0.32, 0.12, 0.3, 0, 0.7, -0.01, p.hair);
      box(body, 0.3, 0.32, 0.06, 0, 0.36, -0.15, p.hair);
      box(body, 0.18, 0.06, 0.04, 0, 0.72, 0.15, p.accent, 0x2f8f9d); // shell tiara
      box(body, 0.14, 0.18, 0.14, 0.3, 0.24, 0.14, p.secondary); // conch
      box(body, 0.08, 0.08, 0.08, 0.3, 0.42, 0.14, p.accent, 0x2f8f9d);
      break;
    case 'torva':
      box(body, 0.3, 0.1, 0.28, 0, 0.72, -0.02, p.hair); // braided bun
      box(body, 0.12, 0.12, 0.12, 0, 0.8, -0.1, p.hair);
      box(body, 0.34, 0.26, 0.05, 0, 0.18, 0.115, 0x5b4636); // leather apron
      box(body, 0.05, 0.46, 0.05, 0.3, 0.08, 0.12, 0x5b4636); // forge hammer
      box(body, 0.24, 0.16, 0.16, 0.3, 0.52, 0.12, 0x4a4a52);
      box(body, 0.1, 0.1, 0.17, 0.3, 0.55, 0.12, p.accent, 0xff5a10); // glowing face of the hammer
      break;
    case 'elio':
      box(body, 0.3, 0.08, 0.28, 0, 0.72, 0, p.hair);
      box(body, 0.42, 0.03, 0.06, 0, 0.84, 0, p.accent, 0xb08a20); // sun crest
      box(body, 0.06, 0.16, 0.06, 0, 0.8, 0, p.accent, 0xb08a20);
      box(body, 0.05, 0.1, 0.05, -0.32, 0.56, 0.06, p.secondary); // longbow
      box(body, 0.05, 0.12, 0.05, -0.32, 0.46, 0.1, p.secondary);
      box(body, 0.05, 0.18, 0.05, -0.32, 0.3, 0.12, p.accent);
      box(body, 0.05, 0.12, 0.05, -0.32, 0.18, 0.1, p.secondary);
      box(body, 0.05, 0.1, 0.05, -0.32, 0.08, 0.06, p.secondary);
      box(body, 0.1, 0.3, 0.1, 0.12, 0.3, -0.16, p.secondary); // quiver
      break;
    case 'vesper':
      box(body, 0.34, 0.22, 0.32, 0, 0.62, -0.02, p.primary); // deep hood
      box(body, 0.24, 0.06, 0.04, 0, 0.66, 0.15, p.secondary);
      box(body, 0.36, 0.14, 0.3, 0, 0.04, 0, p.primary); // robe hem
      box(body, 0.14, 0.14, 0.14, -0.3, 0.42, 0.12, p.accent, 0x6a3ab0); // floating shadow orb
      box(body, 0.08, 0.08, 0.08, -0.36, 0.56, 0.08, p.hair, 0x4a1a90);
      break;
    case 'tilda':
      box(body, 0.34, 0.08, 0.32, 0, 0.72, 0, p.primary); // leaf shawl hood
      box(body, 0.3, 0.12, 0.06, 0, 0.62, -0.15, p.hair); // grey hair
      box(body, 0.36, 0.14, 0.26, 0, 0.36, 0, p.primary); // mossy shawl
      box(body, 0.06, 0.6, 0.06, 0.3, 0.04, 0.12, 0x6b4a2b); // walking staff
      box(body, 0.14, 0.12, 0.14, 0.3, 0.64, 0.12, 0x3f7a3a); // leafy top
      box(body, 0.06, 0.06, 0.06, 0.3, 0.76, 0.12, p.accent, 0x3a7a20);
      break;
    case 'orrin':
      box(body, 0.32, 0.1, 0.3, 0, 0.72, 0, p.primary); // cap
      box(body, 0.04, 0.24, 0.1, 0.12, 0.76, -0.08, p.accent); // feather
      box(body, 0.3, 0.1, 0.04, 0, 0.6, -0.12, p.hair);
      box(body, 0.24, 0.26, 0.08, 0, 0.18, 0.15, p.secondary); // lute body
      box(body, 0.06, 0.3, 0.05, 0.1, 0.36, 0.17, 0x6b5232); // neck
      break;
  }
  if (skin === 'legend') {
    // Floating golden rune above the head.
    box(body, 0.1, 0.1, 0.1, 0, 1.02, 0, 0xffd166, 0xc08a10).rotation.set(0.6, 0.6, 0);
  }
  if (skin === 'veteran') box(body, 0.36, 0.04, 0.24, 0, 0.47, 0, 0xd9a441, 0x6a4a10); // gilded collar

  const meshes: THREE.Mesh[] = [];
  act.traverse((o) => {
    if (o instanceof THREE.Mesh) meshes.push(o);
  });
  return { root, body: act, idle: body, ring, meshes };
}

let portraitRig: { renderer: THREE.WebGLRenderer; scene: THREE.Scene; cam: THREE.OrthographicCamera } | null = null;

function rig() {
  if (portraitRig) return portraitRig;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setSize(160, 160);
  renderer.setPixelRatio(1);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xfff4e0, 0x404a5a, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(1.5, 3, 2.5);
  scene.add(sun);
  const cam = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0.1, 10);
  cam.position.set(0.9, 1.05, 1.9);
  cam.lookAt(0, 0.5, 0);
  cam.zoom = 0.95;
  cam.updateProjectionMatrix();
  portraitRig = { renderer, scene, cam };
  return portraitRig;
}

/** Renders one hero portrait to a data URL (shared offscreen renderer). */
export function renderPortrait(heroId: string, side: Side, skin: SkinId = 'classic'): string {
  try {
    const { renderer, scene, cam } = rig();
    const model = buildHeroModel(heroId, side, skin);
    model.ring.visible = false;
    model.root.rotation.y = -0.35;
    model.root.position.y = 0.05;
    scene.add(model.root);
    renderer.render(scene, cam);
    const url = renderer.domElement.toDataURL('image/png');
    scene.remove(model.root);
    return url;
  } catch {
    return '';
  }
}

/** Renders the default portraits of every hero for both sides. */
export function renderPortraits(heroIds: string[], sides: Side[] = ['player', 'enemy']): Map<string, string> {
  const out = new Map<string, string>();
  for (const side of sides) for (const id of heroIds) out.set(`${id}:${side}:classic`, renderPortrait(id, side));
  return out;
}

/** A small voxel diorama of the guild keep with a few heroes at the gate, for the hub. */
export interface HallOptions {
  /** Building levels (fortress); missing = not built. */
  levels?: Partial<Record<'keep' | 'mine' | 'barracks' | 'infirmary' | 'forge' | 'maproom', number>>;
  banner?: number;
  width?: number;
  height?: number;
}

export function renderGuildHall(heroIds: string[], skins: (id: string) => SkinId, opts: HallOptions = {}): string {
  const lv = opts.levels ?? {};
  const banner = opts.banner ?? 0x4aa3ff;
  const W = opts.width ?? 560;
  const H = opts.height ?? 300;
  try {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setSize(W, H);
    renderer.setPixelRatio(1);
    renderer.shadowMap.enabled = true;
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xfff1d6, 0x3a4660, 1.8));
    const sun = new THREE.DirectionalLight(0xfff0d0, 2.2);
    sun.position.set(-3, 6, 4);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    scene.add(sun);
    const g = new THREE.Group();
    scene.add(g);
    const add = (w: number, h: number, d: number, x: number, y: number, z: number, color: number, emissive = 0) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color, emissive));
      m.position.set(x, y + h / 2, z);
      m.castShadow = true;
      m.receiveShadow = true;
      g.add(m);
      return m;
    };
    // Island and courtyard
    add(6.4, 0.5, 4.4, 0, -0.5, 0, 0x6e5338);
    add(6.4, 0.12, 4.4, 0, -0.06, 0, 0x74ad52);
    add(2.2, 0.06, 1.6, 0, 0.0, 1.2, 0xbdb497);
    // Keep
    add(3.2, 1.6, 1.6, 0, 0, -0.8, 0x8d8f96);
    add(3.4, 0.2, 1.8, 0, 1.6, -0.8, 0x7a7c84);
    for (let i = -1.5; i <= 1.5; i += 0.5) add(0.25, 0.25, 0.25, i, 1.8, 0.05, 0x9a9ca3);
    add(0.9, 1.0, 0.1, 0, 0, 0.02, 0x4a3420); // gate
    add(0.9, 0.12, 0.12, 0, 1.0, 0.04, 0x6b5232);
    // Towers
    for (const x of [-1.9, 1.9]) {
      add(1.0, 2.4, 1.0, x, 0, -0.7, 0x9a9ca3);
      add(1.2, 0.5, 1.2, x, 2.4, -0.7, 0x5a3e6e);
      add(0.6, 0.4, 0.6, x, 2.9, -0.7, 0x5a3e6e);
      add(0.05, 0.7, 0.05, x, 3.3, -0.7, 0x6b5232);
      add(0.4, 0.26, 0.04, x + 0.22, 3.68, -0.7, banner); // banner
    }
    // Hanging banners on the keep
    for (const x of [-0.9, 0.9]) add(0.4, 0.8, 0.04, x, 0.6, 0.02, banner).position.z = 0.03;
    if ((lv.keep ?? 1) >= 2) {
      add(0.9, 1.2, 0.9, 0, 1.8, -0.9, 0x8d8f96); // central tower
      add(1.05, 0.4, 1.05, 0, 3.0, -0.9, 0x5a3e6e);
    }
    if ((lv.keep ?? 1) >= 3) {
      add(0.08, 0.9, 0.08, 0, 3.4, -0.9, 0xd9a441, 0x6a4a10);
      add(0.5, 0.32, 0.04, 0.27, 3.95, -0.9, banner);
    }
    // Fortress buildings
    if (lv.mine) {
      add(0.8, 0.5, 0.7, -2.55, 0, 0.35, 0x7a7c84);
      add(0.5, 0.35, 0.5, -2.2, 0, 0.0, 0x8d8f96);
      add(0.36, 0.18, 0.26, -2.15, 0, 0.75, 0x6b4a2b); // cart
      for (let i = 0; i < lv.mine; i++) add(0.12, 0.1, 0.12, -2.25 + i * 0.12, 0.18, 0.75, 0xffd166, 0xb08a20);
    }
    if (lv.barracks) {
      add(1.0, 0.6, 0.8, 2.55, 0, 0.35, 0x8a6a46);
      add(1.1, 0.25, 0.9, 2.55, 0.6, 0.35, 0xa33b3b);
      add(0.25, 0.4, 0.04, 2.55, 0, 0.77, 0x4a3420);
      if (lv.barracks >= 2) {
        add(0.06, 0.5, 0.06, 2.0, 0, 0.95, 0x6b4a2b); // training dummy
        add(0.3, 0.06, 0.06, 2.0, 0.35, 0.95, 0x6b4a2b);
        add(0.16, 0.16, 0.16, 2.0, 0.5, 0.95, 0xd8c8a0);
      }
    }
    if (lv.infirmary) {
      add(0.9, 0.5, 0.7, -2.6, 0, -1.55, 0xe8e4da);
      add(0.95, 0.12, 0.75, -2.6, 0.5, -1.55, 0xd0cbbf);
      add(0.3, 0.1, 0.04, -2.6, 0.22, -1.18, 0x3fa35a, 0x1a5a2a);
      add(0.1, 0.3, 0.04, -2.6, 0.12, -1.18, 0x3fa35a, 0x1a5a2a);
    }
    if (lv.forge) {
      add(0.9, 0.45, 0.7, 2.6, 0, -1.55, 0x5b4636);
      add(0.25, 1.0, 0.25, 2.85, 0.45, -1.7, 0x6a6c74); // chimney
      add(0.2, 0.12, 0.2, 2.85, 1.45, -1.7, 0xff8a3d, 0xff5a10);
      add(0.3, 0.16, 0.18, 2.45, 0.45, -1.35, 0x2a2522); // anvil
    }
    if (lv.maproom) {
      add(0.6, 2.2, 0.6, -1.1, 0, -1.85, 0xa8a49a);
      add(0.75, 0.4, 0.75, -1.1, 2.2, -1.85, 0x2f6fb0);
    }
    add(0.18, 0.18, 0.05, -0.9, 1.0, 0.06, 0xd9a441, 0x6a4a10);
    add(0.18, 0.18, 0.05, 0.9, 1.0, 0.06, 0xd9a441, 0x6a4a10);
    // Trees fill the corners that have no building yet
    const trees: [number, number][] = [];
    if (!lv.mine) trees.push([-2.7, 1.3]);
    if (!lv.barracks) trees.push([2.7, 1.3]);
    if (!lv.forge) trees.push([2.5, -1.8]);
    if (!lv.infirmary) trees.push([-2.6, -1.7]);
    for (const [x, z] of trees) {
      add(0.12, 0.3, 0.12, x, 0, z, 0x6b4a2b);
      add(0.5, 0.4, 0.5, x, 0.3, z, 0x2f6b34);
      add(0.3, 0.25, 0.3, x, 0.7, z, 0x3d8442);
    }
    // Heroes at the gate
    heroIds.slice(0, 4).forEach((id, i) => {
      const model = buildHeroModel(id, 'player', skins(id));
      model.ring.visible = false;
      model.root.scale.setScalar(0.8);
      model.root.position.set(-1.35 + i * 0.9, 0.06, 1.35 + (i % 2) * 0.25);
      model.root.rotation.y = 0.15 - i * 0.1;
      g.add(model.root);
    });
    // Fit the island horizontally and keep room above for the tallest towers.
    const halfH = 2.9;
    const halfW = halfH * (W / H);
    const cam = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.1, 50);
    cam.position.set(4.5, 4.6, 7.5);
    cam.lookAt(0, 1.25, 0);
    renderer.render(scene, cam);
    const url = renderer.domElement.toDataURL('image/png');
    renderer.dispose();
    renderer.forceContextLoss();
    return url;
  } catch {
    return '';
  }
}
